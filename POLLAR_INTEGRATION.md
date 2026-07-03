# POLLAR_INTEGRATION.md — Integración Pollar + pool USDC

> Fecha: 2026-07-03 · Complementa EXPLORATION.md y WHITELIST.md. API key usada: `pub_testnet_36d86bbde89bf91c62c820d63e445068` (publishable, testnet).

---

## 1. Confirmación de las limitaciones (con citas)

Fuentes: `https://docs.pollar.xyz/llms-full.txt` (descargado 2026-07-03) **y** el paquete instalado `@pollar/core` (`app/node_modules/@pollar/core/dist/index.d.ts`), que resultó ser **más nuevo que las docs publicadas** — hallazgo relevante abajo.

### Limitación 1 — `signMessage`: CONFIRMADA (no existe)

- En `llms-full.txt`, la referencia completa de `@pollar/core` (§ *@pollar/core*: Authentication, Network, Transactions, Wallet Balance, Transaction History, KYC, Ramps, App Config, Types) **no lista ningún método de firma de mensajes arbitrarios**. Los únicos métodos de firma documentados son `signAndSubmitTx` (§ *pollar.signAndSubmitTx(unsignedXdr)*) sobre transacciones.
- En el paquete instalado: `grep -c signMessage dist/index.d.ts` → **0 apariciones** en toda la superficie pública del SDK.
- Consecuencia: no se puede derivar las privacy keys desde una firma de la wallet custodial (el pipeline del app deriva todo de una firma Ed25519 de 64 bytes sobre `"Privacy Pool Key Derivation [v1]"`).

### Limitación 2 — XDR externo y auth entries: CONFIRMADA en las docs, **MATIZADA por el SDK instalado**

Lo que dicen las docs publicadas (`llms-full.txt`):

- § *pollar.signAndSubmitTx(unsignedXdr)*: “Signs and submits a **previously built** transaction. […] **Must be called when `TransactionState.step === 'built'`**” — el único origen documentado del XDR es `state.buildData.unsignedXdr` producido por `buildTx` **en el servidor de Pollar**. No hay soporte documentado para XDR construido externamente.
- § *Security Model → Fee-bump policy enforcement*: el servidor valida “**Asset is in the app's `approved_assets` list**” antes de firmar — una tx Soroban `InvokeHostFunction` contra el pool no es un payment de un asset aprobado.
- § *How the C-Address Lifecycle Works → Signing: full transaction vs auth entries*: la firma de auth entries existe solo en el diseño de **smart wallets (C-addresses)**, sección marcada “🚧 **Upcoming — not yet available**”, y aun ahí es interna a `pay()`, no un primitivo expuesto.
- Para G-addresses (lo disponible): “the user's key signs the **full transaction**, which Pollar then wraps in a fee-bump” — no hay API de auth entries.

**Hallazgo (SDK instalado, más nuevo que las docs)**: `@pollar/core` que baja npm hoy SÍ expone en `PollarClient`:

- `signTx(unsignedXdr): Promise<SignOutcome>` y `submitTx(signedXdr)`.
- `signAuthEntry(entryXdr, { validUntilLedger }): Promise<SignAuthEntryOutcome>` — firma custodial de un `SorobanAuthorizationEntry`. **Pero** el propio `.d.ts` documenta el gate server-side: “Custodial wallets are signed by the backend, which FIRST **validates the entry's invocation tree against the app's contract/function allowlist** and caps the validity window — entries touching a non-allowlisted contract or function […] are rejected.”

Es decir: la capacidad técnica llegó al SDK, pero para usarla con este pool haría falta **allowlistear los contratos del pool para esta app** en el lado de Pollar (no configurable desde el SDK ni verificable sin sesión autenticada), y validar que `/tx/sign` acepte envelopes `InvokeHostFunction` construidos fuera. Por eso la integración usa **modo puente** (abajo), con el camino custodial documentado como próximo paso concreto.

### Verificación de origins/CORS (criterio “si falla el login, documentar”)

Verificado empíricamente contra `https://sdk.api.pollar.xyz/v1/applications/config` con la API key:

- `Origin: http://localhost:8000` → **HTTP 200** (app “pollar private payment”, Google ✅, email ✅). **El login desde la app funciona sin cambios de dashboard.**
- `Origin: http://localhost:3000` o sin Origin → HTTP 403 `ORIGIN_NOT_ALLOWED`.

Si se sirviera la app desde otro origen: agregarlo en **dashboard.pollar.xyz → Configuration → Domains** (docs § *Domains*: “Requests from unlisted origins are rejected”, sin soporte de wildcards).

---

## 2bis. ACTUALIZACIÓN (2026-07-03, tarde): modo custodial REAL con probe automático

El demo del dashboard de Pollar reveló que el backend soporta la operación **`invoke_contract`** (build server-side de invocaciones Soroban con args ScVal en JSON) — y el SDK instalado confirma que `signTx` POSTea **XDR arbitrario construido por el caller** a `/tx/sign` y `signAuthEntry` a `/tx/sign-auth-entry`. Es decir, la capacidad custodial para el pool existe; la única incógnita es la política/allowlist del backend para este contrato, que **solo puede verificarse con una sesión autenticada**.

Implementado en consecuencia (`app/js/wallet-pollar-custodial.js`, nuevo):

- **Probe al conectar** (`probeCustodialSigning`): firma una auth entry descartable que invoca `transact` del pool. Si el backend la firma → **modo custodial**: la cuenta activa es la **wallet Pollar real** y todo se firma con KMS (`custodialSignTransaction` vía `signTx`, `custodialSignAuthEntry` vía `signAuthEntry` con conversión HashIdPreimage→SorobanAuthorizationEntry y extracción de los bytes de firma del entry firmado). Trustlines vía `setTrustline()` del SDK (sponsored). **El bridge keypair no se crea.**
- Si el probe es rechazado → **fallback automático a bridge mode** (comportamiento anterior), con el motivo en la consola (`[Pollar] custodial signing unavailable…`).
- La UI muestra el modo: toast "Pollar custodial signing enabled (KMS)" y "(Pollar wallet, KMS custodial signing)" en Settings.
- Las privacy keys siguen derivándose de entropía local (sigue sin haber `signMessage`) — la entropía está keyed por la G-address de Pollar, así que la `notePublicKey` es la misma en ambos modos y la whitelist no cambia.
- La wallet Pollar del usuario de prueba fue fondeada con 50 XLM para poder depositar en modo custodial.

**Estado**: implementado, pendiente de confirmar el veredicto del probe con una sesión real de browser (requiere login Google interactivo). El resultado queda visible en la consola del browser y en el toast.

## 2. Camino elegido (fallback documentado): identidad real + firma en MODO PUENTE

| Pieza | Estado | Detalle |
|---|---|---|
| Login Google / email OTP | **REAL, con el modal oficial** | El **LoginModal de `@pollar/react`** (branding del Dashboard: Google ✅, email ✅) montado en una isla React mínima (`app/js/pollar-modal.js`, la app no es React) que envuelve con `PollarProvider` el MISMO `PollarClient` que usa el resto del adaptador. Crea/recupera la wallet custodial (G-address, KMS). |
| Sesión, G-address, email | **REAL** | `getAuthState().session.wallet.address`, `getUserProfile().mail`. Mostrados en header y settings. |
| Derivación de privacy keys | **MOCK declarado** | Sin `signMessage`: entropía raíz de 32 bytes (`crypto.getRandomValues`), persistida por identidad Pollar, expandida a los 64 bytes que exige el pipeline WASM (`KeyDerivationSignature`) vía `SHA-512(tag ‖ entropy)`. Mismo pipeline de derivación de ahí en adelante. |
| Firma de pool txs (auth entries + envelope) | **MOCK declarado (BRIDGE MODE)** | Keypair Stellar local generado en el browser (`@stellar/stellar-sdk`), fondeado con friendbot, con trustlines automáticas a los assets classic de los pools. Firma idéntica a Freighter: ed25519 sobre `SHA-256(HashIdPreimage)` para auth entries + firma del envelope. La G-address de Pollar NO custodia fondos del pool. |
| Whitelist ASP | **REAL** | POST automático a `http://localhost:4000/whitelist/request` al terminar la derivación (label = email o G-address). Approve manual. Banner con polling a `GET /whitelist/status/:id`: “Verificación pendiente…” → “Aprobado, ya puedes depositar ✅”. |

Los puntos mock están marcados en el código con `// BRIDGE MODE: mock until Pollar exposes signAuthEntry/signMessage`.

**Trade-off de la entropía local (documentado también en el código)**: las keys NO son re-derivables desde la wallet. Viven en el browser (OPFS SQLite + backup de la entropía en localStorage, keyed por la G-address de Pollar). Borrar el site data pierde las keys y exige re-onboarding + re-approve en la whitelist (la entropía nueva produce otra `notePublicKey`). Con Freighter esto no pasa (misma wallet + misma red ⇒ mismas keys). Roadmap: `signMessage` en Pollar lo resuelve.

### Persistencia entre sesiones

- Sesión Pollar: la persiste el SDK (localStorage).
- Keypair puente: `localStorage["pollarBridge:secret:<G-pollar>"]` → mismo bridge address en cada sesión ⇒ misma fila de keys en la DB OPFS ⇒ mismas privacy keys, sin re-whitelist.
- Entropía raíz: `localStorage["pollarBridge:entropy:<G-pollar>"]`.

---

## 3. Pool USDC (Tarea A)

### Asset usado

**Asset de prueba propio** (no hay issuer de Circle en testnet verificable on-chain y su faucet no es automatizable; un issuer propio permite mintear a las cuentas de prueba):

- Código: `USDC` · Issuer: **`GA33EDAUF3S2T7AB2ZWNQ373YV63JQ3CR5OPKLBV4VVZOFWIHQAPWC3Q`** (identity `pollar-usdc-issuer` en stellar-cli, fondeada por friendbot). Mint = payment desde el issuer.

### Contratos

`deployments/scripts/deploy.sh` **no soporta** agregar un pool a un deployment existente (siempre redeploya ASP/verifier/registry y sobreescribe `deployments.json`). Camino tomado (documentado en la tarea como alternativa válida): deploy **solo del contrato pool** con `stellar contract deploy`, apuntando a los contratos existentes — el ASP, verifier y registry son **los mismos**; la whitelist vale para ambos pools.

| Cosa | Valor |
|---|---|
| Pool USDC | `CBUB4XICKADWNTRG3OYXYQPJ7PSJKARDYXSHAPMJCRBKJJCOCSO44FWD` |
| SAC del asset | `CABOMTKXQF2SHRGU7POBA3DUOMQOV53OVCPRRR4MQPBSQHOJJULMNB2Z` |
| deploymentLedger | `3414942` |
| Constructor | admin `GC3LGF4C…ZPJ6`, verifier `CCA5SMNQ…`, ASP membership `CAM4ED3K…`, ASP non-membership `CCOY5SZE…`, max deposit `1000000000`, levels `10` |

`deployments/testnet/deployments.json` actualizado (2 pools) y frontend recompilado — verificado por `strings` que los WASM servidos embeben `CBUB4XIC…`. El selector de token de la UI se puebla de ese config (`loadRuntimeState` → `[data-pool-select]`, labels vía `Utils.poolLabel`): muestra **XLM** y **USDC**.

### Trustline para depositar USDC

- Cuenta e2e (`GBKYKSN5…`): trustline creada por CLI (tx `2ec7f3ec…`) + 100 USDC minteados (tx `58667c69…`).
- Usuarios Pollar: la trustline del bridge keypair se crea **automáticamente** al conectar (`ensureBridgeTrustlines`).
- Usuarios Freighter (p. ej. `GCT7D6S5…EPIM5E`): paso manual — Freighter → *Manage assets* → *Add asset* con code `USDC` e issuer `GA33EDAU…PWC3Q`; después pedir mint al issuer (`stellar tx new payment --source-account pollar-usdc-issuer --destination <G…> --asset USDC:GA33EDAUF3S2T7AB2ZWNQ373YV63JQ3CR5OPKLBV4VVZOFWIHQAPWC3Q --amount <stroops> --network testnet`).

---

## 4. Deposits verificados (tx hashes)

| Flujo | Tx | Resultado |
|---|---|---|
| Deposit 1 XLM, pool XLM, pipeline real del SDK (mismos crates que el browser) | [`f5ec65499848b4e3f7e5f5f255168f48270a5a50312a302cc5ddec1cec224e3f`](https://stellar.expert/explorer/testnet/tx/f5ec65499848b4e3f7e5f5f255168f48270a5a50312a302cc5ddec1cec224e3f) | ✅ ledger 3414712 |
| **Deposit 1 USDC, pool USDC nuevo, MISMA whitelist (sin re-aprobar)** | [`9e008c1166fc57e0884fb06d818e9395620f1a35247d553f464b12fabc630fcd`](https://stellar.expert/explorer/testnet/tx/9e008c1166fc57e0884fb06d818e9395620f1a35247d553f464b12fabc630fcd) | ✅ ledger 3415140, balance 100→99 USDC |
| Leaf whitelist del usuario e2e (una sola, sirve a ambos pools) | [`9458ac14…3664`](https://stellar.expert/explorer/testnet/tx/9458ac14ccb7974edc95a7ef650cafb16dfd7cb44e0215ba879d5044df0c3664) | ✅ |

El deposit USDC prueba de punta a punta: pool nuevo + SAC propio + **ASP compartido** (root del mismo árbol de membership) + circuito/VK existentes.

**Deposits desde la UI**: el pipeline UI usa exactamente estos mismos crates vía WASM; lo no automatizable headless es (a) el login real de Google/OTP (popup OAuth / inbox) y (b) los clicks. Pasos manuales exactos:

1. `localhost:8000` → **Connect** → “Continue with Pollar” → se abre el **modal oficial de Pollar** (Google / email OTP según Branding & UI del Dashboard) → completar OAuth/OTP.
2. El onboarding deriva keys sin prompts (entropía local) y dispara la whitelist → banner “Verificación pendiente”.
3. Aprobar (manual): `curl -X POST localhost:4000/whitelist/approve -H 'Content-Type: application/json' -d '{"id":"<id del banner o whitelist.json>"}'` → banner “Aprobado, ya puedes depositar ✅”.
4. Selector de token: XLM → deposit 1 XLM (firma automática del bridge, sin popups) → toast con tx hash.
5. Selector de token: USDC → deposit 1 USDC (el bridge ya tiene trustline y hay que mintearle USDC: `stellar tx new payment --source-account pollar-usdc-issuer --destination <bridge G…> --asset USDC:GA33… --amount 100000000 --network testnet`; el bridge address aparece en Settings).
6. Freighter sigue intacto: mismo flujo de siempre en ambos pools (para USDC, antes agregar la trustline en Freighter, ver §3).

---

## 5. Archivos modificados / creados

| Archivo | Cambio |
|---|---|
| `app/js/wallet-pollar.js` | **Nuevo.** Adaptador Pollar: sesión (`waitForPollarAuthenticated` con detección de cancelación), bridge keypair (friendbot + trustlines automáticas), firma bridge (authEntry/tx), entropía de derivación, whitelist request + polling + banner. |
| `app/js/pollar-modal.js` | **Nuevo.** Isla React (sin JSX) que monta `PollarProvider` de `@pollar/react` alrededor del mismo `PollarClient` y expone `openPollarLoginModal()` — el login usa el **modal oficial de Pollar**, no UI casera. CSS servido como `/js/pollar.css` (hook en Trunk.toml). |
| `app/js/wallet.js` | Dispatcher de proveedor (`setWalletProvider`): `getWalletNetwork`, `signWalletAuthEntry`, `signWalletTransaction` y `deriveKeysFromWallet` derivan a Pollar cuando corresponde. Freighter intacto (default). Hook de whitelist automática post-derivación para Pollar. |
| `app/js/ui/navigation.js` | Modal selector de proveedor (Freighter / Google Pollar / Email Pollar), flujo `connect({provider})` para Pollar (login → bridge → trustlines), render de identidad Pollar en header/settings, watcher solo para Freighter, stop del polling al desconectar. |
| `app/package.json` | + `@pollar/core`, `@pollar/react`, `react`, `react-dom`. |
| `deployments/testnet/deployments.json` | + pool USDC (entry `classic:USDC:GA33…`). |
| `server/leaf-cli/src/main.rs` | `e2e-deposit` acepta `[asset_code]` para elegir pool (usado para el deposit USDC headless). |

Sin tocar: contratos y circuitos del proyecto original (el pool USDC es un deploy nuevo del WASM existente con constructor apuntando a los contratos ya deployados), `sdk/`, server endpoints (el `GET /whitelist/status/:id` ya existía).

---

## 6. Qué necesita exponer Pollar para eliminar los mocks

1. **`signMessage(message)` custodial** (firma Ed25519 determinística de un mensaje arbitrario con la key KMS) → elimina la entropía local: keys re-derivables desde la wallet, recuperables en cualquier browser con el mismo login. Es el gap más importante.
2. **Allowlistear los contratos del pool para esta app** (pool XLM `CCK7YAPU…`, pool USDC `CBUB4XIC…`, y el resto del invocation tree: SACs `CDLZFC3S…`/`CABOMTKX…`) para poder usar el **`signAuthEntry(entryXdr, {validUntilLedger})` custodial que el SDK ya trae** — el backend lo rechaza hoy para contratos no allowlisteados. Con esto el usuario firma las auth entries del pool con su key KMS real. Nota de adaptación: el bridge WASM del app entrega el `HashIdPreimage` y espera los bytes de la firma; con Pollar habría que reconstruir el `SorobanAuthorizationEntry` sin firma desde el preimage (JS) y extraer la firma del entry firmado que devuelve Pollar — o que Pollar acepte el preimage directamente.
3. **`signTx`/`submitTx` aceptando envelopes `InvokeHostFunction` construidos externamente** (hoy la política server-side está pensada para payments de `approved_assets`), o un modo “raw XDR” explícito por app. Con (2)+(3), la cuenta fuente de los deposits pasa a ser la G-address custodial y el bridge keypair desaparece.
4. Opcional: patrocinio de fees (fee-bump) para las txs Soroban del pool, que Pollar ya hace para payments.

## 7. Pendientes / advertencias

- El login Pollar desde la UI requiere interacción real (popup OAuth de Google o código OTP por email) — no automatizable headless; todo lo demás del flujo Pollar corre sin prompts (bridge mode firma solo).
- La entropía y el secret del bridge viven en localStorage **en claro** (misma clase de riesgo que la DB OPFS del app, que ya guarda las keys sin cifrar) — aceptable para el POC, no para producción.
- El asset USDC es de prueba (issuer propio); si se cambia al USDC real de Circle habrá que redeployar el pool con ese SAC y conseguir el asset del faucet de Circle.
- `whitelist.json` ahora recibe labels con emails de usuarios Pollar (PII) — mismo criterio demo-only que el resto del server.
