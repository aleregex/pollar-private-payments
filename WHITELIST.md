# WHITELIST.md — Backend de whitelist para el ASP

> Fecha: 2026-07-03 · Complementa a `EXPLORATION.md`. Código en `/server`.

## Qué se construyó

Backend Node.js/Express en `server/` con el flujo request → approve → `insert_leaf` on-chain, más un CLI Rust (`server/leaf-cli/`, binario `asp-leaf-cli`) para derivar la leaf fuera del browser. Storage en `server/whitelist.json` (gitignored, igual que `server/.env`).

## Algoritmo de derivación de la leaf (replicado, no reimplementado)

**Fórmula**: `leaf = Poseidon2(notePublicKey, aspSecret, domainSeparation=1)` sobre BN254 (Poseidon2 t=3).

Cadena original del admin (de donde se replicó):

1. `app/admin.html` + `app/js/admin.js` — `computeMembershipLeaf()` (`admin.js:299-331`): parsea ambos inputs con `BigInt` (hex `0x...` o decimal, `parseBigIntInput`), normaliza la pubkey a `'0x' + toString(16).padStart(64,'0')` y llama `client.deriveAspUserLeaf(blinding, pubKeyHex)`.
2. Bridge WASM `deriveAspUserLeaf` (`app/crates/platforms/web/src/client/mod.rs:375-400`): blinding → `parse_field_bigint_numeric` (hex BE de 64 dígitos → `Field::from_0x_hex_be`, `mod.rs:540-552`); pubkey → serde de `NotePublicKey` (hex crudo de 32 bytes, `sdk/types/src/lib.rs:301-325`).
3. Storage worker (`app/crates/platforms/web/src/workers/storage.rs:416-424`) → **`prover::crypto::asp_membership_leaf`** (`sdk/prover/src/crypto.rs:151-163`): `poseidon2_hash2(pubkey_bytes, blinding.to_le_bytes(), 1)`.

**Cómo se replicó**: opción (2) del plan — un binario Rust dentro del repo. No se reimplementó nada: `asp-leaf-cli` (`server/leaf-cli/src/main.rs`) linkea los crates existentes `prover` y `types` y llama a la **misma** `asp_membership_leaf`, con el mismo parsing de entradas (`NotePublicKey::parse` ≡ el serde del bridge; `Field::from_0x_hex_be` ≡ `parse_field_bigint_numeric`). La normalización BigInt de admin.js se replica en el server Node (`canonicalize()` en `server/index.js`). Se agregó `server/leaf-cli` a los members del workspace en el `Cargo.toml` raíz (único cambio fuera de `/server`; no toca contratos, circuitos ni frontend).

**Por qué no la opción (1) (reusar el WASM del frontend)**: el bundle de trunk es wasm-bindgen target `web` y la derivación corre dentro del storage worker con dependencias de browser (Web Workers, OPFS) — no carga en Node sin hackear el runtime. El CLI nativo usa el mismo código fuente Rust, que es una garantía más fuerte que reusar el artefacto.

## Vía usada para insert_leaf

**Subprocess del `stellar` CLI** (la más simple, funcionó a la primera):

```
stellar contract invoke --id <ASP_MEMBERSHIP> --source-account <ADMIN> --network testnet -- insert_leaf --leaf <LEAF_DECIMAL>
```

Firmada por la identity `pollar-asp-admin` (admin del contrato; `AdminInsertOnly` quedó en `true`, el default). El tx hash se parsea del output del CLI. No se usó `@stellar/stellar-sdk` para el insert.

## Prueba end-to-end (2026-07-03, outputs reales)

Contrato ASP Membership: `CAM4ED3KQLME7UY7KCLMZ2UJRUWIIIV4X5HC5Q5I4ZXQQW7VOHZ34LXU` (de `deployments/testnet/deployments.json`).

1. **Server arriba** (`node index.js`, puerto 4000) y app del pool sirviendo en `localhost:8000` (200 OK). ✅
2. **Usuario de prueba** — generado con `asp-leaf-cli test-user testnet` (misma derivación que el onboarding, a partir de una firma sintética de 64 bytes; ver "Pendientes" sobre el paso con Freighter):
   - notePublicKey: `0x85a882049ee74bedf84b315adb36a08460fa8e332fe066e68d78bf9d62087d06`
   - aspSecret: `0x00001ac58bf57422172815409185dc59458cf1a9e919506f01ae5c599cb5777c`
3. **POST /whitelist/request** → `{"id":"1aabecc2-4a20-4128-a407-852d7764c19c","status":"pending"}` ✅
   - Duplicado → `{"error":"notePublicKey already registered"}` (409) ✅
   - Campo vacío → `{"error":"notePublicKey is required"}` (400) ✅
4. **POST /whitelist/approve** → `{"id":"1aabecc2-...","status":"approved","txHash":"9c3e2774a0e86ef232c3ea0a2201e21e9326b949d9fa3123256f436712ee4bb9"}` ✅
   - Leaf derivada: `0x146f9348f06f49660b6662785e4eab23adf5b3a7d2badfd06e92cea6b4990739`
5. **Insert on-chain verificado** ✅
   - https://stellar.expert/explorer/testnet/tx/9c3e2774a0e86ef232c3ea0a2201e21e9326b949d9fa3123256f436712ee4bb9
   - Horizon: `successful: true`, source `GC3LGF4C5M7ZJI4MXBIIWLGBFVTRXXIDQ3HA36TAVHCNXWZUHDWLZPJ6` (admin), ledger `3409276`.
   - `get_root` del contrato post-insert: `4466838898892356631505983847471660697690343825755203674317971793941666268836` (árbol mutado).
6. **Re-approve** → 409 `already approved` con el mismo txHash ✅ · **id inexistente** → 404 ✅
7. **CORS**: `Access-Control-Allow-Origin: http://localhost:8000` presente; origen desconocido sin header ✅

> ⚠️ **CORRECCIÓN (2026-07-03, más tarde)**: el diagnóstico de esta sección quedó **incompleto**. El hard reload NO arregló el problema. La causa raíz real está en la sección siguiente ("Incidente — parte 2"). En particular, la afirmación de que el ASP viejo tenía "0 eventos LeafAdded" era **falsa** (tenía 8, ingestados en la DB del usuario), y eso es exactamente lo que gatilló el bug real.

## Incidente 2026-07-03: "not registered with the ASP" tras approve exitoso — diagnóstico

**Síntoma**: usuario real (registro `c97d7eb9`, tx insert [`4daf6146...d54c50`](https://stellar.expert/explorer/testnet/tx/4daf6146c6b19c08e397a297db99952b1f1375097a6bb085f6694f4f67d54c50)) seguía viendo "Your account is not registered with the ASP yet" al depositar.

**Diagnóstico: NO fue la hipótesis A (derivación) ni un problema de rango/retención de eventos (B clásica). Fue un build viejo del frontend cacheado en el browser del usuario, apuntando a los contratos anteriores al redeploy.** Evidencia, en orden:

1. **Derivación bit-idéntica** (A descartada): la leaf de `leaf-cli` para los valores exactos del registro (`0x29016ffc...4ce0`) coincide byte a byte con la del evento `LeafAdded` on-chain de la tx del insert (decodificado del XDR: index=1, misma leaf, SUCCESS en ledger 3409494).
2. **Datos de cadena correctos**: `getEvents` con el mismo query que usa la app (desde el `deploymentLedger` 3408958, filtro por contrato) devuelve ambos eventos `LeafAdded`; la retención del RPC (~3288809+) cubre el rango de sobra.
3. **Reproducción headless del check de la app** (nueva subcommand `check-membership` de `asp-leaf-cli`): ejecuta el pipeline real del SDK — `Indexer::catch_up` + procesamiento de eventos a SQLite + `check_asp_membership_precondition` (el mismo que `sdk/pool/src/transact.rs::build_membership_proof`) — contra `deployments.json` actual. Resultado: **`UserIndex(1)`** (root on-chain `0x10125466...6a51` == root local, leaf encontrada). El stack completo funciona.
4. **El contrato ASP viejo** (`CAN4INFN...QETAZ`, del build anterior al redeploy de hoy): **0 eventos `LeafAdded` en toda la ventana de retención**. Un cliente con ese build sincroniza ese contrato, no observa ninguna leaf y `check_asp_membership_precondition` devuelve `RegisterAtASP` → exactamente el toast del usuario (`app/js/ui/transactions.js:384`, vía `aspNotReady`). `SyncRequired` en cambio auto-reintenta (`client/transact.rs:108-121`), así que un error *persistente* solo puede ser `RegisterAtASP`.

**Mecanismo del build viejo**: las direcciones van embebidas en compile-time (`include_str!` en `app/crates/platforms/web/src/lib.rs:14`), Trunk sirve `web_bg.wasm` con URL estable (`filehash = false` en `Trunk.toml`) y sin `Cache-Control` (solo `last-modified`) — y/o el usuario tenía la pestaña abierta desde antes del rebuild de las 06:23, onboardeando con el WASM viejo en memoria. Sus keys son válidas (la derivación depende de la firma + red, no del contrato), pero su app consultaba el ASP viejo.

**Fix para el usuario (sin borrar storage)**: hard-reload de la pestaña (Cmd+Shift+R en `localhost:8000`) o cerrar y reabrir la pestaña, para cargar el WASM actual (verificado: el servido hoy embebe las direcciones nuevas). No hay que borrar OPFS: las keys se guardan por address y las tablas de indexing se separan por contrato; las filas del contrato viejo quedan inertes. Tras recargar, el flujo de deposit mostrará "Waiting to sync N ledger(s)…" mientras indexa y luego procederá a prove/sign — la prueba headless del punto 3 demuestra que el check pasa con los datos actuales.

**Qué se tocó**: nada en server ni en la derivación (eran correctos). Se agregó la subcommand de verificación `asp-leaf-cli check-membership <notePublicKey> <aspSecret> [deployments_json] [rpc_url]` (útil para soporte: correrla antes de decirle al usuario que recargue) y el feature `rustls` de reqwest en `server/leaf-cli/Cargo.toml` (el SDK delega TLS al browser en WASM; nativo lo necesita — habilitado por unificación de features, sin tocar `sdk/`).

**Prevención sugerida (no aplicada, tocaría el frontend)**: habilitar `filehash = true` en `Trunk.toml` para URLs de assets con hash, o servir con `Cache-Control: no-cache`.

## Incidente 2026-07-03 — parte 2: la causa raíz REAL (bug de PK global en `asp_membership_leaves`) — RESUELTO

**Síntoma persistente**: tras el hard reload (Cmd+Shift+R) el usuario (`GCT7D6S5VTFGEURS6ZYIO33YZRPQMA3LNWB4GEOHDFDXZGWTA4EPIM5E`) seguía viendo "Your account is not registered with the ASP yet"; header "Synced".

### Evidencia (inspección directa de la DB OPFS real del usuario)

La DB `poolstellar.sqlite` vive en OPFS de Chrome y es legible desde disco: perfil `Default`, origen `http_localhost_8000` → directorio `067` (mapeo en `File System/Origins`), archivo `File System/067/t/00/00000005` con header SAHPool de 4096 bytes antes del magic SQLite. Lo que mostró:

1. **El browser SÍ corría el build nuevo** (el hard reload funcionó): los contratos nuevos estaban registrados (contract_id 5/6/7) y sincronizados hasta el ledger 3414517, y los 2 eventos `LeafAdded` del ASP nuevo (ledgers 3409276 y 3409494) estaban **ingestados** en `raw_contract_events`. También se verificó por `strings` que los 3 WASM servidos (`web_bg`, `storage-worker_bg`, `prover-worker_bg`) embebían las direcciones nuevas.
2. **Las keys locales coinciden con el registro** `c97d7eb9`: `note_public_key = 0x7fdfbf8e...cc1e` byte a byte; `membership_blinding` es el mismo valor en little-endian (`0x9480ba04...` = reverso de `0x1bc7b91f...8094`). Nada que re-derivar ni re-aprobar.
3. **El bug**: `asp_membership_leaves` tenía PRIMARY KEY **`leaf_index` a secas (global, sin scope por contrato)** y el insert usaba `ON CONFLICT(leaf_index) DO NOTHING` (`sdk/state/src/storage.rs`). El ASP **viejo** (`CAN4INFN...`) sí tenía 8 leaves (índices 0–7, insertadas por el deployer upstream), ingestadas cuando el usuario usó el build viejo. Al sincronizar el ASP **nuevo**, sus leaves (índices 0 y 1 — la del usuario es la 1) **colisionaron con las viejas y se descartaron en silencio**. El check (`check_asp_membership_precondition`) filtra por contrato vía `event_id → raw_contract_events → contracts`: para el ASP nuevo veía 0 leaves con sync metadata "caught up" → `RegisterAtASP` **persistente** (no `SyncRequired`, que sí auto-reintenta). El check headless de la parte 1 pasaba porque usaba una DB limpia, sin las leaves viejas.

### Fix aplicado (verificado contra una copia de la DB real del usuario)

- **`sdk/state/src/migrations/002_asp_membership_leaves_per_contract.sql`** (nueva migración, registrada en `MIGRATION_ARRAY` de `storage.rs`): re-crea `asp_membership_leaves` con PK compuesta `(contract_id, leaf_index)`, backfill del contrato desde el raw event. Los eventos descartados quedan "unprocessed" (sin fila que referencie su `event_id`), así que el processing loop los **re-procesa solo** al abrir la app: la DB se auto-cura sin borrar nada (keys, notas y settings intactos).
- **`save_leaf_added_events_batch`** ahora inserta `contract_id` resuelto desde `raw_contract_events` con `INSERT OR IGNORE` (idempotente por evento, sin colisiones entre contratos).
- **`Trunk.toml`**: `headers = { "Cache-Control" = "no-cache" }` en `[serve]` (prevención de builds cacheados; `filehash = true` no era viable porque las URLs de los workers están hardcodeadas en `app/crates/platforms/web/src/client/mod.rs:103,108`).
- **`server/leaf-cli`**: `check-membership` acepta un `[db_path]` opcional para correr el check contra una DB existente (p. ej. copia de la OPFS de un usuario), y nuevos subcomandos `e2e-seed` / `e2e-deposit` (deposit headless real vía el pipeline completo del SDK).

**Verificación con los datos reales**: `check-membership` sobre una **copia de la DB OPFS del usuario** con el fix → migración aplicada, leaves re-procesadas (índice 0 sintética, índice 1 = la del usuario) y resultado **`UserIndex(1)`** con root local == root on-chain (`0x10125466...6a51`). Tests: `cargo test -p state -p sdk-tests -p stellar-private-payments-sdk` todo verde (15+13+2).

### E2E automatizado hasta el máximo posible (deposit real en testnet)

Freighter (extensión, firma manual) no es automatizable headless y el repo no trae harness de browser (`e2e-tests/` son tests Rust de contratos). Se reprodujo el flujo completo con el pipeline REAL del SDK (los mismos crates que corren en el browser):

1. Cuenta nueva fondeada por friendbot: `GBKYKSN5A4ZLNM7X6PM6SDL26PI56AZTUY6MJWMNGHOJZZJTY63L7QJ5`.
2. `asp-leaf-cli e2e-seed` (misma derivación que onboarding) → request + approve en el server → insert on-chain [`9458ac14...3664`](https://stellar.expert/explorer/testnet/tx/9458ac14ccb7974edc95a7ef650cafb16dfd7cb44e0215ba879d5044df0c3664).
3. `asp-leaf-cli e2e-deposit` (sync → **prove Groth16 con la proving key de la ceremonia** → sign → submit → confirm) → **deposit de 1 XLM exitoso**: [`f5ec65499848b4e3f7e5f5f255168f48270a5a50312a302cc5ddec1cec224e3f`](https://stellar.expert/explorer/testnet/tx/f5ec65499848b4e3f7e5f5f255168f48270a5a50312a302cc5ddec1cec224e3f) (`successful: true`, ledger 3414712). Esto valida ASP membership (árbol con 3 leaves), circuito+VK on-chain, y todo el camino de tx.

**Único paso manual restante**: la firma con Freighter desde la UI (idéntico pipeline, distinto signer).

### Instrucciones para el usuario (exactas)

1. **No borres el site data ni re-derives keys ni re-apruebes whitelist** — tus keys y tu registro son correctos.
2. Cierra la(s) pestaña(s) de `localhost:8000` y vuelve a abrir la app (basta un reload normal: el serve ahora manda `Cache-Control: no-cache`). Al abrir, el storage worker aplica la migración y re-procesa las leaves pendientes automáticamente.
3. Espera a que el header diga "Synced" y deposita. Si justo estás desincronizado verás "Waiting to sync N ledger(s)…" y reintenta solo.
4. Tu cuenta ya está fondeada (16,781 XLM en testnet) — **no hace falta friendbot**. Nota: el "Balance 0 XLM" del header es tu **balance privado del pool** (0 hasta tu primer deposit), no el XLM de la wallet. El toast del ASP se evalúa en la fase de proving (`build_membership_proof`), antes de cualquier chequeo de fondos — no era engañoso.

## Actualización 2026-07-03 (tarde): segundo pool (USDC) con el MISMO ASP

Se deployó un pool USDC (`CBUB4XICKADWNTRG3OYXYQPJ7PSJKARDYXSHAPMJCRBKJJCOCSO44FWD`, asset de prueba `USDC:GA33EDAUF3S2T7AB2ZWNQ373YV63JQ3CR5OPKLBV4VVZOFWIHQAPWC3Q`) apuntando al **mismo** ASP membership / verifier / registry — la whitelist de este server vale para ambos pools sin re-aprobar. Verificado con un deposit real de 1 USDC usando la misma leaf del usuario e2e: tx [`9e008c11...0fcd`](https://stellar.expert/explorer/testnet/tx/9e008c1166fc57e0884fb06d818e9395620f1a35247d553f464b12fabc630fcd). Además, los usuarios que entran por Pollar disparan `POST /whitelist/request` automáticamente al derivar keys (label = email o G-address). Detalles en POLLAR_INTEGRATION.md.

## Pendientes / no verificado (sin omitir nada)

1. **Del flujo E2E solo queda pendiente la firma con Freighter desde la UI** (extensión de browser, no automatizable headless). El resto quedó probado de punta a punta con el pipeline real del SDK, incluido un **deposit de 1 XLM exitoso en testnet** (tx `f5ec6549...4e3f`, ver "Incidente — parte 2"). **Paso manual restante**: en `localhost:8000`, con la cuenta whitelisteada, click en Deposit y firmar los prompts de Freighter (auth entry + envelope).
2. **El insert de prueba dejó una leaf sintética** en el membership tree (índice 0). Es inofensiva (nadie tiene esa private key) pero existe; si molesta, redeployar deja el árbol limpio.
3. **`aspSecret` se guarda en claro** en `whitelist.json` — aceptable para demo; para producción convendría no persistirlo (solo la leaf) o cifrarlo. Nota: conocer `aspSecret` + `notePublicKey` no permite gastar fondos (eso requiere la note private key), pero sí degradar la privacidad del usuario (vincular su membresía).
4. **Parsing del tx hash**: se extrae con regex del output del stellar CLI (v26.1.0). Si cambia el formato del CLI, ajustar `insertLeafOnChain` en `server/index.js`.
5. **Sin autenticación en los endpoints** — cualquiera con acceso al puerto puede aprobar. Para el demo local está bien; el flujo real lo disparará el webhook de KYC (Bridge) en una tarea futura.
