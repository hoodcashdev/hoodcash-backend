import { keccak256, encodePacked } from "viem";

/** ASCII-only lowercasing — matches HoodPaidRegistry._lower exactly (A-Z only). */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * payeeId = keccak256(abi.encodePacked(lower(platform), ":", lower(handle)))
 * Must match HoodPaidRegistry.payeeIdForHandle byte-for-byte.
 */
export function payeeId(platform: string, handle: string): `0x${string}` {
  const p = asciiLower(platform.trim());
  const h = asciiLower(handle.trim().replace(/^@/, ""));
  return keccak256(encodePacked(["string", "string", "string"], [p, ":", h]));
}

/** Message the user signs with their wallet to prove control before we bind it on-chain. */
export function bindMessage(platform: string, handle: string, wallet: string, nonce: string): string {
  return [
    "HoodPaid — bind wallet",
    `platform: ${platform}`,
    `handle: @${handle}`,
    `wallet: ${wallet}`,
    `nonce: ${nonce}`,
  ].join("\n");
}
