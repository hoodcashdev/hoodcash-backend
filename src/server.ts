import express from "express";
import { authRouter } from "./routes/auth.js";
import { bindRouter } from "./routes/bind.js";
import { launchesRouter } from "./routes/launches.js";
import { claimablesRouter } from "./routes/claimables.js";
import { feedRouter } from "./routes/feed.js";
import { adminRouter } from "./routes/admin.js";
import { payoutsRouter } from "./routes/payouts.js";
import { config } from "./config.js";
import { account } from "./chain.js";

export function createServer() {
  const app = express();
  app.use(express.json());

  // CORS — the static frontend (hoodcash.site + www) POSTs to /launches/submit.
  // Allow the configured origin(s) (comma-separated ok) plus any *.hoodcash.site and the apex.
  const allowList = config.frontendUrl.split(",").map((s) => s.trim()).filter(Boolean);
  const isAllowed = (origin: string) =>
    config.frontendUrl === "*" ||
    allowList.includes(origin) ||
    /^https:\/\/([a-z0-9-]+\.)?hoodcash\.site$/.test(origin);
  app.use((req, res, next) => {
    const origin = req.header("origin") ?? "";
    const allow = config.frontendUrl === "*" ? (origin || "*") : (isAllowed(origin) ? origin : allowList[0] || "");
    res.header("Access-Control-Allow-Origin", allow);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Headers", "content-type, authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, keeper: account.address }));

  app.use("/auth", authRouter);         // GET /auth/x/start, GET /auth/x/callback
  app.use("/bind", bindRouter);         // POST /bind, GET /bind/message
  app.use("/launches", launchesRouter); // POST /launches/submit (public, verified) | POST /launches (admin)
  app.use("/claimables", claimablesRouter); // GET /claimables?handle=..
  app.use("/feed", feedRouter);         // GET /feed   (public payout stream + leaderboard)
  app.use("/payouts", payoutsRouter);   // GET /payouts (admin worklist) | POST /payouts/bank-link
  app.use("/admin", adminRouter);       // POST /admin/collect | /sync | /push-fees | /push-allocation

  return app;
}
