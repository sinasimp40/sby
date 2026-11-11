# Telecart

A web administration workspace for a Telegram digital-product shop.

## Current scope

- Product creation, editing and deletion, encrypted credential inventory, nonsecret shop/bot/payment preferences and private owner workspaces.
- The dashboard requires admin sign-in on all routes. Unauthenticated read-only APIs serve safe samples or empty data, never private shop records.
- Dashboard sign-in is admin email and password only, with no Clerk widget or OTP. Existing shop ownership is preserved. The configured `TELECART_ADMIN_INITIAL_PASSWORD` secret now also supplies the admin login credential; changing it invalidates existing sessions. Sessions are random, stored as keyed hashes in PostgreSQL, expire after eight hours, and use Secure/HttpOnly/Partitioned cookies for the embedded preview. All writes require the configured exact Origin, and failed logins are rate-limited in the database.
- The phone mockup remains a **local preview**. The dashboard selects polling (including localhost) or public HTTPS webhooks after explicit admin activation.
- NOWPayments direct payments, address QR generation, HMAC-signed IPN verification plus authoritative API checks, integer wallet ledger and encrypted-stock delivery are implemented. Fulfillment requires provider status **finished**, full payment and matching invoice identity. Confirming/confirmed/sending never fulfill.
- New Telegram invoices use compact HTML captions, network-specific labels and copyable addresses, with no manual Check payment button. Provider polling edits the same caption only when its content changes, including received amount, completion and expiry. Old photo callbacks can register their message reference for compatibility. Delivery and wallet credits remain idempotent.
- Payments settings expose live fixed/floating provider minimums for the merchant route, a new-invoice rate-mode selector, BNB Smart Chain support and a configurable shop floor down to $0.10. Existing shops retain fixed-rate mode unless changed explicitly. The actual usable minimum is max(shop floor, provider route minimum); $0.10 is not available for every currency. Floating invoices settle against the provider's current required amount, never an outdated lower quote.
- Order, customer and deposit views read persisted business records. Never seed paid orders, wallet balances or payment confirmations to make the dashboard appear live.
- Telegram's rules require Stars for digital goods sold inside bots. NOWPayments QR payments do not override Telegram/provider rules; the activation UI states this explicitly.

## Run & Operate

- Imported workspace setup: dependencies are installed with `pnpm install --frozen-lockfile`, the development PostgreSQL schema is initialized with `pnpm --filter @workspace/db run push`, and the existing app services are registered from their artifact manifests. Use Replit's Run workflows below, not a root `pnpm dev` command.
- Development setup preserves password-only dashboard login. Clerk supplies the existing bootstrap identity behind the scenes, not an OTP screen. The development admin was securely initialized using `TELECART_ADMIN_INITIAL_PASSWORD`; the imported `TELECART_ADMIN_EMAIL` is `admin@admin.com` and should be changed to an address you control before live operation. A new bootstrap password must also satisfy Clerk's password requirements; use a strong, unique password of at least 12 characters.
- Sign-in Origin checks use `TELECART_ADMIN_ORIGIN`, falling back to `TELECART_PUBLIC_URL`; changing the public provider callback in the dashboard does not change trusted login origins. `TELECART_TELEGRAM_DISABLED=true` is only the initial default until the admin saves dashboard runtime settings. Bot/Payments → Provider connections has persistent Enable/Disable, polling/webhook mode and public callback controls, with explicit live-processing confirmation. The token check only calls read-only `getMe`.
- Managed workflows: `artifacts/api-server: API Server`, `artifacts/telecart: web`.
- `pnpm run typecheck` — complete workspace type check.
- `pnpm --filter @workspace/api-spec run codegen` — regenerate client hooks and server validation.
- `pnpm --filter @workspace/db run push` — development schema updates only.
- Use the existing artifact-managed workflows; do not create duplicate servers.
- `pnpm --filter @workspace/api-server exec tsx --test tests/commerce.test.ts` — isolated-owner database tests with mocked providers, no real invoices/messages; this suite intentionally refuses to replace an already connected bot. `tests/payment-recovery.test.ts` and `tests/admin-auth.test.ts` can test isolated records while a live bot remains connected.
- Workspace Telegram testing does not require publishing. Select Polling and explicitly enable in the dashboard; it removes the webhook without dropping queued updates. A PostgreSQL session lock prevents overlapping pollers sharing a database. Telegram conflicts from other computers are shown as errors, not a fake connected state. Keep the server running. Messages and invoices are real. Payment reconciliation fetches stored invoice statuses/amounts about every 30 seconds with bounded retries, never recreates invoices, and preserves finished-only/full-amount settlement.
- Webhook activation requires a publicly reachable HTTPS callback origin. Its status means webhook configured, not proven delivery. Never let the first arbitrary signup claim shared credentials. Pause before changing transport/callback origin.
- Local installation: see `LOCAL_SETUP.md` and `.env.local.example`; use Node 22.16+/24, PostgreSQL, `pnpm db:local`, then `pnpm dev:local`. Local HTTP cookies are allowed only for an explicitly configured loopback development origin; public/production cookies remain Secure/HttpOnly/Partitioned. Preserve the original owner ID and SESSION_SECRET to use existing encrypted shop data. No database transfer is performed automatically.
- Optional trusted first-admin bootstrap: configure `TELECART_ADMIN_EMAIL` and securely supply `TELECART_ADMIN_INITIAL_PASSWORD`. At server startup, the app creates that account in the current Clerk environment and binds its returned identity as operator, unless an explicit owner binding already matches. This is not a default login. Existing unrelated accounts are never reset/promoted; revoked roles stay revoked. Use a merchant-controlled email for recovery, and never commit the initial password. Republish to run this in production; creating a development user alone does not establish production access.
- External endpoints: `/api/telegram/webhook` (Telegram secret header) and `/api/nowpayments/ipn` (NOWPayments signature); a configured public callback origin is supplied at payment creation. Polling-only localhost invoices omit the callback and rely on outbound reconciliation.
- Configure your receiving wallet and IPN secret in NOWPayments. Preserve the bot identity and SESSION_SECRET; rotating to a different bot needs a buyer/payment migration.

## Stack & Source of Truth

- React/Vite web app in `artifacts/telecart`; Express API in `artifacts/api-server`.
- API contract: `lib/api-spec/openapi.yaml`. Generated React Query hooks and Zod schemas are workspace libraries.
- PostgreSQL/Drizzle schema: `lib/db/src/schema/`.
- Auth: password-only admin sessions; existing Replit-managed Clerk identities remain the trusted cloud bootstrap. Local installs can bind an explicit owner without Clerk.
- Server reads and writes are scoped by the authenticated admin owner. Never accept an owner ID from the browser or grant the first signup access to another shop.
- Public GETs serve safe samples or empty arrays, not private data. All mutations require authentication.

## Security & Operations

- Inventory accepts one `login:password` line per account, at most 500 per request. Records are encrypted with AES-256-GCM, owner/product AAD and a random nonce.
- Telegram bot tokens and NOWPayments API/IPN credentials entered in the admin dashboard are encrypted at rest using AES-GCM, per-owner associated data and a key derived from `SESSION_SECRET`. They are never returned to the browser. Preserve `SESSION_SECRET`; rotating it makes encrypted credentials unreadable.
- Encryption and deduplication keys derive from `SESSION_SECRET`. Preserve that secret: rotation without a data re-encryption migration makes existing inventory unreadable. Before production-scale use, design a dedicated versioned inventory-key rotation workflow.
- Never log credentials, return plaintext inventory to list APIs, store service API keys in ordinary settings, or include credentials in activity events.
- Product deletion cascades inventory. The frontend must explain and confirm this before deleting.
- Prices persist as integer USD cents. No administrator mutation may fabricate a paid invoice or confirmed wallet credit.
- Payment handlers use verified signatures, idempotent state transitions and atomic wallet/stock updates. A stock line is reserved at invoice creation. Local quote expiry does NOT release stock: only a verified provider terminal status can release it.
- Uncertain provider creation (timeouts) holds stock for manual investigation by merchant order ID. Never blindly recreate an invoice or assume a timed-out request did not reach NOWPayments. Partial/wrong-asset/child/repeated deposits require manual review.
- Exactly-once allocation/credit is enforced in PostgreSQL. Telegram cannot guarantee exactly-once message delivery: after an ambiguous send, retries may resend the same assigned line, never consume another. Buyer/admin status checks and repeated IPNs retry pending delivery.
- Existing paid/reserved inventory cannot be deleted through product cascades; archive those products. Do not auto-refund, reverse a wallet ledger entry or release reserved stock merely because the local clock expired.

## Project structure

- `artifacts/telecart/src/` — dashboard, owner authentication and local Telegram preview.
- `artifacts/api-server/src/routes/shop*.ts` — shop API.
- `artifacts/api-server/src/lib/shop-*` — defaults and persistence queries.
- `artifacts/api-server/src/lib/inventory-encryption.ts` — credential encryption.
- `artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts` — canonical Clerk production proxy.
