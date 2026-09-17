import { Router, type Request, type Response, type NextFunction } from "express";
import { getAddress, isAddress } from "viem";
import { config } from "../config.js";
import { publicClient, walletClient, sendAndWait } from "../chain.js";
import { routerAbi, registryAbi, lockerAbi } from "../abi.js";
import { upsertToken, upsertPayee, setPayeeWallet } from "../db.js";
import { payeeId } from "../payee.js";

export const launchesRouter = Router();

function adminOnly(req: Request, res: Response, next: NextFunction) {
  const auth = req.header("authorization") ?? "";
  if (auth !== `Bearer ${config.adminToken}`) return res.status(401).json({ error: "unauthorized" });
  next();
}

const RAILS = new Set(["bank", "xmoney", "crypto"]);

/**
 * Register a token on the Router so the collector sweeps its fees, and record which handle +
 * rail the launcher chose. Idempotent — a token already registered on-chain is treated as ok.
 * For custodial rails (bank / X Money) we bind the payee to the operator custody wallet so the
 * keeper can pushPayout and off-ramp; for the crypto rail the creator binds their own wallet
 * later via X OAuth.
 */
async function register(opts: { token: string; handle: string; platform: string; rail: string }) {
  const asset = config.defaultPairAsset;    // WETH
  const pad = config.defaultLaunchpad;       // Pons locker
  const tokenAddr = getAddress(opts.token);
  const pid = payeeId(opts.platform, opts.handle);

  upsertPayee({ payeeId: pid, platform: opts.platform, handle: opts.handle.replace(/^@/, ""), rail: opts.rail });

  let txHash: string | undefined;
  try {
    const receipt = await sendAndWait(
      () => walletClient.writeContract({
        address: config.router, abi: routerAbi, functionName: "registerToken",
        args: [tokenAddr, pid, asset, pad],
      }),
      `registerToken(${tokenAddr})`,
    );
    txHash = receipt.transactionHash;
  } catch (e: any) {
    // AlreadyRegistered (or a re-submit) is fine — keep going.
    if (!/AlreadyRegistered|already/i.test(e?.message ?? "")) throw e;
  }
  upsertToken({ address: tokenAddr, payeeId: pid, asset, launchpad: pad });

  // Custodial rails route fees to the operator wallet for fiat / X Money off-ramp.
  if ((opts.rail === "bank" || opts.rail === "xmoney") && config.custodyWallet && isAddress(config.custodyWallet)) {
    const bound = (await publicClient.readContract({
      address: config.registry, abi: registryAbi, functionName: "walletOf", args: [pid],
    })) as string;
    if (bound.toLowerCase() !== config.custodyWallet.toLowerCase()) {
      await sendAndWait(
        () => walletClient.writeContract({
          address: config.registry, abi: registryAbi, functionName: "bindWallet",
          args: [pid, getAddress(config.custodyWallet as string)],
        }),
        `bindWallet(custody ${pid.slice(0, 10)}..)`,
      );
      setPayeeWallet(pid, getAddress(config.custodyWallet as string));
    }
  }

  return { token: tokenAddr, payeeId: pid, asset, launchpad: pad, rail: opts.rail, txHash };
}

/**
 * PUBLIC endpoint the frontend calls right after a Pons launch. We only accept it if the token's
 * fees actually redirect to our Router on-chain — so an untrusted caller can't register someone
 * else's token or point fees anywhere but us.
 * Body: { token, handle, rail, platform?, creator?, tx? }
 */
launchesRouter.post("/submit", async (req, res) => {
  try {
    const { token, handle, rail = "bank", platform = "x" } = req.body ?? {};
    if (!token || !isAddress(token)) return res.status(400).json({ error: "bad token address" });
    if (!handle || typeof handle !== "string") return res.status(400).json({ error: "missing handle" });
    if (!RAILS.has(rail)) return res.status(400).json({ error: "bad rail" });

    const tokenAddr = getAddress(token);

    // on-chain proof: this launch routes its creator fees to us
    const [redirect, launched] = await Promise.all([
      publicClient.readContract({ address: config.defaultLaunchpad, abi: lockerAbi, functionName: "feeRedirects", args: [tokenAddr] }) as Promise<string>,
      publicClient.readContract({ address: config.defaultLaunchpad, abi: lockerAbi, functionName: "getLaunchedToken", args: [tokenAddr] }) as Promise<any>,
    ]);
    if (!launched?.exists) return res.status(400).json({ error: "not a Pons launch" });
    if (!redirect || redirect.toLowerCase() !== config.router.toLowerCase()) {
      return res.status(400).json({ error: "fees are not routed to Hood Money" });
    }

    const out = await register({ token: tokenAddr, handle, platform, rail });
    return res.json({ ok: true, verified: true, ...out });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

/** Admin variant — register without the on-chain check (manual backfill / trusted ops). */
launchesRouter.post("/", adminOnly, async (req, res) => {
  try {
    const { token, handle, platform = "x", rail = "bank" } = req.body ?? {};
    if (!token || !isAddress(token)) return res.status(400).json({ error: "bad token address" });
    if (!handle) return res.status(400).json({ error: "missing handle" });
    const out = await register({ token, handle, platform, rail });
    return res.json({ ok: true, ...out });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});
