/**
 * Pollar wallet adapter — custodial social-login sessions for the pool app.
 *
 * Identity/login is REAL: `@pollar/core` authenticates the user (Google OAuth /
 * email OTP) and creates/recovers a custodial Stellar wallet (G-address, key in
 * AWS KMS, server-side signing).
 *
 * Signing and key derivation are BRIDGE MODE (declared mock):
 *  - Pollar exposes no `signMessage`, so the privacy keys cannot be derived
 *    from a wallet signature. Instead a 32-byte root entropy is generated in
 *    the browser (`crypto.getRandomValues`) and fed into the SAME derivation
 *    pipeline the app uses for Freighter signatures (expanded to the 64 bytes
 *    the WASM expects via SHA-512 with a domain tag). Trade-off: keys are NOT
 *    re-derivable from the wallet — they live only in this browser profile
 *    (OPFS SQLite + the entropy backup in localStorage).
 *  - The installed @pollar/core DOES expose custodial `signTx`/`signAuthEntry`,
 *    but custodial auth-entry signing is gated server-side by a per-app
 *    contract/function allowlist that does not include the pool contracts, and
 *    `/tx/sign` acceptance of externally-built Soroban XDR is policy-gated.
 *    Until the pool contract is allowlisted for this app, pool transactions are
 *    signed by a local "bridge" keypair generated in the browser, funded via
 *    friendbot, with trustlines to the classic pool assets. The Pollar
 *    G-address is identity only; it holds no pool funds.
 */

// BRIDGE MODE: mock until Pollar exposes signAuthEntry/signMessage for the pool
// contracts — the bridge keypair below does the actual signing.
import { PollarClient } from '@pollar/core';
import {
    Asset,
    BASE_FEE,
    Horizon,
    Keypair,
    Networks,
    Operation,
    TransactionBuilder,
    hash,
} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

const POLLAR_API_KEY = 'pub_testnet_36d86bbde89bf91c62c820d63e445068';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const WHITELIST_SERVER = 'http://localhost:4000';
const ENTROPY_DOMAIN_TAG = 'pollar-privacy-pool/root-entropy/v1';

const LS_BRIDGE_SECRET = (pollarAddress) => `pollarBridge:secret:${pollarAddress}`;
const LS_ROOT_ENTROPY = (pollarAddress) => `pollarBridge:entropy:${pollarAddress}`;
const LS_WHITELIST_ID = (notePublicKey) => `pollarWhitelist:id:${notePublicKey}`;

let client = null;
let bridgeKeypair = null; // BRIDGE MODE signing key (per Pollar G-address)
// True when connect-time probing confirmed Pollar's backend custodially signs
// pool transactions (auth entries + envelope) with the user's KMS key. When
// set, the bridge keypair is not used: the Pollar wallet IS the signer.
let custodialMode = false;

export function setCustodialMode(enabled) {
    custodialMode = !!enabled;
}

export function isCustodialMode() {
    return custodialMode;
}
// True only when the user completed a REAL login flow in this page load (as
// opposed to a session restored from storage). Lets the connect flow require
// an explicit login for stored sessions without ever logging out a login the
// user just performed (e.g. retried inside the modal after a cancel).
let freshLogin = false;

export function getPollarClient() {
    if (!client) {
        client = new PollarClient({
            apiKey: POLLAR_API_KEY,
            stellarNetwork: 'testnet',
        });
        // Social login ONLY. The SDK unconditionally registers its built-in
        // Freighter/Albedo adapters and the login modal renders them, but an
        // external-wallet session is useless here (no custodial signing, and
        // native Freighter already has its own first-class path in this app).
        // There is no config switch for this, so blank the list the modal
        // reads.
        client.listWalletAdapters = () => [];
    }
    return client;
}

/** Current Pollar session info, or null. */
export function getPollarSession() {
    const state = getPollarClient().getAuthState();
    if (state?.step !== 'authenticated') return null;
    const session = state.session;
    const profile = getPollarClient().getUserProfile?.() || null;
    return {
        pollarAddress: session?.wallet?.address || null,
        email: profile?.mail || profile?.providers?.email?.address || null,
        userId: session?.userId || null,
        // 'internal' = platform-custodied (social login). 'external' would be
        // a Freighter/Albedo session created through Pollar — not supported
        // by this app's Pollar path.
        custody: session?.wallet?.type || null,
    };
}

/**
 * Wait until AuthState reaches 'authenticated' (or 'error'/cancel/timeout).
 * The callback fires immediately with the current state, so an
 * already-authenticated session resolves synchronously. A transition back to
 * 'idle' AFTER the flow made progress means the user closed/cancelled the
 * login modal — rejected with code USER_REJECTED.
 */
export function waitForPollarAuthenticated({ timeoutMs = 300_000, onState } = {}) {
    const pollar = getPollarClient();
    return new Promise((resolve, reject) => {
        let done = false;
        let sawProgress = false;
        const finish = (fn, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            unsubscribe();
            fn(value);
        };
        const timer = setTimeout(
            () => finish(reject, new Error('Pollar login timed out')),
            timeoutMs,
        );
        const unsubscribe = pollar.onAuthStateChange((state) => {
            onState?.(state);
            if (done) return;
            if (state.step === 'authenticated') {
                if (sawProgress) freshLogin = true;
                finish(resolve, state.session);
            } else if (state.step === 'error') {
                const err = new Error(state.message || 'Pollar login failed');
                err.code = state.errorCode || 'POLLAR_ERROR';
                finish(reject, err);
            } else if (state.step === 'idle') {
                if (sawProgress) {
                    const err = new Error('Login cancelled');
                    err.code = 'USER_REJECTED';
                    finish(reject, err);
                }
            } else {
                sawProgress = true;
            }
        });
    });
}

/** Restore a persisted Pollar session without prompting. */
export function restorePollarSession() {
    return getPollarSession();
}

/**
 * Wait for the client's initial session restore to settle, then return the
 * session (or null). The SDK restores persisted sessions ASYNCHRONOUSLY after
 * construction — checking `getPollarSession()` right away races that restore
 * and would pop the login modal for an already-logged-in user (and then let
 * the flow continue underneath it when the restore lands).
 */
export async function restorePollarSessionSettled() {
    const pollar = getPollarClient();
    try {
        await pollar.ready();
    } catch (e) {
        console.warn('[Pollar] client init/restore failed:', e);
    }
    return getPollarSession();
}

export async function pollarLogout() {
    bridgeKeypair = null;
    freshLogin = false;
    try {
        await getPollarClient().logout();
    } catch (e) {
        console.warn('[Pollar] logout failed:', e);
    }
}

/**
 * Whether the current session comes from a real login completed in THIS page
 * load (true) or was restored from persisted storage (false).
 */
export function isPollarSessionFresh() {
    return freshLogin;
}

/** Current AuthState step ('idle' when none). */
export function getPollarAuthStep() {
    try {
        return getPollarClient().getAuthState()?.step || 'idle';
    } catch {
        return 'idle';
    }
}

// ---------------------------------------------------------------------------
// BRIDGE MODE: local signing keypair
// ---------------------------------------------------------------------------

/**
 * BRIDGE MODE: load or create the local Stellar keypair that signs pool
 * transactions for this Pollar identity, and make sure its account exists
 * on testnet (friendbot). The secret persists in localStorage keyed by the
 * Pollar G-address so future sessions restore the same account (and thereby
 * the same privacy keys in the OPFS DB).
 */
export async function ensureBridgeAccount() {
    const session = getPollarSession();
    if (!session?.pollarAddress) throw new Error('No Pollar session');

    if (!bridgeKeypair) {
        const stored = localStorage.getItem(LS_BRIDGE_SECRET(session.pollarAddress));
        bridgeKeypair = stored ? Keypair.fromSecret(stored) : Keypair.random();
        localStorage.setItem(LS_BRIDGE_SECRET(session.pollarAddress), bridgeKeypair.secret());
    }
    const address = bridgeKeypair.publicKey();

    const horizon = new Horizon.Server(HORIZON_URL);
    try {
        await horizon.loadAccount(address);
    } catch {
        // Account not found → fund it via friendbot (testnet only).
        const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`);
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Friendbot funding failed (${res.status}): ${body.slice(0, 120)}`);
        }
    }
    return { address, pollarAddress: session.pollarAddress, email: session.email };
}

export function getBridgeAddress() {
    return bridgeKeypair ? bridgeKeypair.publicKey() : null;
}

/**
 * BRIDGE MODE: ensure the bridge account has a trustline for every enabled
 * classic-asset pool (e.g. USDC). No-op for pools it already trusts.
 * @param {Array} pools - entries from the embedded contract config.
 */
export async function ensureBridgeTrustlines(pools) {
    if (!bridgeKeypair) throw new Error('Bridge keypair not initialized');
    const classicAssets = (pools || [])
        .filter(p => p?.enabled && p?.asset?.kind === 'classic' && p.asset.code && p.asset.issuer)
        .map(p => new Asset(p.asset.code, p.asset.issuer));
    if (!classicAssets.length) return;

    const horizon = new Horizon.Server(HORIZON_URL);
    const account = await horizon.loadAccount(bridgeKeypair.publicKey());
    const missing = classicAssets.filter(asset =>
        !account.balances.some(b =>
            (b.asset_code === asset.getCode()) && (b.asset_issuer === asset.getIssuer())
        )
    );
    if (!missing.length) return;

    const builder = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
    });
    for (const asset of missing) {
        builder.addOperation(Operation.changeTrust({ asset }));
    }
    const tx = builder.setTimeout(60).build();
    tx.sign(bridgeKeypair);
    await horizon.submitTransaction(tx);
    console.log('[Pollar bridge] trustlines created:', missing.map(a => `${a.getCode()}:${a.getIssuer().slice(0, 6)}…`).join(', '));
}

/**
 * BRIDGE MODE: make sure the bridge signer holds enough of `asset` to cover
 * a deposit of `amountStroops`, topping it up from the user's Pollar wallet
 * with a REAL custodial payment (`runTx('payment')`, KMS-signed, fees
 * sponsored — Pollar's core operation, fully supported by the backend).
 * The user's funds live in their Pollar wallet; the bridge only holds them
 * for the seconds between the top-up and the pool deposit.
 */
export async function ensureBridgeFunds(asset, amountStroops) {
    if (!bridgeKeypair) throw new Error('Bridge keypair not initialized');
    const bridgeAddress = bridgeKeypair.publicKey();

    const horizon = new Horizon.Server(HORIZON_URL);
    const account = await horizon.loadAccount(bridgeAddress);
    const balanceEntry = account.balances.find(b =>
        asset.kind === 'native'
            ? b.asset_type === 'native'
            : b.asset_code === asset.code && b.asset_issuer === asset.issuer
    );
    const have = BigInt(Math.round(parseFloat(balanceEntry?.balance || '0') * 1e7));
    // Native needs headroom for reserves/fees; friendbot already covered it.
    if (asset.kind === 'native' || have >= amountStroops) return;

    const missing = amountStroops - have;
    const amountStr = (Number(missing) / 1e7).toFixed(7);
    console.log(`[Pollar bridge] topping up ${amountStr} ${asset.code} from the Pollar wallet (custodial payment)…`);
    const outcome = await getPollarClient().runTx('payment', {
        destination: bridgeAddress,
        amount: amountStr,
        asset: {
            type: asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
            code: asset.code,
            issuer: asset.issuer,
        },
    });
    if (outcome?.status !== 'success' && outcome?.status !== 'pending') {
        throw new Error(
            `Could not move ${asset.code} from your Pollar wallet: ${outcome?.message || outcome?.details || 'payment failed'}`
        );
    }
    console.log('[Pollar bridge] top-up tx:', outcome?.hash);
}

// ---------------------------------------------------------------------------
// BRIDGE MODE: signing (same contract as Freighter's signAuthEntry/signTransaction)
// ---------------------------------------------------------------------------

/**
 * BRIDGE MODE: mock until Pollar exposes signAuthEntry for the pool contract.
 * Signs a Soroban HashIdPreimage (base64 XDR) exactly like Freighter does:
 * ed25519 over SHA-256(preimage bytes); returns base64 signature bytes.
 */
export async function bridgeSignAuthEntry(preimageXdr) {
    if (!bridgeKeypair) throw new Error('Bridge keypair not initialized');
    const preimage = Buffer.from(preimageXdr, 'base64');
    const signature = bridgeKeypair.sign(hash(preimage));
    return signature.toString('base64');
}

/**
 * BRIDGE MODE: mock until Pollar accepts externally built Soroban XDR in
 * signTx. Signs the full transaction envelope with the bridge keypair.
 */
export async function bridgeSignTransaction(txXdr, networkPassphrase) {
    if (!bridgeKeypair) throw new Error('Bridge keypair not initialized');
    const tx = TransactionBuilder.fromXDR(txXdr, networkPassphrase || Networks.TESTNET);
    tx.sign(bridgeKeypair);
    return tx.toXDR();
}

// ---------------------------------------------------------------------------
// Key-derivation entropy (Pollar has no signMessage)
// ---------------------------------------------------------------------------

/**
 * Root entropy for privacy-key derivation, replacing the Freighter
 * `signMessage` signature. 32 random bytes are generated once per Pollar
 * identity and persisted (localStorage, keyed by the Pollar G-address);
 * they are expanded to the exact 64 bytes the WASM derivation pipeline
 * expects (`KeyDerivationSignature` must be 64 bytes) via
 * SHA-512(domain_tag || entropy32).
 *
 * Trade-off (documented in POLLAR_INTEGRATION.md): unlike a wallet
 * signature, this entropy is NOT re-derivable from the wallet. Clearing
 * browser storage loses the privacy keys. Roadmap fix: Pollar signMessage.
 */
export async function derivationEntropy() {
    const session = getPollarSession();
    if (!session?.pollarAddress) throw new Error('No Pollar session');
    const key = LS_ROOT_ENTROPY(session.pollarAddress);

    let entropyHex = localStorage.getItem(key);
    if (!entropyHex) {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        entropyHex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(key, entropyHex);
    }
    const entropy = Uint8Array.from(entropyHex.match(/.{2}/g).map(h => parseInt(h, 16)));

    const tag = new TextEncoder().encode(ENTROPY_DOMAIN_TAG);
    const input = new Uint8Array(tag.length + entropy.length);
    input.set(tag, 0);
    input.set(entropy, tag.length);
    const digest = await crypto.subtle.digest('SHA-512', input);
    return new Uint8Array(digest); // 64 bytes
}

// ---------------------------------------------------------------------------
// Automatic ASP whitelist request + status UI
// ---------------------------------------------------------------------------

let whitelistPollTimer = null;

/**
 * Called right after key derivation for Pollar users: registers the
 * notePublicKey/aspSecret with the local whitelist server (approve stays
 * manual) and starts the status banner.
 */
export async function requestWhitelistForPollarUser({ notePublicKey, aspSecret }) {
    const session = getPollarSession();
    const label = session?.email || session?.pollarAddress || 'pollar-user';

    let id = localStorage.getItem(LS_WHITELIST_ID(notePublicKey));
    if (!id) {
        try {
            const res = await fetch(`${WHITELIST_SERVER}/whitelist/request`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notePublicKey, aspSecret, label }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok && body.id) {
                id = body.id;
            } else if (res.status === 409) {
                // Already registered (e.g. storage cleared but server remembers):
                // recover the id from the list endpoint.
                const list = await fetch(`${WHITELIST_SERVER}/whitelist/list`).then(r => r.json()).catch(() => []);
                id = (Array.isArray(list) ? list : []).find(e => e.notePublicKey === notePublicKey)?.id || null;
            } else {
                throw new Error(body?.error || `whitelist request failed (${res.status})`);
            }
        } catch (e) {
            console.warn('[Pollar] whitelist request failed:', e);
            showWhitelistBanner('error', `Whitelist request failed: ${e.message}. Is the server on :4000 running?`);
            return null;
        }
        if (id) localStorage.setItem(LS_WHITELIST_ID(notePublicKey), id);
    }
    if (id) startWhitelistStatusPolling(id);
    return id;
}

/** Poll GET /whitelist/status/:id until approved; drive the banner. */
export function startWhitelistStatusPolling(id) {
    stopWhitelistStatusPolling();
    const poll = async () => {
        try {
            const res = await fetch(`${WHITELIST_SERVER}/whitelist/status/${encodeURIComponent(id)}`);
            if (!res.ok) throw new Error(`status ${res.status}`);
            const body = await res.json();
            if (body.status === 'approved') {
                showWhitelistBanner('approved', 'Aprobado, ya puedes depositar ✅');
                stopWhitelistStatusPolling();
                setTimeout(hideWhitelistBanner, 12_000);
                return;
            }
            showWhitelistBanner('pending', 'Verificación pendiente — esperando aprobación del ASP…');
        } catch (e) {
            showWhitelistBanner('error', `No se pudo consultar el estado de verificación (${e.message})`);
        }
    };
    poll();
    whitelistPollTimer = setInterval(poll, 4_000);
}

export function stopWhitelistStatusPolling() {
    if (whitelistPollTimer) {
        clearInterval(whitelistPollTimer);
        whitelistPollTimer = null;
    }
}

const BANNER_ID = 'pollar-whitelist-banner';

function showWhitelistBanner(state, text) {
    let el = document.getElementById(BANNER_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = BANNER_ID;
        el.style.cssText = [
            'position:fixed', 'bottom:16px', 'right:16px', 'z-index:9999',
            'max-width:340px', 'padding:12px 16px', 'border-radius:12px',
            'font:500 13px/1.4 system-ui,sans-serif', 'color:#e2e8f0',
            'background:#0f172a', 'border:1px solid #334155',
            'box-shadow:0 10px 30px rgba(0,0,0,0.45)',
        ].join(';');
        document.body.appendChild(el);
    }
    const colors = { pending: '#f59e0b', approved: '#34d399', error: '#f87171' };
    el.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${colors[state] || '#94a3b8'};margin-right:8px"></span>${text}`;
}

function hideWhitelistBanner() {
    document.getElementById(BANNER_ID)?.remove();
}
