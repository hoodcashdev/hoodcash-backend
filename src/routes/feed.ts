import { Router } from "express";
import { formatUnits, getAddress } from "viem";
import { config } from "../config.js";
import { publicClient } from "../chain.js";
import { routerAbi, erc20Abi } from "../abi.js";
import { getPayee } from "../db.js";

export const feedRouter = Router();

const RANGE = 9_000n;   // getLogs window
const LIMIT = 40;       // recent rows returned

// token/asset metadata cache
const meta = new Map<string, { symbol: string; decimals: number }>();
async function tokenMeta(addr: `0x${string}`) {
  const k = addr.toLowerCase();
  const hit = meta.get(k);
  if (hit) return hit;
  let symbol = "?", decimals = 18;
  try { symbol = (await publicClient.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" })) as string; } catch {}
  try { decimals = Number(await publicClient.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" })); } catch {}
  const m = { symbol, decimals };
  meta.set(k, m);
  return m;
}

function handleFor(payeeId: string): string | null {
  return getPayee(payeeId)?.handle ?? null;
}

/**
 * GET /feed — the public payout stream.
 * Scans FeesRouted events backward from the chain head and returns the most recent payouts
 * plus a top-accounts leaderboard aggregated over the scanned window.
 */
feedRouter.get("/", async (_req, res) => {
  try {
    const latest = await publicClient.getBlockNumber();
    const floor = config.deployBlock > latest - config.feedLookbackBlocks
      ? config.deployBlock
      : latest - config.feedLookbackBlocks;

    type Log = { token: `0x${string}`; payeeId: `0x${string}`; asset: `0x${string}`; toPayee: bigint; block: bigint };
    const logs: Log[] = [];

    let to = latest;
    while (to >= floor && logs.length < LIMIT * 3) {
      const from = to - RANGE + 1n > floor ? to - RANGE + 1n : floor;
      const chunk = await publicClient.getContractEvents({
        address: config.router, abi: routerAbi, eventName: "FeesRouted", fromBlock: from, toBlock: to,
      });
      for (const l of chunk) {
        const a = l.args as { token?: `0x${string}`; payeeId?: `0x${string}`; asset?: `0x${string}`; toPayee?: bigint };
        if (a.token && a.payeeId && a.asset && a.toPayee !== undefined) {
          logs.push({ token: a.token, payeeId: a.payeeId, asset: a.asset, toPayee: a.toPayee, block: l.blockNumber! });
        }
      }
      if (from === floor) break;
      to = from - 1n;
    }

    logs.sort((x, y) => Number(y.block - x.block));

    // block timestamps for the rows we return
    const recentLogs = logs.slice(0, LIMIT);
    const uniqueBlocks = Array.from(new Set(recentLogs.map((l) => l.block)));
    const tsByBlock = new Map<bigint, number>();
    await Promise.all(uniqueBlocks.map(async (b) => {
      try { const blk = await publicClient.getBlock({ blockNumber: b }); tsByBlock.set(b, Number(blk.timestamp)); } catch {}
    }));

    const recent = await Promise.all(recentLogs.map(async (l) => {
      const { symbol, decimals } = await tokenMeta(l.asset);
      return {
        payeeId: l.payeeId,
        handle: handleFor(l.payeeId),
        asset: l.asset,
        symbol,
        amount: l.toPayee.toString(),
        display: formatUnits(l.toPayee, decimals),
        block: Number(l.block),
        timestamp: tsByBlock.get(l.block) ?? null,
      };
    }));

    // leaderboard aggregated over the scanned window (per payee, in its asset)
    const totals = new Map<string, { payeeId: `0x${string}`; asset: `0x${string}`; sum: bigint }>();
    for (const l of logs) {
      const key = l.payeeId;
      const cur = totals.get(key) ?? { payeeId: l.payeeId, asset: l.asset, sum: 0n };
      cur.sum += l.toPayee;
      totals.set(key, cur);
    }
    const topAccounts = await Promise.all(
      Array.from(totals.values()).sort((a, b) => (b.sum > a.sum ? 1 : -1)).slice(0, 6).map(async (t) => {
        const { symbol, decimals } = await tokenMeta(t.asset);
        return { payeeId: t.payeeId, handle: handleFor(t.payeeId), symbol, total: t.sum.toString(), display: formatUnits(t.sum, decimals) };
      }),
    );

    res.json({ recent, topAccounts, scannedFrom: Number(floor), scannedTo: Number(latest), count: logs.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});
