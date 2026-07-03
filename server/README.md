# Whitelist server (ASP membership backend)

Backend mínimo que gestiona solicitudes de whitelist y, al aprobarlas, deriva la leaf del ASP membership tree e invoca `insert_leaf` on-chain firmando con la cuenta ASP admin.

- **Stack**: Node.js + Express (JS plano, ESM). Storage: `whitelist.json` (gitignored).
- **Derivación de leaf**: subprocess al binario Rust `asp-leaf-cli` (`server/leaf-cli/`), que llama a `prover::crypto::asp_membership_leaf` — exactamente la misma función que usa `app/admin.html` vía WASM. `leaf = Poseidon2(notePublicKey, aspSecret, domain=1)` sobre BN254.
- **Insert on-chain**: subprocess al `stellar` CLI (`stellar contract invoke ... -- insert_leaf --leaf <dec>`).
- El address del contrato ASP Membership se lee de `deployments/<network>/deployments.json`.

## Requisitos

- Node ≥ 20, `stellar` CLI en PATH con la identity admin configurada (`stellar keys ls`).
- Binario de derivación compilado: desde la raíz del repo `cargo build -p asp-leaf-cli --release` (queda en `target/release/asp-leaf-cli`).

## Correr

```bash
cd server
cp .env.example .env   # ajusta identity/puerto si hace falta
npm install
npm run dev            # o npm start
```

## Variables de entorno (`.env`)

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `4000` | Puerto HTTP |
| `STELLAR_NETWORK` | `testnet` | Red; determina qué `deployments.json` se lee |
| `STELLAR_ADMIN_IDENTITY` | — | Nombre de identity en stellar-cli (ej. `pollar-asp-admin`) |
| `STELLAR_ADMIN_SECRET` | — | Alternativa: secret key S... (no la commitees) |
| `STELLAR_BIN` | `stellar` | Binario del CLI |
| `LEAF_CLI` | `../target/release/asp-leaf-cli` | Binario de derivación |
| `DATA_FILE` | `./whitelist.json` | Archivo de datos |

CORS habilitado para `http://localhost:8000` y `http://localhost:3000`.

## Endpoints

### POST /whitelist/request

```bash
curl -X POST http://localhost:4000/whitelist/request \
  -H 'Content-Type: application/json' \
  -d '{"notePublicKey":"0x85a8...7d06","aspSecret":"0x0000...777c","label":"alice@example.com"}'
# → {"id":"<uuid>","status":"pending"}
```

`notePublicKey` y `aspSecret` aceptan hex `0x...` o decimal (igual que admin.html); se normalizan a `0x` + 64 hex. Duplicados por `notePublicKey` → 409.

### POST /whitelist/approve

```bash
curl -X POST http://localhost:4000/whitelist/approve \
  -H 'Content-Type: application/json' \
  -d '{"id":"<uuid>"}'          # o {"notePublicKey":"0x..."}
# → {"id":"<uuid>","status":"approved","txHash":"<hash>"}
```

Deriva la leaf, ejecuta `insert_leaf` firmado por el admin y guarda el `txHash`. Si el insert falla, el registro queda `pending` y responde 502 con el error exacto en `detail`.

### GET /whitelist/status/:id

```bash
curl http://localhost:4000/whitelist/status/<uuid>
# → {"id","label","status","txHash"?}
```

### GET /whitelist/list

```bash
curl http://localhost:4000/whitelist/list
```

## Utilidad: usuario de prueba

Para tests sin browser, el CLI genera un usuario sintético con la misma derivación que el onboarding de la app (firma de 64 bytes aleatoria → keys):

```bash
../target/release/asp-leaf-cli test-user testnet
# → {"notePublicKey":"0x...","aspSecret":"0x..."}
```

## Utilidad: verificación headless de membresía

Reproduce el check exacto de la app (indexer del SDK + `check_asp_membership_precondition`) contra la red. Útil para soporte cuando un usuario reporta "not registered with the ASP" pese a estar aprobado:

```bash
../target/release/asp-leaf-cli check-membership <notePublicKey> <aspSecret> \
  [deployments/testnet/deployments.json] [https://soroban-testnet.stellar.org]
# → {"leafHex":"0x...","chainRoot":"0x...","chainLedger":N,"status":"UserIndex(i)"}
# status: UserIndex(i) = OK (leaf en el árbol, índice i) · RegisterAtASP = leaf ausente ·
#         SyncRequired(gap) = RPC/indexer atrasado
```

Si devuelve `UserIndex` pero el usuario sigue viendo el error, su browser corre un build viejo de la app (direcciones de contratos embebidas en compile-time): hard-reload de la pestaña. Ver WHITELIST.md § Incidente 2026-07-03.
