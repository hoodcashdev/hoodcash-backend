# Deploy the HoodCash keeper to Railway

The keeper runs 24/7: it registers Pons launches → our Router, collects fees every 5 min,
and drives payouts. It's a Node service + a SQLite file on a volume.

## 1. Push this folder to a GitHub repo
```
cd ~/Documents/hoodpaid-backend
git init && git add -A && git commit -m "HoodCash keeper"
gh repo create hoodcash-backend --private --source . --push
```
(or create the repo in the GitHub UI and push)

## 2. Create the Railway project
1. railway.com → **New Project** → **Deploy from GitHub repo** → pick `hoodcash-backend`.
2. Railway detects the **Dockerfile** and builds it. Let the first build run.

## 3. Add a Volume (so the DB survives redeploys)
- Project → your service → **Variables/Settings → Volumes** → **New Volume**, mount path `/data`.

## 4. Set environment variables
Service → **Variables** → paste these (see `.env.example` for the full list):
```
RPC_URL=https://rpc.mainnet.chain.robinhood.com
CHAIN_ID=4663
KEEPER_PRIVATE_KEY=0x<FRESH rotated keeper key>
REGISTRY_ADDRESS=0x6D1eEAbC031fa45DF3CBecD0aE4181018Eda384B
ROUTER_ADDRESS=0x6478cA8A1177d65147C94F5e4449455F644f7143
ALLOCATIONS_ADDRESS=0xf70af23dB760aeC583Cfc2Ed70AB4475b08e7819
DEFAULT_PAIR_ASSET=0x0bd7d308f8e1639fab988df18a8011f41eacad73
DEFAULT_LAUNCHPAD=0x736D76699C26D0d966744cAe304C000d471f7F35
PONS_FACTORY=0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB
CUSTODY_WALLET=              # optional to boot; set before bank/X-Money payouts
DEPLOY_BLOCK=64098675
FRONTEND_URL=https://hoodcash.site
DB_PATH=/data/hoodcash.db
ADMIN_TOKEN=<a long random string>
# X OAuth — OPTIONAL to boot. Leave blank now; fill once the X app exists to enable claim/X-Connect.
X_CLIENT_ID=
X_CLIENT_SECRET=
X_REDIRECT_URI=https://<railway-domain>/auth/x/callback
X_SCOPES=tweet.read users.read offline.access
STRIPE_SECRET_KEY=            # leave empty for now — payouts run in manual mode
```
Minimum to boot: RPC_URL, CHAIN_ID, KEEPER_PRIVATE_KEY, the three contract addresses,
DEFAULT_PAIR_ASSET, DEFAULT_LAUNCHPAD, DB_PATH, ADMIN_TOKEN. Everything else can be added later.

## 5. Expose it
- Service → **Settings → Networking → Generate Domain**. You'll get something like
  `hoodcash-backend-production.up.railway.app`.
- Test it: open `https://<that-domain>/health` → should return `{"ok":true,"keeper":"0x..."}`.

## 6. Send me the Railway URL
I'll set `window.HM_API` in the site so launches register automatically, and build the
claim page (handle owner cashes out to bank / X Money) against the live API.

## Notes
- **Rotate the keeper key first.** The old one was shared in plaintext — don't fund it.
- Payouts are in **manual mode** until you add `STRIPE_SECRET_KEY`. The keeper still sweeps
  WETH on-chain and records each payout in the ledger (`GET /payouts` worklist, `GET /payouts/recent`).
- Custom API domain (optional): add `api.hoodcash.site` in Railway networking + a CNAME at
  Namecheap → the railway domain, then set `X_REDIRECT_URI` to `https://api.hoodcash.site/...`.
