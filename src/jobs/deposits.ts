import { getAddress } from "viem";
import { config } from "../config.js";
import { publicClient } from "../chain.js";
import { recordOfframp, getMeta, setMeta } from "../db.js";

const CURSOR = "lastDepositBlock";
const MAX_BLOCKS_PER_RUN = 750n;

/**
 * Auto-log off-ramp "deposits": any native ETH transfer INTO your Kraken deposit address.
 * It's your own deposit address, so anything arriving there is a deposit you made — we don't
 * care which wallet sent it. Native transfers aren't events, so we scan blocks (bounded per
 * run; starts at the chain tip on first run so we never rescan history).
 */
export async function scanDeposits(): Promise<void> {
  const kraken = config.krakenDeposit;
  if (!kraken) return;
  const target = getAddress(kraken);

  const latest = await publicClient.getBlockNumber();

  const cur = getMeta(CURSOR);
  if (cur == null) { setMeta(CURSOR, latest.toString()); return; } // first run: start fresh at tip

  let from = BigInt(cur) + 1n;
  if (from > latest) return;
  const to = from + MAX_BLOCKS_PER_RUN - 1n > latest ? latest : from + MAX_BLOCKS_PER_RUN - 1n;

  let found = 0;
  for (let b = from; b <= to; b++) {
    let block;
    try { block = await publicClient.getBlock({ blockNumber: b, includeTransactions: true }); }
    catch { continue; }
    for (const tx of block.transactions as any[]) {
      if (!tx || !tx.to) continue;
      if (getAddress(tx.to) !== target) continue;
      if (!tx.value || BigInt(tx.value) === 0n) continue;
      const id = recordOfframp({ kind: "deposit", amountWei: BigInt(tx.value).toString(), dest: "Kraken", ref: tx.hash, mode: "auto" });
      if (id !== -1) found++;
    }
  }
  if (found) console.log(`[deposits] +${found} ETH->Kraken (${from}-${to})`);
  setMeta(CURSOR, to.toString());
}
