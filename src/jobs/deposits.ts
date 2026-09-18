import { getAddress } from "viem";
import { config } from "../config.js";
import { recordOfframp } from "../db.js";

// Robinhood Chain block explorer (Blockscout) REST API — reliable, keyless.
const EXPLORER = "https://robinhoodchain.blockscout.com/api/v2";

/**
 * Auto-log off-ramp "deposits": any native ETH transfer INTO your Kraken deposit address.
 * We read incoming transactions straight from the explorer (last page ≈ 50 txns) instead of
 * scanning blocks one-by-one over RPC — far more reliable. Dedup is by tx hash (UNIQUE ref),
 * so re-reading the same page never double-logs, and past deposits get backfilled once.
 */
export async function scanDeposits(): Promise<void> {
  const kraken = config.krakenDeposit;
  if (!kraken) return;
  const target = getAddress(kraken).toLowerCase();

  let items: any[] = [];
  try {
    const r = await fetch(`${EXPLORER}/addresses/${kraken}/transactions?filter=to`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return;
    const j: any = await r.json();
    items = Array.isArray(j?.items) ? j.items : [];
  } catch {
    return; // transient explorer hiccup — try again next tick
  }

  let found = 0;
  for (const tx of items) {
    const to = String(tx?.to?.hash ?? tx?.to ?? "").toLowerCase();
    if (to !== target) continue;
    const val = String(tx?.value ?? "0");
    if (!val || val === "0") continue;
    const status = String(tx?.status ?? tx?.result ?? "").toLowerCase();
    if (status && status !== "ok" && status !== "success") continue; // skip failed txns
    const hash = tx?.hash;
    if (!hash) continue;
    const id = recordOfframp({ kind: "deposit", amountWei: val, dest: "Kraken", ref: hash, mode: "auto" });
    if (id !== -1) found++;
  }
  if (found) console.log(`[deposits] +${found} ETH->Kraken (explorer)`);
}
