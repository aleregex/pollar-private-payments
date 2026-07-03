// Minimal ASP whitelist backend.
//
// Flow: users submit their note public key + ASP secret (as shown by the pool
// app onboarding); an operator approves a request, which derives the ASP
// membership leaf (same algorithm as app/admin.html, via the asp-leaf-cli Rust
// binary) and inserts it on-chain with the admin identity through the stellar
// CLI.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

const execFileAsync = promisify(execFile);
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SERVER_DIR, '..');

dotenv.config({ path: resolve(SERVER_DIR, '.env') });

const PORT = Number(process.env.PORT || 4000);
const NETWORK = process.env.STELLAR_NETWORK || 'testnet';
// Identity name from `stellar keys ls`, or a raw S... secret key. Never committed.
const ADMIN_SOURCE = process.env.STELLAR_ADMIN_IDENTITY || process.env.STELLAR_ADMIN_SECRET;
const STELLAR_BIN = process.env.STELLAR_BIN || 'stellar';
const LEAF_CLI = process.env.LEAF_CLI || resolve(REPO_ROOT, 'target/release/asp-leaf-cli');
const DATA_FILE = process.env.DATA_FILE || resolve(SERVER_DIR, 'whitelist.json');
const ALLOWED_ORIGINS = ['http://localhost:8000', 'http://localhost:3000'];

if (!ADMIN_SOURCE) {
  console.error('Missing STELLAR_ADMIN_IDENTITY (or STELLAR_ADMIN_SECRET) in server/.env');
  process.exit(1);
}

// ASP membership contract address comes from the deployment manifest, never hardcoded.
const deployments = JSON.parse(
  readFileSync(resolve(REPO_ROOT, `deployments/${NETWORK}/deployments.json`), 'utf8'),
);
const ASP_MEMBERSHIP_CONTRACT = deployments.asp_membership;
if (!ASP_MEMBERSHIP_CONTRACT) {
  console.error(`asp_membership missing in deployments/${NETWORK}/deployments.json`);
  process.exit(1);
}

// -----------------------------
// Storage: single JSON file
// -----------------------------

function loadRecords() {
  if (!existsSync(DATA_FILE)) return [];
  return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
}

function saveRecords(records) {
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, DATA_FILE);
}

// -----------------------------
// Input canonicalization
// -----------------------------

// Replicates parseBigIntInput + the 0x/padStart(64) normalization from
// app/js/admin.js (computeMembershipLeaf): accepts hex (0x...) or decimal,
// returns the canonical 0x + 64-hex form the WASM bridge receives.
function canonicalize(value, label) {
  const trimmed = (value ?? '').toString().trim();
  if (!trimmed) throw new Error(`${label} is required`);
  let parsed;
  try {
    parsed = BigInt(trimmed);
  } catch {
    throw new Error(`${label} must be a hex or decimal integer`);
  }
  if (parsed < 0n) throw new Error(`${label} must be non-negative`);
  const hex = parsed.toString(16);
  if (hex.length > 64) throw new Error(`${label} does not fit into 256 bits`);
  return `0x${hex.padStart(64, '0')}`;
}

// -----------------------------
// Leaf derivation + on-chain insert
// -----------------------------

async function deriveLeaf(notePublicKey, aspSecret) {
  const { stdout } = await execFileAsync(LEAF_CLI, ['leaf', notePublicKey, aspSecret]);
  return JSON.parse(stdout);
}

async function insertLeafOnChain(leafDec) {
  const args = [
    'contract', 'invoke',
    '--id', ASP_MEMBERSHIP_CONTRACT,
    '--source-account', ADMIN_SOURCE,
    '--network', NETWORK,
    '--',
    'insert_leaf',
    '--leaf', leafDec,
  ];
  const { stdout, stderr } = await execFileAsync(STELLAR_BIN, args, { timeout: 120_000 });
  const combined = `${stderr}\n${stdout}`;
  const hashMatch = combined.match(/\b[a-f0-9]{64}\b/i);
  return { txHash: hashMatch ? hashMatch[0] : null, rawOutput: combined.trim() };
}

// -----------------------------
// HTTP API
// -----------------------------

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

app.post('/whitelist/request', (req, res) => {
  try {
    const { notePublicKey, aspSecret, label } = req.body ?? {};
    if (!label || !String(label).trim()) throw new Error('label is required');
    const canonicalKey = canonicalize(notePublicKey, 'notePublicKey');
    const canonicalSecret = canonicalize(aspSecret, 'aspSecret');

    const records = loadRecords();
    if (records.some((r) => r.notePublicKey === canonicalKey)) {
      return res.status(409).json({ error: 'notePublicKey already registered' });
    }

    const record = {
      id: randomUUID(),
      notePublicKey: canonicalKey,
      aspSecret: canonicalSecret,
      label: String(label).trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    records.push(record);
    saveRecords(records);
    res.status(201).json({ id: record.id, status: record.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/whitelist/approve', async (req, res) => {
  const { id, notePublicKey } = req.body ?? {};
  if (!id && !notePublicKey) {
    return res.status(400).json({ error: 'id or notePublicKey is required' });
  }

  const records = loadRecords();
  let record;
  try {
    record = id
      ? records.find((r) => r.id === id)
      : records.find((r) => r.notePublicKey === canonicalize(notePublicKey, 'notePublicKey'));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!record) return res.status(404).json({ error: 'record not found' });
  if (record.status === 'approved') {
    return res.status(409).json({ error: 'already approved', id: record.id, txHash: record.txHash });
  }

  try {
    const { leafHex, leafDec } = await deriveLeaf(record.notePublicKey, record.aspSecret);
    const { txHash, rawOutput } = await insertLeafOnChain(leafDec);

    record.status = 'approved';
    record.leafHex = leafHex;
    record.leafDec = leafDec;
    record.txHash = txHash;
    record.approvedAt = new Date().toISOString();
    delete record.lastError;
    saveRecords(records);

    console.log(`approved ${record.id} (${record.label}) leaf=${leafHex} tx=${txHash}`);
    if (!txHash) console.warn('insert succeeded but no tx hash parsed from CLI output:', rawOutput);
    res.json({ id: record.id, status: record.status, txHash });
  } catch (err) {
    // Insert failed: keep the record pending and surface the exact error.
    const detail = err.stderr ? `${err.message}\n${err.stderr}` : err.message;
    record.lastError = { at: new Date().toISOString(), detail };
    saveRecords(records);
    res.status(502).json({ error: 'on-chain insert failed', detail, id: record.id, status: record.status });
  }
});

app.get('/whitelist/status/:id', (req, res) => {
  const record = loadRecords().find((r) => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'record not found' });
  const { id, label, status, txHash } = record;
  res.json({ id, label, status, ...(txHash ? { txHash } : {}) });
});

app.get('/whitelist/list', (_req, res) => {
  res.json(loadRecords());
});

app.listen(PORT, () => {
  console.log(`whitelist server on http://localhost:${PORT}`);
  console.log(`network=${NETWORK} aspMembership=${ASP_MEMBERSHIP_CONTRACT} admin=${ADMIN_SOURCE}`);
});
