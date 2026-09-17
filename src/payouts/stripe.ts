import { config } from "../config.js";

/**
 * Send a bank payout via Stripe. Returns the Stripe id, or null if Stripe isn't configured
 * (manual mode). `dest` is a Stripe Connect account id (acct_...) linked by the handle owner;
 * paying an arbitrary person's bank requires Stripe Connect, so this is a transfer to their
 * connected account, which then pays out to their bank on their Stripe payout schedule.
 *
 * Stripe is loaded lazily so the keeper runs fine before you've added the dependency/keys.
 */
export async function stripeTransfer(dest: string, amountUsdCents: number): Promise<string | null> {
  if (!config.stripeSecret) return null;              // manual mode
  if (!dest || amountUsdCents <= 0) throw new Error("bad payout dest/amount");
  let StripeCtor: any;
  try {
    StripeCtor = (await import("stripe" as any)).default;
  } catch {
    throw new Error("stripe package not installed — run `npm i stripe` before going live");
  }
  const stripe = new StripeCtor(config.stripeSecret);
  const transfer = await stripe.transfers.create({
    amount: Math.round(amountUsdCents),
    currency: "usd",
    destination: dest,
    description: "HoodCash creator-fee payout",
  });
  return transfer.id as string;
}

export function stripeEnabled(): boolean {
  return !!config.stripeSecret;
}
