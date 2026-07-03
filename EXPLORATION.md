# EXPLORATION.md — Exploración y puesta en marcha de `pollar-private-payments`

> Fecha: 2026-07-03 · Fork de [NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments) · Solo exploración, **no se modificó lógica**.

---

## 1. Mapa de archivos clave

### 1.1 Conexión de wallet (Freighter)

Toda la integración con Freighter vive en **un solo archivo**: `app/js/wallet.js` (único import de `@stellar/freighter-api`, líneas 1–12). El lado Rust/WASM nunca llama a Freighter directo.

| Operación | Ubicación |
|---|---|
| `isConnected()` | `app/js/wallet.js:23`, `:91` |
| `isAllowed()` / `setAllowed()` | `app/js/wallet.js:46`, `:52` |
| `requestAccess()` (prompt de conexión) | `app/js/wallet.js:59` |
| `getAddress()` | `app/js/wallet.js:95`, `:109` |
| `getNetworkDetails()` (red + Soroban RPC URL) | `app/js/wallet.js:148` |
| `signTransaction` (envelope completo) | `app/js/wallet.js:189` |
| `signAuthEntry` (auth entries Soroban) | `app/js/wallet.js:211` |
| `signMessage` (derivación de keys) | `app/js/wallet.js:237` |

- Puntos de entrada UI que conectan la wallet: `app/js/ui/navigation.js:247` (app principal, fuerza testnet en `:250`) y `app/js/disclosure.js:173`.
- **Puente WASM↔wallet**: `wallet.js` instala `window.__walletSignBridge` (`app/js/wallet.js:328-346`) con `signAuthEntry` y `signTransaction`; Rust lo consume en `app/crates/platforms/web/src/signer.rs:15` vía `wallet_call()` (`signer.rs:49-74`).

### 1.2 Derivación de keys (paso "Keys" del onboarding)

- **Mensaje firmado (uno solo, con Freighter `signMessage`)**: `"Privacy Pool Key Derivation [v1]"` — constante en `sdk/prover/src/encryption.rs:50`, expuesta como `keyDerivationMessage()` en `app/crates/platforms/web/src/client/mod.rs:249-252`.
- **Flujo JS**: botón "Derive" en `app/js/ui/onboarding-wizard.js:469-489` → `deriveKeysFromWallet()` (`app/js/wallet.js:268-325`) → firma con Freighter (`wallet.js:294-297`) → bytes de la firma a WASM `deriveAndSaveUserKeys` (`wallet.js:310`).
- **Derivación (Rust, corre en el storage worker** — `app/crates/platforms/web/src/workers/storage.rs:222-233`):
  - La firma Ed25519 (64 bytes exactos) se reduce con **SHA-256 con separación de dominio** (`sdk/prover/src/encryption.rs:181-200`). Elección deliberada de SHA-256 (no Poseidon) para derivaciones fuera del circuito (`encryption.rs:8-9`).
  - **Note private key (spending)**: `SHA256("privacy-pool/note-key/v1" ‖ sig)` reducido a escalar BN254 (`encryption.rs:159-179`).
  - **Note public key (npk)**: `Poseidon2(note_private_key, 0, domain=3)` — Poseidon2 sobre BN254, t=3 (`sdk/prover/src/crypto.rs:91-95`, `:167-169`; circuito equivalente en `circuits/src/keypair.circom:9-20`).
  - **Encryption/viewing keypair**: `seed = SHA256("privacy-pool/encryption-key/v1" ‖ sig)` usado como secreto **X25519**; las notas se cifran con NaCl crypto_box (X25519-XSalsa20-Poly1305) (`encryption.rs:119-140`, `:279-349`).
  - **ASP secret (membership blinding)**: `SHA256("privacy-pool/asp-secret/v1" ‖ 0x00 ‖ network ‖ 0x00 ‖ sig)` reducido a campo BN254 — **con scope por red** (testnet ≠ mainnet) (`encryption.rs:77-98`).
- Solo las claves públicas (npk + encryption pubkey) salen del dispositivo (registro opcional on-chain: `onboarding-wizard.js:259-273` → `client/mod.rs:226-247`).
- Nota menor: el doc-comment de `encryption.rs:19-24` menciona `[v2]` pero las constantes vivas son todas **v1** (comentario desactualizado).

### 1.3 Construcción y firma de transacciones (deposit / transfer / withdraw)

**El XDR se construye 100% localmente, en Rust/WASM** (no se usa stellar-sdk JS para construir; JS solo llama a Freighter para firmar).

- Botones UI: deposit `app/js/ui/transactions.js:212`, transfer `:262`, withdraw `:300`, transact avanzado `:332`.
- Entradas WASM: `Pool::{deposit,transfer,withdraw,transact}` en `app/crates/platforms/web/src/client/transact.rs:331-403`, orquestación con progreso en `execute_plan` (`transact.rs:70-187`).
- Pipeline SDK (`sdk/pool/src/pool.rs:396-427`): **prove** (`prover.prove_transact`, worker de proving) → **build+simulate** (`sdk/stellar/src/tx_prepare.rs:25-63` construye el `InvokeHostFunction` que llama a `transact` del pool; envelope crudo en `sdk/stellar/src/contract_state.rs:556-590`; ensamblado post-simulación en `sdk/stellar/src/tx_assemble.rs:131`) → **sign** → **submit** (`sdk/stellar/src/submit.rs:9-19`, RPC `sendTransaction`) → **confirm** (poll `getTransaction`, 30×1s).
- **La wallet firma AMBAS cosas** (documentado en `sdk/stellar/src/signer.rs:1-17`):
  1. **Auth entries de Soroban** — un `signAuthEntry` por cada entrada propiedad del usuario, sobre el preimage `HashIdPreimage::SorobanAuthorization` (`sdk/stellar/src/signer.rs:257-273`; expiración = último ledger + 100).
  2. **El envelope v1 completo** — `signTransaction` al final.
  Orquestado en `app/crates/platforms/web/src/signer.rs:77-117` (`sign_prepared_transaction`).
- RPC: cliente JSON-RPC propio wasm-compatible (`sdk/stellar/src/rpc.rs` — `simulateTransaction:620`, `sendTransaction:648`, `getTransaction:668`). La URL sale de Freighter `getNetworkDetails().sorobanRpcUrl` (`app/js/ui/navigation.js:248-263`).

### 1.4 Storage local

- **Motor**: SQLite compilado a WASM (`sqlite-wasm-rs` 0.5.3) persistido en **OPFS** (Origin Private File System) con SyncAccessHandle pool — no localStorage ni IndexedDB. VFS instalado en `app/crates/platforms/web/src/workers/storage.rs:100-124`.
- **Archivo**: `poolstellar.sqlite` (`sdk/state/src/storage.rs:16`; advertencia: cambiar el nombre pierde la DB).
- **Esquema**: `sdk/state/src/schema.sql` — tablas clave: `keypairs` (`:66-76` — encryption private/public key, note private/public key, `membership_blinding` = ASP secret, **todos BLOBs en claro**), `user_notes` (`:136-154`), `pool_commitments`, `pool_nullifiers`, `public_keys` (address book), `asp_membership_leaves`, `app_settings`, `app_user_operations`.
- **Sin cifrado en reposo**: las claves privadas se insertan como BLOBs planos (`sdk/state/src/storage.rs:243-282`). La confidencialidad depende de que OPFS es privado por origen + `navigator.storage.persist()` (`app/js/ui/persistent-storage.js`).
- **storage-worker** (`app/crates/platforms/web/src/bin/storage_worker.rs`): Web Worker dedicado, único dueño de la conexión SQLite/OPFS (los handles OPFS solo funcionan fuera del main thread). Todo acceso a DB pasa por él como mensajes (`workers/storage.rs:164-436`). Guard de una sola pestaña (`workers/storage.rs:44-49` + `app/js/db-locked.js`).
- `app/js/sw.js` (service worker): solo notificaciones de retención (recordatorio a los 5 días); no toca keys ni notas.
- `localStorage`: solo flags de UI (`persistent-storage.js:97,110`, `push-notifications.js:11,19`, `onboarding-wizard.js:35,43`).

### 1.5 Admin / ASP

- **Página**: `app/admin.html` + `app/js/admin.js` (importa `wasm-facade.js`, `wallet.js`, `db-locked.js`). Tres paneles: estado de contratos (`admin.html:72-134`), Membership Leaf Builder (`:136-176`), Non-Membership Insert (`:178-217`).
- **Derivación del leaf en el admin**: `computeMembershipLeaf()` (`admin.js:299-331`) → `client.deriveAspUserLeaf(blinding, pubKey)` (WASM: `app/crates/platforms/web/src/client/mod.rs:375-400` → `sdk/prover/src/crypto.rs:154-163`).
- **Inserción**: `insertMembershipLeaf()` (`admin.js:338-365`) → `client.insert_leaf({leaf})` + `tx.signAndSend()` firmado con Freighter (signer wrapper en `admin.js:149-166` → `wallet.js:186-195` y `:208-217`). La cuenta Freighter conectada debe ser el admin del contrato.
- **Toggle "Admin-Only Leaf Insert"**: `toggleAdminInsertOnly()` (`admin.js:386-421`) → `set_admin_insert_only` del contrato (`contracts/asp-membership/src/lib.rs:137-143`, requiere `admin.require_auth()`).

---

## 2. Formato del leaf del ASP y firma requerida

### Leaf de membership

```
leaf = Poseidon2( note_public_key , asp_secret , domainSeparation = 0x01 )
```

- Poseidon2 de 2 inputs (estado t=3) sobre BN254. Orden exacto del preimage: **input[0] = note public key, input[1] = ASP secret (membership blinding)**, dominio = 1.
- Constraint del circuito: `circuits/src/policyTransaction.circom:130-134`.
- Cómputo Rust equivalente: `asp_membership_leaf()` en `sdk/prover/src/crypto.rs:151-163` (usa `poseidon2_hash2(note_pubkey, blinding_le, 1)`).
- Recordatorio: `note_public_key = Poseidon2(note_private_key, 0, domain=3)` (`circuits/src/keypair.circom:9-20`).
- El árbol de **non-membership** (SMT) usa otro hash de hoja: `Poseidon2(key, value, domain=1)` (`contracts/asp-non-membership/src/lib.rs:142-145`).

### Autorización de `insert_leaf`

- **ASP Membership** (`contracts/asp-membership/src/lib.rs:195-252`): la auth es **condicional**. Si `AdminInsertOnly == true` (default, se setea en el constructor, `lib.rs:95`) exige `admin.require_auth()` (`lib.rs:197-201`); si el admin lo apaga con `set_admin_insert_only(false)`, **cualquiera puede insertar** (por eso el warning ámbar del admin UI).
- **ASP Non-Membership**: `insert_leaf` (`lib.rs:361-492`) y `delete_leaf` (`lib.rs:516-617`) exigen **siempre** auth del admin, sin toggle.
- Por CLI: `stellar contract invoke --id <ASP_MEMBERSHIP> --source-account <ASP_ADMIN> -- insert_leaf --leaf <LEAF_U256>`.

---

## 3. El SDK (`sdk/`) y recomendación de integración

### Qué es y qué expone

- **100% Rust**, 9 crates (no hay TypeScript). Historia: solo 4 commits (`SDK repo prep #246` → `SDK init #311` → `SDK-app first integration #312` → `Remove leftover SDK client #331`). Es nuevo pero **no es un stub**: el commit #312 movió el corazón del frontend al SDK; hoy `app/` es un adaptador delgado de navegador.
- Crate paraguas: **`stellar-private-payments-sdk`** (`sdk/pool`). Entry point: `PrivatePool<S: Storage>` (`sdk/pool/src/pool.rs:37`) con métodos async: `deposit`, `transfer`, `withdraw`, `transact`, `disclose`, `balance`, `notes`, `sync`, `estimate`, más el pipeline de bajo nivel (`prove_next`/`simulate`/`sign`/`submit`/`confirm`). Hay wrapper **bloqueante** (`sdk/pool/src/blocking/pool.rs:18`) para uso nativo/CLI. Ejemplo runnable completo en el doc del crate (`sdk/pool/src/lib.rs:9-57`).
- **Tres traits inyectables** (el punto de extensión clave para Pollar):
  - `Prover` (`sdk/pool/src/prover/mod.rs:89`) — impl default `LocalProver` con Groth16 real (ark-groth16 + witness por wasmer).
  - `Signer` (`sdk/pool/src/signer/mod.rs:11`) — impl default `LocalSigner` (firma con secret key ed25519); el frontend inyecta `WalletSigner` (Freighter).
  - `Storage` (`sdk/pool/src/storage/mod.rs:72`) — impl default `LocalStorage` (SQLite nativo); el frontend inyecta `StorageBridge` (SQLite-WASM/OPFS).

### ¿Permite deposit/transfer/withdraw programático sin el frontend?

**Sí** — el pipeline completo (derivar keys → probar → construir XDR → firmar → enviar → confirmar) funciona headless en nativo, con dos requisitos del caller:

1. **Sembrar las keys**: `PrivatePool` no expone "crear keys"; hay que llamar `sdk/prover/src/encryption.rs` (`derive_encryption_and_note_keypairs`, `derive_membership_blinding`) y persistir con `save_encryption_and_note_keypairs` (`sdk/state/src/storage.rs:243`) — exactamente lo que hace el harness de tests (`sdk/tests/src/seed.rs`).
2. **Proveer artefactos de circuito reales**: `ProverArtifacts { proving_key, circuit_wasm, circuit_r1cs }` (`sdk/pool/src/types.rs:8-12`).

Único hueco funcional: `LocalProver` tiene **stubs para disclosure** (`sdk/pool/src/prover/local.rs:42-59` devuelve error); el proving de transacciones sí está completo. El prover del frontend (`workers/prover.rs:393`) sí implementa disclosure.

### Madurez

- ~185 tests en el workspace, bien repartidos en los crates de bajo nivel (tx-planner 32, types 28, prover 27, disclosure 25, stellar 23, state 15) pero **`pool` solo 2 y `witness` 0**; no hay test de integración en `sdk/tests` que haga un deposit→submit real (eso vive en `e2e-tests/` a nivel repo).
- Solo 3 TODOs menores. Lints estrictos a nivel workspace (`unwrap_used`, `arithmetic_side_effects`, casts y `unsafe` denegados).
- Paridad vs frontend: ~90% para un consumidor nativo (faltan el aprovisionamiento de keys integrado y el prover de disclosure default).

### ✅ Recomendación: **integrar vía SDK, no vía frontend**

Razones:
1. El diseño de traits calza exacto con Pollar: implementar un **`Signer` custom que firme con AWS KMS** (server-side, igual que hace `WalletSigner` con Freighter: auth entries + envelope) y derivar las keys de privacidad desde una firma generada por el backend de Pollar en lugar de Freighter `signMessage`.
2. El frontend es solo un adaptador de navegador sobre el mismo SDK — integrar por frontend significaría acoplarse a Freighter, OPFS y Web Workers, todo lo que Pollar precisamente reemplaza.
3. El pipeline headless ya está probado por el propio harness del repo (`sdk/tests`).

Riesgos a vigilar: el SDK tiene días de vida y 4 commits — la API puede moverse; el orquestador `pool` está poco testeado; conviene fijar el commit e ir siguiendo upstream.

---

## 4. Deploy a testnet (realizado 2026-07-03)

### Cuenta ASP admin (deployer + admin de todos los contratos)

- **Identity de stellar-cli**: `pollar-asp-admin`
- **Dirección**: **`GC3LGF4C5M7ZJI4MXBIIWLGBFVTRXXIDQ3HA36TAVHCNXWZUHDWLZPJ6`**
- Fondeada vía friendbot (`stellar keys fund pollar-asp-admin --network testnet`). El secret queda en `~/.config/stellar/identity/pollar-asp-admin.toml`.

### Contratos deployados

Comando ejecutado (con bash 5 de Homebrew; el script requiere `mapfile`):

```bash
/opt/homebrew/bin/bash deployments/scripts/deploy.sh testnet \
  --deployer pollar-asp-admin \
  --asp-levels 10 --pool-levels 10 --max-deposit 1000000000 \
  --vk-file deployments/testnet/circuit_keys/policy_tx_2_2_vk.json \
  --pool native:$(stellar contract id asset --asset native --network testnet)
```

| Contrato | Dirección | Explorer |
|---|---|---|
| Pool (XLM nativo) | `CCK7YAPUWGKTLZQF6SNA2K4GWBB4W44G7EBFVXEDQOJRVOHYPSHQKBM7` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CCK7YAPUWGKTLZQF6SNA2K4GWBB4W44G7EBFVXEDQOJRVOHYPSHQKBM7) |
| Verifier Groth16 | `CCA5SMNQGZN5CWWSRJITSWLEFE6XXGHEQUXSGU6KUFBQ4NC4OKKWYT26` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CCA5SMNQGZN5CWWSRJITSWLEFE6XXGHEQUXSGU6KUFBQ4NC4OKKWYT26) |
| ASP Membership | `CAM4ED3KQLME7UY7KCLMZ2UJRUWIIIV4X5HC5Q5I4ZXQQW7VOHZ34LXU` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CAM4ED3KQLME7UY7KCLMZ2UJRUWIIIV4X5HC5Q5I4ZXQQW7VOHZ34LXU) |
| ASP Non-Membership | `CCOY5SZELQHFIKARPDUVYYFB6SX2ZOOS4GKHHJWALNWEBDEVUGQSIWX2` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CCOY5SZELQHFIKARPDUVYYFB6SX2ZOOS4GKHHJWALNWEBDEVUGQSIWX2) |
| Public Key Registry | `CBPMYVUXDSQEG3GTABGLSBPMP63JUSY22RFAO5VZEMCPSVBHC3B76ZCJ` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CBPMYVUXDSQEG3GTABGLSBPMP63JUSY22RFAO5VZEMCPSVBHC3B76ZCJ) |

- Token XLM nativo (SAC): `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` · Ledger de deploy del pool: `3408958` · Constructores ejecutados: sí.
- `deployments/testnet/deployments.json` quedó actualizado por el script con exactamente estas direcciones (verificado).
- **Importante**: las direcciones se **embeben en el binario WASM en compile-time** (`include_str!` en `app/crates/platforms/web/src/lib.rs:14`) — tras cualquier redeploy hay que recompilar el frontend.

### VK usada — nota de verificación

El build local regeneró claves Groth16 en `testdata/` (gitignored) que **difieren** de las comprometidas. Se verificó que la app embebe la **proving key comprometida de la ceremonia** (`deployments/testnet/circuit_keys/policy_tx_2_2_proving_key.bin`, vía `include_bytes!` en `app/crates/platforms/web/src/workers/prover.rs:31`), por lo que la VK correcta para el verifier on-chain es la comprometida `policy_tx_2_2_vk.json` — que fue la usada. Proving key y VK on-chain son consistentes.

---

## 5. App corriendo en localhost

- ✅ `http://localhost:8000` → HTTP 200, título "Stellar Private Payments".
- ✅ `http://localhost:8000/admin.html` → HTTP 200.
- ✅ Artefactos de circuito servidos (`/circuits/policy_tx_2_2.wasm` → 200).
- Servido con `trunk serve` (puerto 8000, config en `Trunk.toml`). Si venías usando la app con los contratos viejos: **limpia el storage del navegador** (DevTools → Application → Clear storage) porque la DB OPFS local indexó los contratos anteriores.

### Cómo levantarla en esta máquina (macOS) — gotchas encontrados

`make serve` a secas **no funciona** en este Mac por tres motivos, todos con workaround aplicado:

1. **Perfil debug vs release**: el Makefile compila circuitos en debug pero `Trunk.toml` fija `release = true`, y el hook pre-build busca `target/circuits-artifacts/release/`. Solución: `cargo build -p circuits --release` antes de servir.
2. **clang de Xcode sin target wasm**: `sqlite-wasm-rs` compila C a wasm32 y el clang de Apple no lo soporta ("No available targets are compatible with triple wasm32-unknown-unknown"). Solución: `brew install llvm` y exportar `CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang` y `AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar`.
3. **bash 3.2 de macOS**: `deploy.sh` usa `mapfile` (bash ≥4). Solución: `brew install bash` y correr el script con `/opt/homebrew/bin/bash`.

Comando de arranque que funciona:

```bash
cargo build -p circuits --release
export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar
PUBLIC_URL=/ trunk serve --dist dist --public-url /
```

Prerequisitos verificados/instalados: Rust 1.92.0 (según `rust-toolchain.toml`), targets `wasm32v1-none` + `wasm32-unknown-unknown`, Node v22, stellar-cli 26.1.0, trunk 0.21.14 (instalado por `make install`), LLVM 22 (brew), bash 5.3 (brew). **Circom NO se necesita como binario**: el compilador está embebido como crates Rust en `circuits/build.rs`.

---

## 6. Qué falló o no se pudo verificar

1. **`make serve` roto out-of-the-box en macOS** (3 causas arriba). No se tocó el Makefile ni el script — solo workarounds externos. Si quieren, se puede proponer fix upstream.
2. **No verificado end-to-end con wallet**: no se ejecutó un deposit/transfer/withdraw real ni un insert_leaf desde admin.html, porque requieren interacción con la extensión Freighter en el navegador (firma manual). Verificado solo: páginas cargan (200), artefactos servidos, contratos deployados con constructores OK.
3. **Pool EURC no deployado**: el comando pedido solo incluía el pool nativo XLM. El `deployments.json` anterior (del repo) traía también un pool EURC; el nuestro tiene solo el nativo. Si lo quieren: re-correr el deploy agregando `--pool classic:EURC:GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO:<SAC_ID>` (ojo: cada corrida redeploya TODO y sobreescribe `deployments.json`).
4. **ASP membership tree vacío**: recién deployado, nadie puede depositar todavía. Siguiente paso operativo: derivar keys de un usuario en la app y que el ASP admin (Freighter con la cuenta `GC3LGF4C...ZPJ6`, importable con `stellar keys add` por seed phrase, o vía CLI) inserte su leaf.
5. **Claves `testdata/` regeneradas localmente**: difieren de las de la ceremonia, pero son inertes (la app y el deploy usan las comprometidas). No borrar `deployments/testnet/circuit_keys/`.
6. **Doc-comment desactualizado** en `sdk/prover/src/encryption.rs:19-24` (dice v2, el código usa v1). Cosmético.
7. **Bootnode/indexer**: `tools/bootnode` existe pero no se levantó ni verificó; la app funciona contra el RPC de Soroban directamente (el soporte de bootnode sigue marcado como pendiente upstream, issue #169).
