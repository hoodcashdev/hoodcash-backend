import {
  createPublicClient, createWalletClient, http, defineChain, type Hash,
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

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(config.rpcUrl),
});

export const walletClient = createWalletClient({
  account,
  chain: robinhoodChain,
  transport: http(config.rpcUrl),
});

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
