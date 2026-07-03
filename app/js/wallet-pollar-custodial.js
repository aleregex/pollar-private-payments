/**
 * REAL custodial signing for pool transactions via Pollar's KMS.
 *
 * The installed @pollar/core exposes `signTx` (POST /tx/sign with an
 * arbitrary unsigned XDR) and `signAuthEntry` (POST /tx/sign-auth-entry with
 * a SorobanAuthorizationEntry). Both are custodial for social-login wallets:
 * the backend decrypts the user's key in KMS, signs, and returns the result.
 * The backend gates auth-entry signing by a per-app contract/function
 * allowlist, so availability is PROBED at connect time (see
 * `probeCustodialSigning`): if the pool contract is allowed, the app signs
 * everything with the user's real Pollar wallet and the bridge keypair is
 * not used at all.
 *
 * Bridging the interface gap: the app's WASM hands the signer a
 * `HashIdPreimage` (the exact bytes the contract verifies) and expects raw
 * signature bytes back, while Pollar takes an unsigned
 * `SorobanAuthorizationEntry` and returns it signed. The preimage and the
 * entry carry the same fields (nonce, expiration, invocation), so we convert
 * preimage → entry, have Pollar sign it, and extract the signature bytes
 * from the returned entry's credentials.
 */

import { Address, StrKey, hash, xdr } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { getPollarClient, getPollarSession } from './wallet-pollar.js';

const SOROBAN_RPC = 'https://soroban-testnet.stellar.org';

async function latestLedger() {
    const res = await fetch(SOROBAN_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger' }),
    });
    const body = await res.json();
    const seq = body?.result?.sequence;
    if (!seq) throw new Error('Failed to fetch latest ledger');
    return seq;
}

/**
 * Build an unsigned SorobanAuthorizationEntry equivalent to the given
 * soroban-authorization HashIdPreimage (same nonce, expiration, invocation),
 * with address credentials for `signerAddress`.
 */
function entryFromPreimage(preimageXdrB64, signerAddress) {
    const preimage = xdr.HashIdPreimage.fromXDR(preimageXdrB64, 'base64');
    if (preimage.switch() !== xdr.EnvelopeType.envelopeTypeSorobanAuthorization()) {
        throw new Error(`Unexpected preimage type: ${preimage.switch().name}`);
    }
    const auth = preimage.sorobanAuthorization();
    const credentials = new xdr.SorobanAddressCredentials({
        address: new Address(signerAddress).toScAddress(),
        nonce: auth.nonce(),
        signatureExpirationLedger: auth.signatureExpirationLedger(),
        signature: xdr.ScVal.scvVoid(),
    });
    const entry = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(credentials),
        rootInvocation: auth.invocation(),
    });
    return {
        entryXdrB64: entry.toXDR('base64'),
        expirationLedger: auth.signatureExpirationLedger(),
        preimageHash: hash(preimage.toXDR()),
    };
}

/**
 * Extract the raw ed25519 signature bytes for `signerAddress` from a signed
 * SorobanAuthorizationEntry (credentials.address.signature is the standard
 * ScVal vec of {public_key, signature} maps).
 */
function signatureFromSignedEntry(signedEntryXdrB64, signerAddress) {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(signedEntryXdrB64, 'base64');
    const sigVal = entry.credentials().address().signature();
    const expectedKey = StrKey.decodeEd25519PublicKey(signerAddress);

    const candidates = sigVal.switch().name === 'scvVec' ? sigVal.vec() : [sigVal];
    for (const item of candidates) {
        if (item.switch().name !== 'scvMap') continue;
        let pub = null;
        let sig = null;
        for (const kv of item.map()) {
            const key = kv.key().sym ? kv.key().sym().toString() : String(kv.key().value());
            if (key === 'public_key') pub = Buffer.from(kv.val().bytes());
            if (key === 'signature') sig = Buffer.from(kv.val().bytes());
        }
        if (sig && (!pub || pub.equals(Buffer.from(expectedKey)))) {
            return sig;
        }
    }
    throw new Error('No signature for the expected key in the signed auth entry');
}

/**
 * Probe whether Pollar's backend will custodially sign auth entries for the
 * given pool contract (allowlist check). Signs a throwaway entry invoking
 * `transact` with no args — never submitted, so it has no on-chain effect.
 * Returns { available, details }.
 */
export async function probeCustodialSigning(poolContractId) {
    const session = getPollarSession();
    if (!session?.pollarAddress) return { available: false, details: 'no session' };
    try {
        const expiration = (await latestLedger()) + 100;
        const invocation = new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                new xdr.InvokeContractArgs({
                    contractAddress: new Address(poolContractId).toScAddress(),
                    functionName: 'transact',
                    args: [],
                }),
            ),
            subInvocations: [],
        });
        const entry = new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
                new xdr.SorobanAddressCredentials({
                    address: new Address(session.pollarAddress).toScAddress(),
                    nonce: xdr.Int64.fromString(String(Date.now())),
                    signatureExpirationLedger: expiration,
                    signature: xdr.ScVal.scvVoid(),
                }),
            ),
            rootInvocation: invocation,
        });
        const outcome = await getPollarClient().signAuthEntry(entry.toXDR('base64'), {
            validUntilLedger: expiration,
        });
        if (outcome?.status === 'signed') {
            console.log('[Pollar custodial] probe OK — pool contract is allowlisted for KMS signing');
            return { available: true };
        }
        console.warn('[Pollar custodial] probe rejected:', outcome?.details);
        return { available: false, details: outcome?.details || 'rejected' };
    } catch (e) {
        console.warn('[Pollar custodial] probe failed:', e);
        return { available: false, details: e?.message || String(e) };
    }
}

/**
 * Custodial replacement for the wallet bridge's signAuthEntry: takes the
 * HashIdPreimage XDR from the WASM, has Pollar's KMS sign the equivalent
 * auth entry, and returns the raw signature bytes (base64) the WASM expects.
 */
export async function custodialSignAuthEntry(preimageXdrB64) {
    const session = getPollarSession();
    if (!session?.pollarAddress) throw new Error('No Pollar session');
    const { entryXdrB64, expirationLedger } = entryFromPreimage(preimageXdrB64, session.pollarAddress);
    const outcome = await getPollarClient().signAuthEntry(entryXdrB64, {
        validUntilLedger: expirationLedger,
    });
    if (outcome?.status !== 'signed') {
        throw new Error(`Pollar signAuthEntry failed: ${outcome?.details || 'unknown error'}`);
    }
    const sig = signatureFromSignedEntry(outcome.signedAuthEntry, session.pollarAddress);
    return sig.toString('base64');
}

/**
 * Custodial replacement for the wallet bridge's signTransaction: Pollar's
 * KMS signs the full envelope (the tx source is the Pollar wallet).
 */
export async function custodialSignTransaction(txXdrB64) {
    const outcome = await getPollarClient().signTx(txXdrB64);
    if (outcome?.status !== 'signed') {
        throw new Error(`Pollar signTx failed: ${outcome?.details || outcome?.message || 'unknown error'}`);
    }
    return outcome.signedXdr;
}

/**
 * Ensure the Pollar wallet trusts every classic asset of the enabled pools,
 * creating missing trustlines through Pollar (sponsored or self-paid).
 */
export async function ensureCustodialTrustlines(pools) {
    const session = getPollarSession();
    if (!session?.pollarAddress) throw new Error('No Pollar session');
    const wanted = (pools || [])
        .filter(p => p?.enabled && p?.asset?.kind === 'classic' && p.asset.code && p.asset.issuer)
        .map(p => ({ code: p.asset.code, issuer: p.asset.issuer }));
    if (!wanted.length) return;

    const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${session.pollarAddress}`);
    const account = await res.json();
    const missing = wanted.filter(a =>
        !(account.balances || []).some(b => b.asset_code === a.code && b.asset_issuer === a.issuer)
    );
    for (const asset of missing) {
        const outcome = await getPollarClient().setTrustline({ code: asset.code, issuer: asset.issuer });
        if (outcome?.status !== 'success') {
            console.warn(`[Pollar custodial] setTrustline ${asset.code} failed:`, outcome?.details);
        } else {
            console.log(`[Pollar custodial] trustline ${asset.code}:${asset.issuer.slice(0, 6)}… created`);
        }
    }
}
