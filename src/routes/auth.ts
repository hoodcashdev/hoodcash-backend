import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { newSession, getSession, completeSession, upsertPayee } from "../db.js";
import { payeeId } from "../payee.js";

export const authRouter = Router();

const b64url = (b: Buffer) => b.toString("base64url");

// 1) Kick off X OAuth 2.0 (PKCE). Returns/redirects to the X consent screen.
authRouter.get("/x/start", (req, res) => {
  const codeVerifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(codeVerifier).digest());
  const state = newSession(codeVerifier, "x");

  const url = new URL("https://twitter.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.xClientId);
  url.searchParams.set("redirect_uri", config.xRedirectUri);
  url.searchParams.set("scope", config.xScopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  // JSON mode (for SPA popups) vs. direct redirect
  if (req.query.json === "1") return res.json({ authorizeUrl: url.toString(), state });
  return res.redirect(url.toString());
});

// 2) X redirects back here with ?code&state. We exchange, read the handle, mint a signing nonce.
authRouter.get("/x/callback", async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state) return res.status(400).send("missing code/state");
    const sess = getSession(state);
    if (!sess) return res.status(400).send("unknown state");

    // token exchange
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.xRedirectUri,
      code_verifier: sess.codeVerifier,
      client_id: config.xClientId,
    });
    const basic = Buffer.from(`${config.xClientId}:${config.xClientSecret}`).toString("base64");
    const tokRes = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body,
    });
    if (!tokRes.ok) return res.status(502).send(`token exchange failed: ${await tokRes.text()}`);
    const { access_token } = (await tokRes.json()) as { access_token: string };

    // who is this
    const meRes = await fetch("https://api.twitter.com/2/users/me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!meRes.ok) return res.status(502).send(`users/me failed: ${await meRes.text()}`);
    const handle = (((await meRes.json()) as any).data?.username as string) ?? "";
    if (!handle) return res.status(502).send("no username returned");

    const nonce = b64url(randomBytes(16));
    completeSession(state, handle, nonce);
    const pid = payeeId("x", handle);
    upsertPayee({ payeeId: pid, platform: "x", handle });

    // hand the session back to the static frontend (root handles ?claim=)
    const back = new URL(config.frontendUrl);
    back.searchParams.set("claim", state);
    back.searchParams.set("handle", handle);
    back.searchParams.set("payeeId", pid);
    back.searchParams.set("nonce", nonce);
    return res.redirect(back.toString());
  } catch (e: any) {
    return res.status(500).send(`callback error: ${e?.message ?? e}`);
  }
});
