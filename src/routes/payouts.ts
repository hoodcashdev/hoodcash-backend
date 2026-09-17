import { Router, type Request, type Response, type NextFunction } from "express";
import { formatUnits } from "viem";
import { config } from "../config.js";
import { publicClient, walletClient, sendAndWait } from "../chain.js";
import { routerAbi } from "../abi.js";
import { allPayees, tokensForPayee, setPayeeBank, getPayee, recordPayout, recentPayouts, getSession, setPayeeRail } from "../db.js";
import { payeeId } from "../payee.js";
import { stripeTransfer, stripeEnabled } from "../payouts/stripe.js";

export const payoutsRouter = Router();

function adminOnly(req: Request, res: Response, next: NextFunction) {
  const auth = req.header("authorization") ?? "";
  if (auth !== `Bearer ${config.adminToken}`) return res.status(401).json({ error: "unauthorized" });
  next();
}

/**
 * Operator worklist: for every payee, how much WETH is booked on-chain and ready to off-ramp,
 * which rail the launcher chose, and where it goes (bound wallet for crypto/custody, Stripe
 * recipient ref for bank). This is what you read before paying out via Stripe / Kraken / X Money.
 */
payoutsRouter.get("/", adminOnly, async (_req, res) => {
  try {
    const rows: any[] = [];
    for (const p of allPayees()) {
      const tokens = tokensForPayee(p.payeeId);
      let claimable = 0n;
      try {
        claimable = (await publicClient.readContract({
          address: config.router, abi: routerAbi, functionName: "claimable",
          args: [p.payeeId, config.defaultPairAsset],
        })) as bigint;
      } catch { /* ignore */ }
      rows.push({
        handle: p.handle,
        rail: p.rail ?? "unset",
        boundWallet: p.wallet ?? null,
        bankRef: p.bankRef ?? null,
        payoutHint: p.payoutHint ?? null,
        tokens: tokens.length,
        owedWeth: formatUnits(claimable, 18),
        owedWethWei: claimable.toString(),
      });
    }
    rows.sort((a, b) => Number(BigInt(b.owedWethWei) - BigInt(a.owedWethWei)));
    return res.json({ ok: true, custodyWallet: config.custodyWallet || null, payees: rows });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

/**
 * The handle owner links a bank account for the bank rail. We store ONLY a Stripe/Bridge
 * recipient id (created client-side against Stripe), never raw account or card numbers — that
 * keeps Hood Money out of scope for handling bank data directly.
 * Body: { handle, platform?, stripeRecipientId, note? }
 * (In production, gate this behind X OAuth so only the real handle owner can link.)
 */
payoutsRouter.post("/bank-link", adminOnly, (req, res) => {
  const { handle, platform = "x", stripeRecipientId, note } = req.body ?? {};
  if (!handle || !stripeRecipientId) return res.status(400).json({ error: "missing handle or stripeRecipientId" });
  if (/^(acct_|ba_|btok_)/.test(String(stripeRecipientId)) === false && !String(stripeRecipientId).startsWith("cust_")) {
    // soft check: expect a Stripe/Bridge id, not raw numbers
    if (/\d{6,}/.test(String(stripeRecipientId))) {
      return res.status(400).json({ error: "pass a Stripe/Bridge recipient id, not raw bank numbers" });
    }
  }
  const pid = payeeId(platform, handle);
  if (!getPayee(pid)) return res.status(404).json({ error: "unknown handle" });
  setPayeeBank(pid, String(stripeRecipientId), note);
  return res.json({ ok: true, handle, bankRef: stripeRecipientId });
});

/**
 * Execute a payout for a handle. Sweeps the on-chain WETH to the payee's bound wallet first
 * (pushPayout), then — for the bank rail with Stripe live — sends fiat via Stripe. Without
 * Stripe keys it records the payout as manual/pending so you can settle it by hand.
 * Body: { handle, platform?, amountUsdCents? }
 */
payoutsRouter.post("/execute", adminOnly, async (req, res) => {
  try {
    const { handle, platform = "x", amountUsdCents } = req.body ?? {};
    if (!handle) return res.status(400).json({ error: "missing handle" });
    const pid = payeeId(platform, handle);
    const payee = getPayee(pid);
    if (!payee) return res.status(404).json({ error: "unknown handle" });
    const rail = payee.rail ?? "bank";

    const owed = (await publicClient.readContract({
      address: config.router, abi: routerAbi, functionName: "claimable",
      args: [pid, config.defaultPairAsset],
    })) as bigint;
    if (owed === 0n) return res.status(400).json({ error: "nothing owed" });

    // move the WETH out of the Router to the bound wallet (custody wallet for bank/xmoney)
    if (payee.wallet) {
      await sendAndWait(
        () => walletClient.writeContract({
          address: config.router, abi: routerAbi, functionName: "pushPayout",
          args: [pid, config.defaultPairAsset, owed],
        }),
        `pushPayout(${handle} ${owed})`,
      );
    }

    // fiat leg
    if (rail === "bank" && stripeEnabled() && payee.bankRef && amountUsdCents) {
      const ref = await stripeTransfer(payee.bankRef, Number(amountUsdCents));
      const id = recordPayout({ payeeId: pid, handle, rail, amountWei: owed.toString(), ref, mode: "stripe", status: "paid" });
      return res.json({ ok: true, id, mode: "stripe", ref, owedWei: owed.toString() });
    }

    // manual: swept on-chain, operator settles bank/X Money by hand
    const mode = payee.wallet ? "onchain" : "manual";
    const id = recordPayout({ payeeId: pid, handle, rail, amountWei: owed.toString(), ref: null, mode, status: "pending" });
    return res.json({ ok: true, id, mode, status: "pending", owedWei: owed.toString(),
      note: rail === "bank" ? "Add STRIPE_SECRET_KEY + a bank link to auto-send; settle manually for now." : `Send from your ${rail} account, then mark paid.` });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

/**
 * Public, session-gated: a handle owner (verified via X OAuth) starts bank onboarding.
 * When Stripe is live this returns a Stripe Connect onboarding URL; until then it records
 * intent and returns a friendly message. Never collects raw bank numbers here.
 * Body: { session }
 */
payoutsRouter.post("/link-start", (req, res) => {
  const { session } = req.body ?? {};
  if (!session) return res.status(400).json({ error: "missing session" });
  const sess = getSession(session);
  if (!sess?.handle) return res.status(400).json({ error: "session not verified" });
  const pid = payeeId(sess.platform, sess.handle);
  setPayeeRail(pid, "bank");
  if (stripeEnabled()) {
    // TODO: create a Stripe Connect account + AccountLink here and return url.
    return res.json({ ok: true, mode: "stripe", message: "Bank onboarding is being set up — you'll get a secure Stripe link shortly." });
  }
  return res.json({ ok: true, mode: "manual", message: "You're connected. Bank payouts open as soon as our Stripe partner is live — we'll reach out at @" + sess.handle + "." });
});

/** Public payout stream for the site's "every payout public" feed. */
payoutsRouter.get("/recent", (_req, res) => {
  const rows = recentPayouts(50).map((p) => ({
    handle: p.handle, rail: p.rail, amountWei: p.amountWei, mode: p.mode, status: p.status, at: p.createdAt,
  }));
  return res.json({ ok: true, payouts: rows });
});
