import { Router } from "express";
import { formatUnits, getAddress, isAddress } from "viem";
import { config } from "../config.js";
import { publicClient } from "../chain.js";
import { registryAbi, routerAbi, allocationsAbi, erc20Abi } from "../abi.js";
import { tokensForPayee } from "../db.js";
import { payeeId as computeId } from "../payee.js";

export const claimablesRouter = Router();

const metaCache = new Map<string, { symbol: string; decimals: number }>();
async function tokenMeta(addr: `0x${string}`) {
  const key = addr.toLowerCase();
  const hit = metaCache.get(key);
  if (hit) return hit;
  let symbol = "?", decimals = 18;
  try { symbol = (await publicClient.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" })) as string; } catch {}
  try { decimals = Number(await publicClient.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" })); } catch {}
  const m = { symbol, decimals };
  metaCache.set(key, m);
  return m;
}

/**
 * GET /claimables?platform=x&handle=foo   (or ?payeeId=0x..)
 * Returns everything waiting for a handle: routed fees + supply allocations, and whether
 * they've connected a wallet yet.
 */
claimablesRouter.get("/", async (req, res) => {
  try {
    const { platform = "x", handle, payeeId } = req.query as Record<string, string>;
    const pid = (payeeId as `0x${string}`) ?? (handle ? computeId(platform, handle) : undefined);
    if (!pid) return res.status(400).json({ error: "provide handle or payeeId" });

    const wallet = (await publicClient.readContract({
      address: config.registry, abi: registryAbi, functionName: "walletOf", args: [pid],
    })) as `0x${string}`;
    const connected = wallet !== "0x0000000000000000000000000000000000000000";

    const tokens = tokensForPayee(pid);

    // Fees are booked per (payee, asset). Collect the distinct assets across this payee's tokens.
    const assets = Array.from(new Set(tokens.map((t) => getAddress(t.asset))));
    const fees = await Promise.all(assets.map(async (asset) => {
      const amount = (await publicClient.readContract({
        address: config.router, abi: routerAbi, functionName: "claimable", args: [pid],
      })) as bigint;
      const { symbol, decimals } = await tokenMeta(asset);
      return { asset, symbol, amount: amount.toString(), display: formatUnits(amount, decimals) };
    }));

    // Allocations are per (token, payee).
    const allocations = await Promise.all(tokens.map(async (t) => {
      const token = getAddress(t.address);
      const [amount, claimable] = (await publicClient.readContract({
        address: config.allocations, abi: allocationsAbi, functionName: "pending", args: [token, pid],
      })) as [bigint, boolean];
      const { symbol, decimals } = await tokenMeta(token);
      return { token, symbol, amount: amount.toString(), display: formatUnits(amount, decimals), claimable };
    }));

    return res.json({
      payeeId: pid,
      connected,
      wallet: connected ? wallet : null,
      fees: fees.filter((f) => f.amount !== "0"),
      allocations: allocations.filter((a) => a.amount !== "0"),
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});
