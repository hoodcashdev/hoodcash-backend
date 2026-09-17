import { Router, type Request, type Response, type NextFunction } from "express";
import { getAddress, isAddress } from "viem";
import { config } from "../config.js";
import { walletClient, sendAndWait } from "../chain.js";
import { routerAbi, allocationsAbi } from "../abi.js";
import { runCollect } from "../jobs/collector.js";
import { syncTokens } from "../jobs/indexer.js";

export const adminRouter = Router();

adminRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.header("authorization") !== `Bearer ${config.adminToken}`) return res.status(401).json({ error: "unauthorized" });
  next();
});

/** Trigger a collect sweep now. */
adminRouter.post("/collect", async (_req, res) => {
  try { await runCollect(); res.json({ ok: true }); }
  catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

/** Re-sync tokens from chain events. */
adminRouter.post("/sync", async (_req, res) => {
  try { await syncTokens(); res.json({ ok: true }); }
  catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

/** Push a payee's fees to their bound wallet: { payeeId, asset, amount } */
adminRouter.post("/push-fees", async (req, res) => {
  try {
    const { payeeId, amount } = req.body ?? {};
    if (!payeeId || !amount) return res.status(400).json({ error: "bad params" });
    const receipt = await sendAndWait(
      () => walletClient.writeContract({
        address: config.router, abi: routerAbi, functionName: "pushPayout",
        args: [payeeId, BigInt(amount)],
      }),
      `pushPayout`,
    );
    res.json({ ok: true, txHash: receipt.transactionHash });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

/** Push a payee's supply allocation to their bound wallet: { token, payeeId } */
adminRouter.post("/push-allocation", async (req, res) => {
  try {
    const { token, payeeId } = req.body ?? {};
    if (!isAddress(token) || !payeeId) return res.status(400).json({ error: "bad params" });
    const receipt = await sendAndWait(
      () => walletClient.writeContract({
        address: config.allocations, abi: allocationsAbi, functionName: "pushClaim",
        args: [getAddress(token), payeeId],
      }),
      `pushClaim`,
    );
    res.json({ ok: true, txHash: receipt.transactionHash });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});
