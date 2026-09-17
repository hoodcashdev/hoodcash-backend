import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
  address    TEXT PRIMARY KEY,       -- launched token
  payeeId    TEXT NOT NULL,
  asset      TEXT NOT NULL,          -- pair asset fees are paid in
  launchpad  TEXT NOT NULL,          -- Pons escrow / launchpad
  creator    TEXT,                    -- launcher wallet (deployer)
  createdAt  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payees (
  payeeId    TEXT PRIMARY KEY,
  platform   TEXT NOT NULL,
  handle     TEXT NOT NULL,
  wallet     TEXT,                   -- bound wallet (null until verified + bound)
  boundAt    INTEGER,
  rail       TEXT,                   -- 'bank' | 'xmoney' | 'crypto' (payout destination the launcher chose)
  bankRef    TEXT,                   -- Stripe/Bridge recipient id once the handle owner adds bank details
  payoutHint TEXT                    -- freeform: X Money handle / notes for the operator off-ramp
);

-- OAuth / PKCE + bind sessions
CREATE TABLE IF NOT EXISTS sessions (
  state        TEXT PRIMARY KEY,     -- OAuth state; also the client session token
  codeVerifier TEXT,                 -- PKCE
  platform     TEXT NOT NULL DEFAULT 'x',
  handle       TEXT,                 -- filled after callback
  nonce        TEXT,                 -- signing nonce, filled after callback
  createdAt    INTEGER NOT NULL
);

-- payout ledger: each cash-out we record (and, when Stripe is live, execute)
CREATE TABLE IF NOT EXISTS payouts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payeeId    TEXT NOT NULL,
  handle     TEXT NOT NULL,
  rail       TEXT NOT NULL,          -- bank | xmoney | crypto
  amountWei  TEXT NOT NULL,          -- WETH amount paid out (wei)
  ref        TEXT,                   -- stripe payout id / tx hash / note
  mode       TEXT NOT NULL,          -- stripe | manual | onchain
  status     TEXT NOT NULL,          -- pending | paid | failed
  usdCents   INTEGER,                 -- fiat actually sent (manual X Money / bank), for the public feed
  createdAt  INTEGER NOT NULL
);

-- off-ramp ledger: ETH->Kraken deposits (auto) and USD->X Money ACH (manual)
CREATE TABLE IF NOT EXISTS offramps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,          -- 'deposit' (ETH->Kraken) | 'ach' (USD->X Money)
  amountWei  TEXT,                   -- ETH wei (deposit)
  usdCents   INTEGER,                -- fiat cents (ach)
  dest       TEXT,                   -- 'Kraken' | 'X Money' | address/label
  ref        TEXT,                   -- tx hash (deposit) / note (ach)
  mode       TEXT NOT NULL,          -- 'auto' | 'manual'
  createdAt  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS offramps_ref ON offramps(ref) WHERE ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS meta ( k TEXT PRIMARY KEY, v TEXT );
`);

// ---- lightweight migrations (add columns that older DBs may miss) ----
for (const col of [
  ["payees", "rail", "TEXT"],
  ["payees", "bankRef", "TEXT"],
  ["payees", "payoutHint", "TEXT"],
  ["payouts", "usdCents", "INTEGER"],
  ["tokens", "creator", "TEXT"],
  ["tokens", "logo", "TEXT"],
  ["tokens", "curve", "TEXT"],
] as const) {
  const cols = db.prepare(`PRAGMA table_info(${col[0]})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col[1])) {
    db.exec(`ALTER TABLE ${col[0]} ADD COLUMN ${col[1]} ${col[2]}`);
  }
}

// ---- tokens ----
export function upsertToken(t: { address: string; payeeId: string; asset: string; launchpad: string; creator?: string | null; logo?: string | null; curve?: string | null }) {
  db.prepare(
    `INSERT INTO tokens (address, payeeId, asset, launchpad, creator, logo, curve, createdAt)
     VALUES (@address, @payeeId, @asset, @launchpad, @creator, @logo, @curve, @createdAt)
     ON CONFLICT(address) DO UPDATE SET payeeId=excluded.payeeId, asset=excluded.asset, launchpad=excluded.launchpad, creator=COALESCE(excluded.creator, tokens.creator), logo=COALESCE(excluded.logo, tokens.logo), curve=COALESCE(excluded.curve, tokens.curve)`,
  ).run({ creator: null, logo: null, curve: null, ...t, address: t.address.toLowerCase(), createdAt: Date.now() });
}
export function allTokens(): { address: string; payeeId: string; asset: string; launchpad: string; creator?: string; logo?: string; curve?: string }[] {
  return db.prepare(`SELECT address, payeeId, asset, launchpad, creator, logo, curve, createdAt FROM tokens ORDER BY createdAt DESC`).all() as any[];
}
export function tokensForPayee(payeeId: string) {
  return db.prepare(`SELECT address, payeeId, asset, launchpad FROM tokens WHERE payeeId = ?`).all(payeeId) as any[];
}

// ---- payees ----
export function upsertPayee(p: { payeeId: string; platform: string; handle: string; rail?: string }) {
  db.prepare(
    `INSERT INTO payees (payeeId, platform, handle, rail) VALUES (@payeeId, @platform, @handle, @rail)
     ON CONFLICT(payeeId) DO UPDATE SET platform=excluded.platform, handle=excluded.handle,
       rail=COALESCE(excluded.rail, payees.rail)`,
  ).run({ rail: null, ...p });
}
export function setPayeeRail(payeeId: string, rail: string) {
  db.prepare(`UPDATE payees SET rail = ? WHERE payeeId = ?`).run(rail, payeeId);
}
export function setPayeeBank(payeeId: string, bankRef: string, hint?: string) {
  db.prepare(`UPDATE payees SET bankRef = ?, payoutHint = COALESCE(?, payoutHint) WHERE payeeId = ?`)
    .run(bankRef, hint ?? null, payeeId);
}
export function setPayeeWallet(payeeId: string, wallet: string) {
  db.prepare(`UPDATE payees SET wallet = ?, boundAt = ? WHERE payeeId = ?`).run(wallet, Date.now(), payeeId);
}
export function getPayee(payeeId: string) {
  return db.prepare(`SELECT payeeId, platform, handle, wallet, rail, bankRef, payoutHint FROM payees WHERE payeeId = ?`).get(payeeId) as
    | { payeeId: string; platform: string; handle: string; wallet: string | null; rail: string | null; bankRef: string | null; payoutHint: string | null }
    | undefined;
}
export function allPayees() {
  return db.prepare(`SELECT payeeId, platform, handle, wallet, rail, bankRef, payoutHint FROM payees`).all() as any[];
}

// ---- payouts ----
export function recordPayout(p: {
  payeeId: string; handle: string; rail: string; amountWei: string;
  ref: string | null; mode: string; status: string; usdCents?: number | null;
}) {
  const r = db.prepare(
    `INSERT INTO payouts (payeeId, handle, rail, amountWei, ref, mode, status, usdCents, createdAt)
     VALUES (@payeeId, @handle, @rail, @amountWei, @ref, @mode, @status, @usdCents, @createdAt)`,
  ).run({ usdCents: null, ...p, createdAt: Date.now() });
  return r.lastInsertRowid as number;
}

/** Totals for the public Payments panel: fiat paid + count, split by rail. */
export function payoutStats() {
  const rows = db.prepare(
    `SELECT rail, COUNT(*) AS n, COALESCE(SUM(usdCents),0) AS cents
     FROM payouts WHERE status = 'paid' GROUP BY rail`,
  ).all() as { rail: string; n: number; cents: number }[];
  const out: Record<string, { count: number; usdCents: number }> = {};
  for (const r of rows) out[r.rail] = { count: r.n, usdCents: r.cents };
  return out;
}

/** First available coin photo for a payee (for the payments feed). */
export function logoForPayee(payeeId: string): string | null {
  const r = db.prepare(`SELECT logo FROM tokens WHERE payeeId=? AND logo IS NOT NULL ORDER BY createdAt DESC LIMIT 1`).get(payeeId) as { logo?: string } | undefined;
  return r?.logo ?? null;
}

/** Lifetime wei paid out to a payee (for per-coin "fees collected"). */
export function paidWeiForPayee(payeeId: string): bigint {
  const rows = db.prepare(`SELECT amountWei FROM payouts WHERE payeeId=? AND status='paid'`).all(payeeId) as { amountWei: string }[];
  let sum = 0n; for (const r of rows) { try { sum += BigInt(r.amountWei); } catch {} }
  return sum;
}

/** Flip a pending payout to paid (after a manual X Money / bank send). */
export function setPayoutPaid(id: number, ref: string | null, usdCents: number | null) {
  return db.prepare(`UPDATE payouts SET status='paid', ref=COALESCE(?,ref), usdCents=COALESCE(?,usdCents) WHERE id=?`)
    .run(ref, usdCents, id).changes;
}
export function getPayout(id: number) {
  return db.prepare(`SELECT * FROM payouts WHERE id=?`).get(id) as any | undefined;
}
export function recentPayouts(limit = 50) {
  return db.prepare(`SELECT * FROM payouts ORDER BY id DESC LIMIT ?`).all(limit) as any[];
}

// ---- off-ramp ----
export function recordOfframp(o: {
  kind: string; amountWei?: string | null; usdCents?: number | null;
  dest?: string | null; ref?: string | null; mode: string;
}) {
  try {
    const r = db.prepare(
      `INSERT INTO offramps (kind, amountWei, usdCents, dest, ref, mode, createdAt)
       VALUES (@kind, @amountWei, @usdCents, @dest, @ref, @mode, @createdAt)`,
    ).run({ amountWei: null, usdCents: null, dest: null, ref: null, ...o, createdAt: Date.now() });
    return r.lastInsertRowid as number;
  } catch (e: any) {
    if (String(e?.message || e).includes("UNIQUE")) return -1; // already logged (auto dedupe by ref)
    throw e;
  }
}
export function recentOfframps(limit = 60) {
  return db.prepare(`SELECT * FROM offramps ORDER BY id DESC LIMIT ?`).all(limit) as any[];
}

// ---- sessions ----
export function newSession(codeVerifier: string, platform = "x"): string {
  const state = randomBytes(24).toString("hex");
  db.prepare(
    `INSERT INTO sessions (state, codeVerifier, platform, createdAt) VALUES (?, ?, ?, ?)`,
  ).run(state, codeVerifier, platform, Date.now());
  return state;
}
export function getSession(state: string) {
  return db.prepare(`SELECT * FROM sessions WHERE state = ?`).get(state) as
    | { state: string; codeVerifier: string; platform: string; handle: string | null; nonce: string | null; createdAt: number }
    | undefined;
}
export function completeSession(state: string, handle: string, nonce: string) {
  db.prepare(`UPDATE sessions SET handle = ?, nonce = ? WHERE state = ?`).run(handle, nonce, state);
}

// ---- meta (event backfill cursor) ----
export function getMeta(k: string): string | undefined {
  const r = db.prepare(`SELECT v FROM meta WHERE k = ?`).get(k) as { v: string } | undefined;
  return r?.v;
}
export function setMeta(k: string, v: string) {
  db.prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v);
}
