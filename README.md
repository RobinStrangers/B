# Aventa

Aventa is a live multi-asset terminal and perpetual trading interface designed for Robinhood Chain. It combines realtime charts, market streams, Stock Token quotes, direct chain balance reads, Lighter-on-Robinhood account state, and wallet-authorized execution through an isolated signer. A deployment remains fail-closed until its signer, IAM credentials, account enrollment, fee approval, and per-market readiness checks pass.

## What is implemented

- Editorial landing page using the Aventa slate and burnt-orange palette, with only Open terminal and Sign in entry points.
- Dedicated `/markets`, `/platform`, and account-scoped `/agent` routes, with Wallet consolidated inside the terminal menu.
- Branded crypto token artwork plus recognizable company, currency, metal, and commodity iconography throughout the market catalog.
- Advanced TradingView charts for crypto, forex, metals, commodities, and equity references.
- Public realtime derivatives streams for crypto ticker, mark price, index price, funding, and recent trades.
- Robinhood Stock Token quote proxy with 15-second caching for supported equity symbols.
- Searchable market catalog that stays hidden until the selected pair is opened, with categories, favorites, source labels, sessions, and accurate feed states.
- Market, limit, and stop ticket controls; long/short, cross/isolated margin, pair-specific leverage limits, reduce-only, take-profit, stop-loss, and slippage controls. Every crypto market is capped at 15× in Aventa; venue, account, jurisdiction, and notional tiers can reduce that cap further.
- Robinhood Chain wallet add/switch flow for chain ID 4663 and server-side onchain ETH and USDG balance reads.
- Terminal account drawer with balances, Robinhood Lighter intent-address deposits, signer-authorized USDG withdrawals, and event-history states. Deposits require a server-verified Robinhood Chain wallet and at least 1 USDG. Withdrawals resolve venue asset metadata dynamically, return only to the profile-bound verified wallet, and remain blocked until every position is flat and every order is cancelled.
- D1-backed profile provisioning for server-verified Privy DIDs, persisted English-only interface preferences and favorites, verified-wallet associations, security audit records, and chain-derived account projections. A Sites-dispatch identity fallback exists only as an explicit private-preview switch and is off by default.
- Private account APIs for session state, account summary, preferences, verified vault history, and database health. Financial history is returned only for a wallet that has a server-verified ownership link.
- An account-scoped Signal Desk with persisted conversations, deterministic natural-language intent parsing, structured long/short/close/cancel intents, bounded risk review, idempotent writes, and optimistic review transitions. An acknowledged executable intent can enter the same signer path as the manual ticket only after the wallet signs that exact payload; there is no agent bypass.
- Live Privy authentication for email, Google, X, and Ethereum wallet sign-in, with an embedded EVM wallet created for users who do not already have one. Private API requests send short-lived Privy tokens for independent server verification.
- Click-controlled and keyboard-accessible three-line terminal menu that keeps navigation, account, authentication, and risk controls out of the trading workspace until needed.
- Live public positions, order and trade history states, account health, explorer, and risk-center surfaces.
- Responsive desktop, tablet, portrait-mobile, and landscape-mobile layouts with safe-area handling, usable touch targets, scroll-safe overlays, and an animated Aventa market-signal visual system.

## Data truthfulness

- TradingView provides the visible historical and live/delayed charts. Its widget data cannot be used for settlement, PnL, or liquidation calculations.
- Crypto trades, tickers, marks, indexes, and funding use realtime derivatives references; Lighter remains the source of venue accounts and positions.
- U.S. equity charts can be delayed. Robinhood Stock Token quotes are cached for 15 seconds and may pause outside the supported market session.
- Forex and CFD references can be real-time in TradingView, while exchange futures can be delayed.
- The interface never generates fallback candles, prices, order books, fills, funding, positions, or protocol statistics.

## Backend and database

The database remains Cloudflare D1. On Vercel, server routes access the existing D1 database through Cloudflare's authenticated REST API; the credentials stay server-only in `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, and `CLOUDFLARE_D1_API_TOKEN`. Schema source lives in `db/schema.ts`, and generated SQL migrations are committed in `drizzle/`.

The database is intentionally an identity, preference, ownership, audit, and indexed-projection layer. It is not the source of truth for wallet balances, margin, collateral, orders, or positions. Those values must come from Robinhood Chain and an audited venue.

Implemented private routes:

- `GET /api/session` provisions and returns the authenticated profile without granting trading authorization.
- `GET /api/account/summary` returns the profile, preferences, verified wallets, projection counts, and indexer checkpoints.
- `GET` and `PUT /api/account/preferences` read and replace validated preferences and favorites. Writes require an authenticated same-origin request.
- `GET /api/account/history?address=…` returns indexed vault activity only after server-verified wallet ownership.
- `POST /api/account/wallets/sync` fetches the current Privy user server-to-server and reconciles only Privy embedded Ethereum wallets. A per-user compare-and-set guard prevents an older in-flight snapshot from overwriting a newer one, and failed/incomplete sync state cannot authorize private wallet data. The client refreshes every four minutes and read authorization expires after ten minutes, so a skipped refresh cannot preserve an old attestation indefinitely. Revoked attestations are deactivated; browser address assertions never create links or overwrite SIWE/EIP-1271 ownership.
- `GET /api/health` verifies D1, Privy configuration, and the isolated execution-service configuration without claiming per-user readiness.
- `/api/execution/*` exposes Privy-only readiness, key enrollment, fee approval, create/cancel/close/withdraw, request status, and private activity proxies. The proxy accepts only typed fields, derives identity server-side, and signs its private Lambda request with AWS Signature Version 4.
- `/api/agent/*` exposes account-scoped conversation persistence, intent reads, acknowledge/reject review, and wallet-signed execution of the acknowledged payload through the same execution API. Every write requires same-origin verification.

Privy bearer authentication takes precedence whenever an Authorization header is present. The backend verifies the token signature against Privy's public JWKS (or an explicitly configured static verification key), then checks issuer, audience, expiry, session, and Privy DID before provisioning a D1 profile. The Sites dispatcher identity is rejected unless `ALLOW_SITES_AUTH_FALLBACK=true` is deliberately set for an owner-only preview. Browser wallet discovery and identity-token snapshots never create an ownership link. External and smart-contract wallets require a future chain-4663 SIWE/EIP-1271 flow before D1 can use them for private account authorization.

## Robinhood Chain

| Setting | Value |
| --- | --- |
| Network | Robinhood Chain Mainnet |
| Chain ID | `4663` (`0x1237`) |
| Gas token | ETH |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |

The balance drawer intentionally exposes only Robinhood Chain ETH and USDG. USDG is the sole trading-collateral asset presented by Aventa.

The public RPC is rate-limited. Configure `NEXT_PUBLIC_ROBINHOOD_RPC_URL` with a production provider before launch.

## Deploy on Vercel

Use the Next.js preset with `npm run build` and leave Output Directory at its framework default (`.next`). Do not set an empty URL environment variable: the app now validates `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_ROBINHOOD_RPC_URL`, but valid production values are still recommended.

Required server-side D1 variables:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_D1_DATABASE_ID
CLOUDFLARE_D1_API_TOKEN
```

The Cloudflare token should be scoped to the target D1 database with only the read/write permissions the application requires. `PRIVY_APP_SECRET` remains server-only. `NEXT_PUBLIC_*` values are browser-visible and must never contain secrets.

## Run locally

```bash
npm install
npm run db:apply:local
npm run dev
```

For a production verification build:

```bash
npm run db:generate
npx tsc --noEmit
npm run lint
npm run build
```

Copy `.env.example` to `.env.local` when custom environment values are required. In the Privy Dashboard, enable email, Google, Twitter/X, and wallet login, enable identity tokens, and add the exact local and production origins.

`NEXT_PUBLIC_PRIVY_APP_ID` is public. Access and identity token signatures use Privy's app JWKS automatically; `PRIVY_JWT_VERIFICATION_KEY` can optionally pin the public verification key. Configure `PRIVY_APP_SECRET` as a server-only hosting secret so the backend can retrieve the authoritative current user before wallet reconciliation. Set `NEXT_PUBLIC_VAULT_ADDRESS` and `NEXT_PUBLIC_VENUE_ADDRESS` only after the corresponding Robinhood Chain contracts have been deployed, verified, and audited.

Never place a Privy App Secret, indexer credential, oracle credential, private key, seed phrase, raw access token, or wallet signature in a `NEXT_PUBLIC_*` variable or commit it to this repository.

## Isolated execution service

`execution-service/` contains the AWS Lambda ZIP application, pinned Lighter SDK contract, DynamoDB plus KMS storage boundary, and infrastructure template used by Aventa. D1 remains a profile and UI-projection database; it never becomes the authoritative nonce, key, balance, order, or position store.

Live risk-increasing execution requires all of the following:

1. Deploy the Lambda stack with Function URL authentication set to `AWS_IAM`, then create an IAM principal that can invoke only that function.
2. Store that principal only as encrypted Sites secrets and configure `EXECUTION_FUNCTION_URL`, `AWS_EXECUTION_REGION`, and the execution credentials.
3. Keep `EXECUTION_MODE=off` during deployment, run the signer, nonce, idempotency, fee-scale, and ambiguous-response tests, then enable one tiny allowlisted `canary` account.
4. Verify that treasury account `17005` is still owned by `0xCe8756522C90B405c9647aE6BbcA169240965225` and that every user approval is capped at exactly 1,700 Lighter fee units (0.17%).
5. Confirm that quota, budget, MAU, oracle, and venue circuit breakers block open/increase while cancel, reduce-only close, and exposure-safe withdrawal remain available.
6. Force an ambiguous canary response and verify that the signed transaction hash or authoritative nonce automatically reconciles the request before the lane reopens.
7. Complete security review, monitoring, incident response, eligibility controls, terms, disclosures, and jurisdiction-specific legal review before broad public mainnet access.

Never set `limited_live` merely to make the UI appear active. The remote readiness response is authoritative for every account and every request.

## Independence notice

Aventa is designed for Robinhood Chain as an independent protocol concept. It is not affiliated with or endorsed by Robinhood. Stock Tokens are tokenized debt securities that provide economic exposure and do not represent ownership of the underlying shares.
