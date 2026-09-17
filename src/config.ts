import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  rpcUrl: req("RPC_URL"),
  chainId: Number(opt("CHAIN_ID", "4663")),
  keeperPk: req("KEEPER_PRIVATE_KEY") as `0x${string}`,

  registry: req("REGISTRY_ADDRESS") as `0x${string}`,
  router: req("ROUTER_ADDRESS") as `0x${string}`,
  allocations: req("ALLOCATIONS_ADDRESS") as `0x${string}`,

  // Pons integration. Fees accrue in WETH inside the locked V3 position; the locker
  // (= defaultLaunchpad) exposes collectFees(token) and pushes the recipient share to
  // whatever address is set as the token's feeWallet — which is our Router.
  defaultPairAsset: req("DEFAULT_PAIR_ASSET") as `0x${string}`,   // WETH 0x0bd7…acad73
  defaultLaunchpad: opt("DEFAULT_LAUNCHPAD", "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952") as `0x${string}`, // Pons V2 fee locker
  ponsFactory: opt("PONS_FACTORY", "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e") as `0x${string}`, // Pons V2 factory
  // Custodial rails (bank / X Money): payees route to this operator wallet, which the
  // keeper sweeps and off-ramps via Stripe/Kraken. Crypto rail binds the creator's own wallet.
  custodyWallet: opt("CUSTODY_WALLET", "") as `0x${string}` | "",
  // Off-ramp: your Kraken (Robinhood Chain) ETH deposit address. The keeper watches for
  // ETH sent from the keeper wallet to this address and auto-logs each as a "deposit".
  krakenDeposit: opt("KRAKEN_DEPOSIT_ADDRESS", "") as `0x${string}` | "",
  deployBlock: BigInt(opt("DEPLOY_BLOCK", "0")),
  feedLookbackBlocks: BigInt(opt("FEED_LOOKBACK_BLOCKS", "200000")),

  // Optional so the keeper boots before you've made the X app (OAuth just won't work until set)
  xClientId: opt("X_CLIENT_ID", ""),
  xClientSecret: opt("X_CLIENT_SECRET", ""),
  xRedirectUri: opt("X_REDIRECT_URI", ""),
  xScopes: opt("X_SCOPES", "tweet.read users.read offline.access"),

  // Stripe (bank rail). Empty => payouts run in manual mode (recorded, not sent).
  stripeSecret: opt("STRIPE_SECRET_KEY", ""),

  port: Number(opt("PORT", "8787")),
  frontendUrl: opt("FRONTEND_URL", "http://localhost:5173"),
  collectCron: opt("COLLECT_CRON", "*/5 * * * *"),
  collectBatchSize: Number(opt("COLLECT_BATCH_SIZE", "40")),
  autoPush: opt("AUTO_PUSH", "false") === "true",
  dbPath: opt("DB_PATH", "./hoodpaid.db"),
  adminToken: req("ADMIN_TOKEN"),
} as const;
