import cron from "node-cron";
import { config } from "./config.js";
import { createServer } from "./server.js";
import { account } from "./chain.js";
import { runCollect } from "./jobs/collector.js";
import { syncTokens } from "./jobs/indexer.js";
import { scanDeposits } from "./jobs/deposits.js";

async function main() {
  const app = createServer();
  app.listen(config.port, () => {
    console.log(`HoodPaid keeper listening on :${config.port}`);
    console.log(`keeper address: ${account.address}`);
    console.log(`autoPush: ${config.autoPush} | collect cron: "${config.collectCron}"`);
  });

  // initial sync so the collector has a token list even after a DB reset
  try { await syncTokens(); } catch (e: any) { console.error(`[boot] sync failed: ${e?.message ?? e}`); }
  try { await scanDeposits(); } catch (e: any) { console.error(`[boot] deposit scan failed: ${e?.message ?? e}`); }

  // scheduled: index new launches, then sweep fees
  // deposits: poll fast so an ETH->Kraken send shows within ~30s, not on the 5-min cron
  setInterval(() => { scanDeposits().catch((e) => console.error(`[deposits] ${e?.message ?? e}`)); }, 30_000);

  cron.schedule(config.collectCron, async () => {
    try {
      await syncTokens();
      await runCollect();
      await scanDeposits();
    } catch (e: any) {
      console.error(`[cron] ${e?.message ?? e}`);
    }
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
