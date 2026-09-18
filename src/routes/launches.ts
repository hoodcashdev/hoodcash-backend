import { Router, type Request, type Response, type NextFunction } from "express";
import { getAddress, isAddress } from "viem";
import { config } from "../config.js";
import { publicClient } from "../chain.js";
import { erc20Abi } from "../abi.js";
import { upsertToken, upsertPayee, allTokens, getPayee, paidWeiForPayee } from "../db.js";
import { payeeId } from "../payee.js";

export const launchesRouter = Router();

function adminOnly(req: Request, res: Response, next: NextFunction) {
  const auth = req.header("authorization") ?? "";
  if (auth !== `Bearer ${config.adminToken}`) return res.status(401).json({ error: "unauthorized" });
  next();
}

const RAILS = new Set(["bank", "xmoney", "crypto"]);

/**
 * Register a token on the Router so the collector sweeps its fees, and record which handle +
 * rail the launcher chose. Idempotent — a token already registered on-chain is treated as ok.
 * For custodial rails (bank / X Money) we bind the payee to the operator custody wallet so the
 * keeper can pushPayout and off-ramp; for the crypto rail the creator binds their own wallet
 * later via X OAuth.
 */
async function register(opts: { token: string; handle: string; platform: string; rail: string; creator?: string; logo?: string; curve?: string }) {
  const asset = config.defaultPairAsset;
  const pad = config.defaultLaunchpad;
  const tokenAddr = getAddress(opts.token);
  const pid = payeeId(opts.platform, opts.handle);
  // Wallet-recipient model: creator fees route to config.collector (a wallet we control) and
  // pile up as one aggregate pool in the Pons escrow. No on-chain registration/binding needed —
  // we just record the token + handle so the dashboard can show it and attribute off-chain.
  upsertPayee({ payeeId: pid, platform: opts.platform, handle: opts.handle.replace(/^@/, ""), rail: opts.rail });
  upsertToken({ address: tokenAddr, payeeId: pid, asset, launchpad: pad, creator: opts.creator ?? null, logo: opts.logo ?? null, curve: opts.curve ?? null });
  return { token: tokenAddr, payeeId: pid, asset, launchpad: pad, rail: opts.rail };
}

/**
 * PUBLIC endpoint the frontend calls right after a Pons launch. We only accept it if the token's
 * fees actually redirect to our Router on-chain — so an untrusted caller can't register someone
 * else's token or point fees anywhere but us.
 * Body: { token, handle, rail, platform?, creator?, tx? }
 */
launchesRouter.post("/submit", async (req, res) => {
  try {
    const { token, handle, rail = "bank", platform = "x" } = req.body ?? {};
    if (!token || !isAddress(token)) return res.status(400).json({ error: "bad token address" });
    if (!handle || typeof handle !== "string") return res.status(400).json({ error: "missing handle" });
    if (!RAILS.has(rail)) return res.status(400).json({ error: "bad rail" });

    const tokenAddr = getAddress(token);
    const { creator, logo, curve } = req.body ?? {};

    // on-chain proof (Pons V2): the launch's creatorFeeRecipient must be our Router.
    // V2 factory.getLaunchedToken(token) returns a struct whose word[3] is creatorFeeRecipient.
    let recip = "";
    try {
      const data = ("0x3cf28b5a" + tokenAddr.slice(2).toLowerCase().padStart(64, "0")) as `0x${string}`;
      const r = await publicClient.call({ to: config.ponsFactory, data });
      const raw = r.data ?? "";
      if (raw.length >= 2 + 4 * 64) recip = "0x" + raw.slice(2 + 3 * 64 + 24, 2 + 4 * 64);
    } catch { /* not found / reverted */ }
    if (!recip || recip.toLowerCase() !== config.collector.toLowerCase()) {
      return res.status(400).json({ error: "fees are not routed to HoodCash (creatorFeeRecipient != Router)" });
    }

    const out = await register({ token: tokenAddr, handle, platform, rail, creator, logo, curve });
    return res.json({ ok: true, verified: true, ...out });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

/** Public: the current creator-fee recipient. The frontend reads this at launch time
 *  so a stale/cached page can never bake in an old address. */
launchesRouter.get("/config", (_req, res) => {
  return res.json({ ok: true, feeRecipient: config.collector, escrow: config.feeEscrow });
});

/** Public: registered HoodCash tokens (for the Top-tokens feed). */
const metaMemo = new Map<string, { name: string; symbol: string }>(); // immutable, cache forever
let listCache: { at: number; body: any } | null = null;
const LIST_TTL = 20_000;
// Per-token lifetime creator fees, from Pons's own market API (earnedForToken, in wei of the quote asset).
// Cached per token; Pons is the source of truth for what a coin has generated across sweeps.
const feesMemo = new Map<string, { at: number; wei: string }>();
const FEES_TTL = 60_000;
async function ponsEarnedWei(token: string): Promise<string> {
  const key = token.toLowerCase();
  const hit = feesMemo.get(key);
  if (hit && Date.now() - hit.at < FEES_TTL) return hit.wei;
  try {
    const r = await fetch(`https://www.ponsfamily.com/api/pons-v2-market/${token}/creator-fees`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const j: any = await r.json();
      const wei = String(j?.earnedForToken ?? "0");
      feesMemo.set(key, { at: Date.now(), wei });
      return wei;
    }
  } catch {}
  if (hit) return hit.wei; // serve stale on error
  feesMemo.set(key, { at: Date.now(), wei: "0" });
  return "0";
}

// Server-side ETH/USD price (Coinbase -> CoinGecko), cached — so the site never depends on the
// visitor's own network to convert fees to USD.
let ethPx: { at: number; usd: number } | null = null;
const PX_TTL = 60_000;
async function ethUsdServer(): Promise<number | null> {
  if (ethPx && Date.now() - ethPx.at < PX_TTL) return ethPx.usd;
  const srcs: [string, (j: any) => any][] = [
    ["https://api.coinbase.com/v2/prices/ETH-USD/spot", (j) => j?.data?.amount],
    ["https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", (j) => j?.ethereum?.usd],
  ];
  for (const [url, pick] of srcs) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const v = Number(pick(await r.json()));
      if (v > 0) { ethPx = { at: Date.now(), usd: v }; return v; }
    } catch {}
  }
  return ethPx ? ethPx.usd : null; // last-good, or null
}

// Live market cap per token from Pons's trade data (last trade price x fixed 1e9 supply x ETH/USD).
// Works for curve and graduated coins; matches how Pons derives a coin's market cap. Cached per token.
const mcMemo = new Map<string, { at: number; mc: number | null }>();
const MC_TTL = 60_000;
async function ponsMarketCapUsd(token: string, eu: number | null): Promise<number | null> {
  if (eu == null) return null;
  const key = token.toLowerCase();
  const hit = mcMemo.get(key);
  if (hit && Date.now() - hit.at < MC_TTL) return hit.mc;
  try {
    const r = await fetch(`https://www.ponsfamily.com/api/pons-v2-market/${token}/trades`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const j: any = await r.json();
      const t0 = Array.isArray(j?.trades) ? j.trades[0] : null; // most recent trade
      if (t0 && t0.quoteAmount && t0.tokenAmount && Number(t0.tokenAmount) > 0) {
        const priceEth = Number(t0.quoteAmount) / Number(t0.tokenAmount); // ETH per token
        const mc = priceEth * 1e9 * eu; // fixed 1,000,000,000 supply
        mcMemo.set(key, { at: Date.now(), mc });
        return mc;
      }
      mcMemo.set(key, { at: Date.now(), mc: null }); // no trades -> no market yet
      return null;
    }
  } catch {}
  return hit ? hit.mc : null;
}
launchesRouter.get("/list", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (listCache && Date.now() - listCache.at < LIST_TTL) return res.json(listCache.body);
    const toks = allTokens().slice(0, 60);
    const eu = await ethUsdServer();
    const tokens = await Promise.all(toks.map(async (t) => {
      let meta = metaMemo.get(t.address);
      if (!meta) {
        let name = "", symbol = "?";
        try { symbol = (await publicClient.readContract({ address: t.address as `0x${string}`, abi: erc20Abi, functionName: "symbol" })) as string; } catch {}
        try { name = (await publicClient.readContract({ address: t.address as `0x${string}`, abi: erc20Abi, functionName: "name" })) as string; } catch {}
        meta = { name, symbol };
        if (name || symbol !== "?") metaMemo.set(t.address, meta); // only cache once resolved
      }
      const p = getPayee(t.payeeId);
      const feesWei = paidWeiForPayee(t.payeeId);
      const [feesEarnedWei, marketCapUsd] = await Promise.all([ponsEarnedWei(t.address), ponsMarketCapUsd(t.address, eu)]);
      return { token: t.address, symbol: meta.symbol, name: meta.name, handle: p?.handle ?? null, creator: t.creator ?? null, logo: (t as any).logo ?? null, curve: (t as any).curve ?? null, feesWei: feesWei.toString(), feesEarnedWei, feesEarnedUsd: (eu != null ? (Number(feesEarnedWei) / 1e18) * eu : null), marketCapUsd, createdAt: (t as any).createdAt ?? null };
    }));
    const body = { ok: true, ethUsd: eu, tokens };
    listCache = { at: Date.now(), body };
    return res.json(body);
  } catch (e: any) {
    if (listCache) return res.json(listCache.body); // serve stale on RPC hiccup
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

/** Admin variant — register without the on-chain check (manual backfill / trusted ops). */
launchesRouter.post("/", adminOnly, async (req, res) => {
  try {
    const { token, handle, platform = "x", rail = "bank", creator, logo, curve } = req.body ?? {};
    if (!token || !isAddress(token)) return res.status(400).json({ error: "bad token address" });
    if (!handle) return res.status(400).json({ error: "missing handle" });
    const out = await register({ token, handle, platform, rail, creator, logo, curve });
    return res.json({ ok: true, ...out });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});
