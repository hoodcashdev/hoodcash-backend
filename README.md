# HoodPaid — keeper backend

The off-chain half of HoodPaid. It:

1. **Verifies handle ownership** via X (Twitter) OAuth 2.0 (PKCE), then binds the user's wallet
   on-chain (`registry.bindWallet`) after they sign a proof message.
2. **Registers launches** — records `token → payee` and calls `router.registerToken` so the
   collector knows to sweep it.
3. **Collects fees on a cron** — batches `router.collectMany` over all registered tokens.
4. **Serves claimables** — one endpoint returns a handle's routed fees *and* supply allocations,
   and whether they've connected a wallet yet.
5. Optionally **pushes payouts** to bound wallets (`AUTO_PUSH`, or the `/admin/push-*` endpoints)
   as the handoff point to a fiat off-ramp.

Stack: TypeScript + Express + [viem](https://viem.sh) + better-sqlite3 + node-cron.

## The connect → claim flow

```
 frontend                     backend                         chain
 ────────                     ───────                         ─────
 "Connect X"  ── GET /auth/x/start ──►  redirect to X consent
                              ◄── X calls /auth/x/callback ──
                              exchange code, read @handle,
                              mint nonce, upsert payee
        ◄── redirect FRONTEND/connected?session&handle&payeeId&nonce ──
 wallet.signMessage(         GET /bind/message?session&wallet  → the exact string to sign
   bind message)
             ── POST /bind {session, wallet, signature} ──►
                              verifyMessage → registry.bindWallet(payeeId, wallet)  ──►  ✅ bound
 show dashboard ── GET /claimables?handle=@… ──►  reads router.claimable + allocations.pending
```

After binding, the same wallet can `claim` fees (USDG) and allocation (the coin) directly on the
contracts, or the keeper can `pushPayout` / `pushClaim` on their behalf.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/health` | — | keeper address + liveness |
| GET  | `/auth/x/start` | — | begin X OAuth (`?json=1` returns the URL instead of redirecting) |
| GET  | `/auth/x/callback` | — | OAuth return; redirects to the frontend with a session |
| GET  | `/bind/message` | — | the exact message a session+wallet must sign |
| POST | `/bind` | — | `{session, wallet, signature}` → binds wallet on-chain |
| GET  | `/claimables` | — | `?handle=` or `?payeeId=` → fees + allocations |
| POST | `/launches` | Bearer `ADMIN_TOKEN` | `{token, handle, pairAsset?, launchpad?}` → registerToken |
| POST | `/admin/collect` | Bearer | trigger a collect sweep now |
| POST | `/admin/sync` | Bearer | re-index tokens from chain events |
| POST | `/admin/push-fees` | Bearer | `{payeeId, asset, amount}` |
| POST | `/admin/push-allocation` | Bearer | `{token, payeeId}` |

## Setup

```bash
cp .env.example .env      # fill in RPC, keeper key, contract addresses, X app creds
npm install
npm run dev               # or: npm start
```

**Prerequisites**

- The **keeper wallet** (`KEEPER_PRIVATE_KEY`) must be a keeper on all three contracts
  (`Registry`, `Router`, `Allocations`) — the deploy script wires this if you pass `KEEPER`.
- An **X developer app** with OAuth 2.0 enabled, `X_REDIRECT_URI` in its callback allow-list,
  and scopes `tweet.read users.read offline.access`.
- Fund the keeper with a little ETH for gas on Robinhood Chain.

## Notes & honest edges

- **Off-ramp:** on-chain everything lands in the payee's **wallet** (USDG for fees, the coin for
  allocation). Moving USD to a bank/Robinhood is a separate, licensed step — `push-fees` is the
  handoff point where you'd hand a payout to a partner. There is no silent Robinhood deposit.
- **`ILaunchpad.collectFees`** must match the real Pons escrow. Point `DEFAULT_LAUNCHPAD` at the
  Pons escrow and confirm its claim function name/args (adapt the interface or add a tiny adapter).
- **payeeId parity:** `src/payee.ts` hashes exactly like `Registry.payeeIdForHandle`
  (ASCII-lowercase, `platform:handle`). Don't change one without the other.
- **better-sqlite3** is a native module — needs build tools (python3, make, g++). If that's a
  hassle in your deploy, swap `src/db.ts` for Node's built-in `node:sqlite` or Postgres; the
  interface is small.
- **Security:** OAuth verifies the handle; the wallet signature proves wallet control; the two are
  joined by the session nonce. Keep `ADMIN_TOKEN` and the keeper key secret. Sessions/nonces are
  single-purpose but not expired here — add a TTL sweep before production.

## Not included (yet)

- Frontend (the connect + claim dashboard).
- Rate limiting, session TTLs, and a real job queue for high launch volume.
- The fiat off-ramp partner integration.
