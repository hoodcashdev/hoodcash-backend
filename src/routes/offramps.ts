import { Router, type Request, type Response, type NextFunction } from "express";
import { parseEther } from "viem";
import { config } from "../config.js";
import { recordOfframp, recentOfframps } from "../db.js";

export const offrampsRouter = Router();

function adminOnly(req: Request, res: Response, next: NextFunction) {
  if (req.header("authorization") !== `Bearer ${config.adminToken}`) return res.status(401).json({ error: "unauthorized" });
  next();
}

/** Public off-ramp stream for the site (deposits ETH->Kraken + ACH USD->X Money). */
offrampsRouter.get("/recent", (_req, res) => {
  const rows = recentOfframps(60).map((o) => ({
    id: o.id, kind: o.kind, amountWei: o.amountWei ?? null, usdCents: o.usdCents ?? null,
    dest: o.dest ?? null, ref: o.ref ?? null, mode: o.mode, at: o.createdAt,
  }));
  return res.json({ ok: true, offramps: rows });
});

/**
 * Operator: log an off-ramp entry.
 *  - ACH:     { kind:"ach", usd, note? }          USD -> our X Money
 *  - Deposit: { kind:"deposit", eth, tx?, note? } ETH -> Kraken (manual fallback; usually auto)
 */
offrampsRouter.post("/log", adminOnly, (req, res) => {
  const { kind, usd, eth, tx, note, dest } = req.body ?? {};
  if (kind !== "ach" && kind !== "deposit") return res.status(400).json({ error: "kind must be 'ach' or 'deposit'" });
  if (kind === "ach") {
    if (usd == null || !isFinite(Number(usd)) || Number(usd) < 0) return res.status(400).json({ error: "bad usd amount" });
    const id = recordOfframp({ kind: "ach", usdCents: Math.round(Number(usd) * 100), dest: dest || "X Money", ref: note || null, mode: "manual" });
    return res.json({ ok: true, id, kind });
  }
  // manual deposit
  let amountWei: string | null = null;
  if (eth != null) { try { amountWei = parseEther(String(eth)).toString(); } catch { return res.status(400).json({ error: "bad eth amount" }); } }
  const id = recordOfframp({ kind: "deposit", amountWei, dest: dest || "Kraken", ref: tx || note || null, mode: "manual" });
  return res.json({ ok: true, id, kind });
});
