# SUBMISSION.md — Stellar Hacks: Real-World ZK (DoraHacks)

Pre-submission checklist with verification results. Date: 2026-07-03.

## Repository hygiene

- [x] **`.gitignore` covers sensitive/build files** — verified with `git check-ignore`:
  - `server/.env` ✅ ignored (only `server/.env.example` is tracked, contains no secrets)
  - `server/whitelist.json` ✅ ignored (contains user `aspSecret`s)
  - `app/node_modules/`, `server/node_modules/` ✅ ignored
  - `/dist/` ✅ ignored
  - `git ls-files` confirms none of the above are tracked.
- [x] **Secret scan of git history** — scope and result:
  - This fork adds exactly one commit on top of the upstream base (`8556aab`, NethermindEth's public repo): commit **`5a3a7ea`** ("Pollar integration, ASP whitelist server, USDC pool").
  - Scanned the full diff of `5a3a7ea` for Stellar secret keys (`S` + 55 base32 chars), Pollar secret keys (`sec_testnet_`/`sec_mainnet_`), and PEM private keys: **0 matches**.
  - The only key present is the **publishable** Pollar API key (`pub_testnet_36d8…`), which is designed to be exposed in frontend code (per Pollar's docs) and is origin-restricted to `http://localhost:8000`.
  - The ASP admin secret lives in `~/.config/stellar/identity/` (stellar-cli identity), never in the repo. Working-tree scan matches only third-party test vectors inside `app/node_modules/` (gitignored).
  - Upstream history (thousands of commits) is NethermindEth's already-public repository and contains none of our credentials.
- [ ] TODO(user): **commit and push the current working tree** — there are uncommitted changes (README.md, SUBMISSION.md, app UI/theming, `wallet-pollar-custodial.js`, `deployments.json` with the new USDC pool). The public repo must include them before the deadline.

## ZK is load-bearing

Every pool state change goes through `transact`, which calls `verify_proof` → `CircomGroth16VerifierClient::verify` (`contracts/pool/src/pool.rs:409`); the verifier contract (`contracts/circom-groth16-verifier/src/lib.rs:84`) checks the Groth16 proof against the ceremony verification key embedded in its WASM, with the pool Merkle root, nullifiers, output commitments, and **ASP membership root** as public inputs. Deployed verifier: [`CCA5SMNQGZN5CWWSRJITSWLEFE6XXGHEQUXSGU6KUFBQ4NC4OKKWYT26`](https://stellar.expert/explorer/testnet/contract/CCA5SMNQGZN5CWWSRJITSWLEFE6XXGHEQUXSGU6KUFBQ4NC4OKKWYT26). Proof-carrying transaction verified on-chain: [`f5ec6549…224e3f`](https://stellar.expert/explorer/testnet/tx/f5ec65499848b4e3f7e5f5f255168f48270a5a50312a302cc5ddec1cec224e3f).

## DoraHacks form fields (ready to paste)

**Project name**

> Pollar Private Payments

**Description (1–2 lines)**

> Compliant private payments on Stellar: a Groth16 privacy pool with an on-chain compliance gate (ASP), behind Google-login custodial wallets — deposit, transfer and withdraw XLM/USDC privately with zero crypto UX.

**Tags**

> zk, zero-knowledge, groth16, circom, stellar, soroban, privacy, payments, compliance, privacy-pools, custodial-wallets, usdc

**Repository**

> https://github.com/aleregex/pollar-private-payments

**Demo video**

> TODO(user): paste video link (2–3 min)

## Demo video shot list (suggestion, not a requirement)

1. Google login through the Pollar modal (no extension, no seed phrase).
2. Automatic whitelist request → approve (`curl`, standing in for the KYC webhook) → UI flips to "approved".
3. Deposit 1 XLM or 1 USDC → show the tx on stellar.expert and point at the `transact` call verifying the Groth16 proof.
4. One line on what's hidden vs. visible on-chain.
