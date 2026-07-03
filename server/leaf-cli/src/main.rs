//! ASP membership leaf derivation CLI for the whitelist server.
//!
//! `leaf <note_pubkey_0xhex> <asp_secret_0xhex_be>` replicates the exact
//! pipeline behind `deriveAspUserLeaf` in `app/admin.html`:
//! the pubkey is parsed as raw 32-byte hex (`NotePublicKey::parse`), the
//! secret as a big-endian field element (`Field::from_0x_hex_be`, same as
//! `parse_field_bigint_numeric` in the web client), and
//! `leaf = Poseidon2(pubkey, secret, domain=1)` via
//! `prover::crypto::asp_membership_leaf` — the same function the admin page
//! calls through the storage worker.
//!
//! `test-user [network]` generates a synthetic onboarding result (random
//! 64-byte "wallet signature" → note keypair + ASP secret) printed in the
//! same formats the app shows to the user, for end-to-end testing without a
//! browser wallet.

use anyhow::{Context, Result, anyhow, bail};
use prover::{
    crypto::asp_membership_leaf,
    encryption::{derive_encryption_and_note_keypairs, derive_membership_blinding},
};
use stellar::{Indexer, StateFetcher};
use stellar_private_payments_sdk::{
    LocalProver, LocalSigner, LocalStorage, PrivatePool, PrivatePoolConfig, Storage,
    state::SqliteStorage, types::ProverArtifacts,
};
use types::{
    ContractConfig, Field, KeyDerivationSignature, NoteAmount, NotePublicKey, encode_0x_hex,
};

const TESTNET_PASSPHRASE: &str = "Test SDF Network ; September 2015";

const USAGE: &str = "usage: asp-leaf-cli leaf <note_pubkey_0xhex> <asp_secret_0xhex_be>\n       asp-leaf-cli test-user [network]\n       asp-leaf-cli check-membership <note_pubkey_0xhex> <asp_secret_0xhex_be> [deployments_json] [rpc_url] [db_path]\n       asp-leaf-cli e2e-seed <address_G> <db_path> [network]\n       asp-leaf-cli e2e-deposit <secret_S> <address_G> <db_path> <amount_stroops> [deployments_json] [rpc_url] [asset_code]";

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("leaf") => {
            let (Some(pubkey_hex), Some(secret_hex)) = (args.get(1), args.get(2)) else {
                bail!(USAGE);
            };
            let pubkey = NotePublicKey::parse(pubkey_hex).context("invalid note public key")?;
            let secret = Field::from_0x_hex_be(secret_hex).context("invalid ASP secret")?;
            let leaf = asp_membership_leaf(&pubkey, &secret)?;
            println!(
                "{{\"leafHex\":\"{}\",\"leafDec\":\"{}\"}}",
                leaf.to_0x_hex_be(),
                leaf.0
            );
            Ok(())
        }
        Some("test-user") => {
            let network = args.get(1).map_or("testnet", String::as_str);
            let mut sig = [0u8; 64];
            getrandom::getrandom(&mut sig).context("rng failure")?;
            let signature = KeyDerivationSignature(sig.to_vec());
            let blinding = derive_membership_blinding(&signature, network)?;
            let (note_keypair, _encryption_keypair) =
                derive_encryption_and_note_keypairs(signature)?;
            println!(
                "{{\"notePublicKey\":\"{}\",\"aspSecret\":\"{}\"}}",
                encode_0x_hex(&note_keypair.public.0),
                blinding.to_0x_hex_be()
            );
            Ok(())
        }
        Some("check-membership") => {
            let (Some(pubkey_hex), Some(secret_hex)) = (args.get(1), args.get(2)) else {
                bail!(USAGE);
            };
            let deployments_path = args
                .get(3)
                .map_or("deployments/testnet/deployments.json", String::as_str);
            let rpc_url = args
                .get(4)
                .map_or("https://soroban-testnet.stellar.org", String::as_str);
            let db_path = args.get(5).cloned();

            let pubkey = NotePublicKey::parse(pubkey_hex).context("invalid note public key")?;
            let secret = Field::from_0x_hex_be(secret_hex).context("invalid ASP secret")?;
            let leaf = asp_membership_leaf(&pubkey, &secret)?;

            let config: ContractConfig =
                serde_json::from_str(&std::fs::read_to_string(deployments_path)?)
                    .context("invalid deployments json")?;

            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            runtime.block_on(check_membership(&config, rpc_url, &leaf, db_path))
        }
        // Headless equivalent of the onboarding "Keys" step: derive privacy
        // keys from a synthetic wallet signature and persist them for
        // `address` in the SDK wallet DB, printing the two values the
        // whitelist server needs.
        Some("e2e-seed") => {
            let (Some(address), Some(db_path)) = (args.get(1), args.get(2)) else {
                bail!(USAGE);
            };
            let network = args.get(3).map_or("testnet", String::as_str);

            let mut sig = [0u8; 64];
            getrandom::getrandom(&mut sig).context("rng failure")?;
            let signature = KeyDerivationSignature(sig.to_vec());
            let blinding = derive_membership_blinding(&signature, network)?;
            let (note_keypair, encryption_keypair) =
                derive_encryption_and_note_keypairs(signature)?;

            let mut storage =
                SqliteStorage::connect_file(db_path).context("open wallet storage")?;
            storage.save_encryption_and_note_keypairs(
                address,
                &note_keypair,
                &encryption_keypair,
                &blinding,
            )?;
            println!(
                "{{\"address\":\"{}\",\"notePublicKey\":\"{}\",\"aspSecret\":\"{}\"}}",
                address,
                encode_0x_hex(&note_keypair.public.0),
                blinding.to_0x_hex_be()
            );
            Ok(())
        }
        // Headless deposit through the real SDK pipeline
        // (sync → prove → sign → submit → confirm) against testnet. Requires
        // the address to be seeded (`e2e-seed`), whitelisted at the ASP, and
        // funded with XLM.
        Some("e2e-deposit") => {
            let (Some(secret), Some(address), Some(db_path), Some(amount)) =
                (args.get(1), args.get(2), args.get(3), args.get(4))
            else {
                bail!(USAGE);
            };
            let amount: u128 = amount.parse().context("invalid amount (stroops)")?;
            let deployments_path = args
                .get(5)
                .map_or("deployments/testnet/deployments.json", String::as_str);
            let rpc_url = args
                .get(6)
                .map_or("https://soroban-testnet.stellar.org", String::as_str);
            // Optional pool selector: asset code (`XLM` for the native pool,
            // `USDC` for a classic pool, …). Defaults to the first pool.
            let pool_asset = args.get(7).map(String::as_str);

            let config: ContractConfig =
                serde_json::from_str(&std::fs::read_to_string(deployments_path)?)
                    .context("invalid deployments json")?;
            let pool_contract_id = config
                .pools
                .iter()
                .find(|p| match pool_asset {
                    None => true,
                    Some("XLM") | Some("native") => {
                        matches!(p.asset, types::AssetDescriptor::Native)
                    }
                    Some(code) => match &p.asset {
                        types::AssetDescriptor::Classic { code: c, .. } => c == code,
                        types::AssetDescriptor::Contract { symbol, .. } => symbol == code,
                        types::AssetDescriptor::Native => false,
                    },
                })
                .map(|p| p.pool_contract_id.clone())
                .ok_or_else(|| anyhow!("no matching pool in deployments json (selector: {pool_asset:?})"))?;

            let artifacts = ProverArtifacts {
                proving_key: std::fs::read(
                    "deployments/testnet/circuit_keys/policy_tx_2_2_proving_key.bin",
                )
                .context("read proving key")?,
                circuit_wasm: std::fs::read(
                    "target/circuits-artifacts/release/policy_tx_2_2.wasm",
                )
                .context("read circuit wasm (run `cargo build -p circuits --release`)")?,
                circuit_r1cs: std::fs::read(
                    "target/circuits-artifacts/release/policy_tx_2_2.r1cs",
                )
                .context("read circuit r1cs")?,
            };

            let pool_config = PrivatePoolConfig {
                rpc_url: rpc_url.to_string(),
                contract_config: config,
                pool_contract_id,
                user_address: address.to_string(),
                storage_path: db_path.to_string(),
                prover_artifacts: artifacts.clone(),
            };
            let pool = PrivatePool::init(
                pool_config,
                LocalStorage::open(db_path).map_err(|e| anyhow!("open storage: {e}"))?,
                Box::new(
                    LocalSigner::new(secret, TESTNET_PASSPHRASE, address.to_string())
                        .map_err(|e| anyhow!("signer: {e}"))?,
                ),
                Box::new(
                    LocalProver::from_artifacts(&artifacts).map_err(|e| anyhow!("prover: {e}"))?,
                ),
            )
            .map_err(|e| anyhow!("pool init: {e}"))?;

            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            runtime.block_on(async {
                pool.sync().await.map_err(|e| anyhow!("sync: {e}"))?;
                let result = pool
                    .deposit(NoteAmount::from(amount))
                    .await
                    .map_err(|e| anyhow!("deposit: {e}"))?;
                println!("{{\"txHash\":\"{}\"}}", result.tx_hash);
                Ok(())
            })
        }
        _ => bail!(USAGE),
    }
}

/// Headless reproduction of the app's ASP membership precondition: sync
/// events with the SDK indexer into a SQLite DB, process them, and
/// run the exact `check_asp_membership_precondition` the transact flow uses
/// (`sdk/pool/src/transact.rs::build_membership_proof`).
///
/// By default a throwaway DB is used (created and deleted per run). Passing
/// `db_path` runs the check against an existing DB — e.g. a copy of a user's
/// OPFS `poolstellar.sqlite` — which also applies pending schema migrations
/// and event processing to it, exactly like the app's storage worker would.
async fn check_membership(
    config: &ContractConfig,
    rpc_url: &str,
    leaf: &Field,
    db_path: Option<String>,
) -> Result<()> {
    let fetcher = StateFetcher::new(rpc_url, config.clone())?;

    let (db_path, throwaway) = match db_path {
        Some(path) => (path, false),
        None => {
            let path = std::env::temp_dir().join(format!(
                "asp-membership-check-{}.sqlite",
                std::process::id()
            ));
            (path.to_string_lossy().into_owned(), true)
        }
    };
    let storage = LocalStorage::open(&db_path).map_err(|e| anyhow!("open storage: {e}"))?;

    let indexer_storage = storage.fork().map_err(|e| anyhow!("fork storage: {e}"))?;
    let indexer = Indexer::init(fetcher.rpc().clone(), indexer_storage, config).await?;
    indexer.catch_up().await?;
    storage
        .process_pending_state()
        .await
        .map_err(|e| anyhow!("process events: {e}"))?;

    let asp = fetcher.asp_state().await?.asp_membership;
    let status = storage.storage().check_asp_membership_precondition(
        &config.asp_membership,
        leaf,
        &asp.root,
        asp.ledger,
    )?;

    println!(
        "{{\"leafHex\":\"{}\",\"chainRoot\":\"{}\",\"chainLedger\":{},\"status\":\"{:?}\"}}",
        leaf.to_0x_hex_be(),
        asp.root.to_0x_hex_be(),
        asp.ledger,
        status
    );
    if throwaway {
        let _ = std::fs::remove_file(&db_path);
    }
    Ok(())
}
