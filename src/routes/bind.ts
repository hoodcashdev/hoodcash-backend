import { Router } from "express";
import { getAddress, isAddress, verifyMessage } from "viem";
import { config } from "../config.js";
import { publicClient, walletClient, sendAndWait } from "../chain.js";
import { registryAbi } from "../abi.js";
import { getSession, setPayeeWallet } from "../db.js";
import { payeeId, bindMessage } from "../payee.js";

export const bindRouter = Router();

/**
 * Body: { session, wallet, signature }
 * Verifies the wallet signed the bind message for the OAuth-verified handle, then calls
 * registry.bindWallet(payeeId, wallet) on-chain as the keeper.
 */
bindRouter.post("/", async (req, res) => {
  try {
    const { session, wallet, signature } = req.body ?? {};
    if (!session || !wallet || !signature) return res.status(400).json({ error: "missing session/wallet/signature" });
    if (!isAddress(wallet)) return res.status(400).json({ error: "bad wallet address" });

    const sess = getSession(session);
    if (!sess?.handle || !sess?.nonce) return res.status(400).json({ error: "session not verified" });

    const addr = getAddress(wallet);
    const message = bindMessage(sess.platform, sess.handle, addr, sess.nonce);
    const ok = await verifyMessage({ address: addr, message, signature });
    if (!ok) return res.status(401).json({ error: "signature does not match wallet" });

    const pid = payeeId(sess.platform, sess.handle);

    // Guard: keeper must actually be authorized on the registry
    const keeperOk = await publicClient.readContract({
      address: config.registry, abi: registryAbi, functionName: "isKeeper", args: [walletClient.account.address],
    });
    if (!keeperOk) return res.status(500).json({ error: "keeper not authorized on registry" });

    const receipt = await sendAndWait(
      () => walletClient.writeContract({
        address: config.registry, abi: registryAbi, functionName: "bindWallet", args: [pid, addr],
      }),
      `bindWallet(${sess.handle} -> ${addr})`,
    );
    setPayeeWallet(pid, addr);

    return res.json({ ok: true, payeeId: pid, handle: sess.handle, wallet: addr, txHash: receipt.transactionHash });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

/** Convenience: the exact message a given session must sign (frontend fetches this). */
bindRouter.get("/message", (req, res) => {
  const { session, wallet } = req.query as { session?: string; wallet?: string };
  if (!session || !wallet || !isAddress(wallet)) return res.status(400).json({ error: "bad session/wallet" });
  const sess = getSession(session);
  if (!sess?.handle || !sess?.nonce) return res.status(400).json({ error: "session not verified" });
  return res.json({ message: bindMessage(sess.platform, sess.handle, getAddress(wallet), sess.nonce) });
});
