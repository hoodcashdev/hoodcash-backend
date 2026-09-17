import {
  createPublicClient, createWalletClient, http, fallback, defineChain, type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";

export const robinhoodChain = defineChain({
  id: config.chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

export const account = privateKeyToAccount(config.keeperPk);

// RPC_URL may be a single URL or a comma-separated list of endpoints. We wrap them
// in a fallback transport with generous retries + backoff so a rate-limited (429) or
// flaky endpoint doesn't drop a registration, a fee collection, or a dashboard read.
const rpcUrls = String(config.rpcUrl).split(",").map((u) => u.trim()).filter(Boolean);
const makeHttp = (u: string) => http(u, {
  retryCount: 6,
  retryDelay: 500,      // backs off exponentially from here
  timeout: 20_000,
  batch: { wait: 24 },  // coalesce simultaneous eth_calls into one HTTP request
});
const transport = fallback(rpcUrls.map(makeHttp), { retryCount: 2, rank: false });

export const publicClient = createPublicClient({ chain: robinhoodChain, transport });
export const walletClient = createWalletClient({ account, chain: robinhoodChain, transport });

/** Send a write and wait for it to mine; returns the receipt. */
export async function sendAndWait(
  write: () => Promise<Hash>,
  label: string,
) {
  const hash = await write();
  console.log(`[tx] ${label} -> ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[tx] ${label} ${receipt.status} in block ${receipt.blockNumber}`);
  return receipt;
}
