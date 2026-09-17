import { getAddress } from "viem";
import { config } from "../config.js";
import { publicClient, walletClient, sendAndWait } from "../chain.js";
import { routerAbi, registryAbi } from "../abi.js";
import { allTokens } from "../db.js";

const ZERO = "0x0000000000000000000000000000000000000000";

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Sweep creator fees for every registered token into per-payee books. */
export async function runCollect(): Promise<void> {
  const tokens = allTokens().map((t) => getAddress(t.address));
  if (tokens.length === 0) return;
  console.log(`[collect] ${tokens.length} tokens`);
  for (const batch of chunk(tokens, config.collectBatchSize)) {
    try {
      await sendAndWait(
        () => walletClient.writeContract({
          address: config.router, abi: routerAbi, functionName: "collectMany", args: [batch],
        }),
        `collectMany(${batch.length})`,
      );
    } catch (e: any) {
      console.error(`[collect] batch failed: ${e?.message ?? e}`);
    }
  }
  if (config.autoPush) await pushAll();
}

/** Optional: keeper pushes booked fees to each bound wallet (off-ramp handoff). */
export async function pushAll(): Promise<void> {
  const tokens = allTokens();
  // group distinct (payeeId, asset) pairs
  const pairs = new Map<string, { payeeId: `0x${string}`; asset: `0x${string}` }>();
  for (const t of tokens) {
    const key = `${t.payeeId}:${t.asset.toLowerCase()}`;
    pairs.set(key, { payeeId: t.payeeId as `0x${string}`, asset: getAddress(t.asset) });
  }
  for (const { payeeId } of pairs.values()) {
    try {
      const wallet = (await publicClient.readContract({
        address: config.registry, abi: registryAbi, functionName: "walletOf", args: [payeeId],
      })) as string;
      if (wallet === ZERO) continue; // not connected yet

      const amount = (await publicClient.readContract({
        address: config.router, abi: routerAbi, functionName: "claimable", args: [payeeId],
      })) as bigint;
      if (amount === 0n) continue;

      await sendAndWait(
        () => walletClient.writeContract({
          address: config.router, abi: routerAbi, functionName: "pushPayout", args: [payeeId, amount],
        }),
        `pushPayout(${payeeId.slice(0, 10)}.. ${amount})`,
      );
    } catch (e: any) {
      console.error(`[push] failed: ${e?.message ?? e}`);
    }
  }
}
