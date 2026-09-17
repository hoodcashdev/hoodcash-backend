import { getAddress } from "viem";
import { config } from "../config.js";
import { publicClient } from "../chain.js";
import { routerAbi } from "../abi.js";
import { upsertToken, getMeta, setMeta } from "../db.js";

const CURSOR = "lastIndexedBlock";
const MAX_RANGE = 9_000n; // stay under common getLogs range limits

/**
 * Backfill/sync the tokens table from on-chain TokenRegistered events, so the collector still
 * works even for launches registered outside this backend (or after a DB reset).
 */
export async function syncTokens(): Promise<void> {
  const latest = await publicClient.getBlockNumber();
  let from = BigInt(getMeta(CURSOR) ?? config.deployBlock.toString());
  if (from > latest) return;

  while (from <= latest) {
    const to = from + MAX_RANGE > latest ? latest : from + MAX_RANGE;
    const logs = await publicClient.getContractEvents({
      address: config.router,
      abi: routerAbi,
      eventName: "TokenRegistered",
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      const a = log.args as { token?: string; payeeId?: string; asset?: string; launchpad?: string };
      if (!a.token || !a.payeeId || !a.asset || !a.launchpad) continue;
      upsertToken({
        address: getAddress(a.token),
        payeeId: a.payeeId,
        asset: getAddress(a.asset),
        launchpad: getAddress(a.launchpad),
      });
    }
    if (logs.length) console.log(`[index] +${logs.length} tokens (${from}-${to})`);
    setMeta(CURSOR, (to + 1n).toString());
    from = to + 1n;
  }
}
