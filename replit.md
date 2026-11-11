# Telecart

A web administration workspace for a Telegram digital-product shop.

## Current scope

- Product creation, editing and deletion, encrypted credential inventory, nonsecret shop/bot/payment preferences and private owner workspaces.
- The public dashboard is a labelled preview. Its sample product listings are not real stock, and its sales totals are zero.
- Dashboard sign-in is admin email and password only, with no Clerk widget or OTP. Existing shop ownership is preserved. The configured `TELECART_ADMIN_INITIAL_PASSWORD` secret now also supplies the admin login credential; changing it invalidates existing sessions. Sessions are random, stored as keyed hashes in PostgreSQL, expire after eight hours, and use Secure/HttpOnly/Partitioned cookies for the embedded preview. All writes require the configured exact Origin, and failed logins are rate-limited in the database.
- The phone mockup remains a **local preview**. Telegram webhook transport in production and outbound polling in the workspace handle /start, products, support, wallet deposits, purchases and order history after explicit admin activation.
- NOWPayments direct payments, address QR generation, HMAC-signed IPN verification plus authoritative API checks, integer wallet ledger and encrypted-stock delivery are implemented. Fulfillment requires provider status **finished**, full payment and matching invoice identity. Confirming/confirmed/sending never fulfill.
- New Telegram invoices use compact HTML captions, network-specific labels and copyable addresses, with no manual Check payment button. Provider polling edits the same caption only when its content changes, including received amount, completion and expiry. Old photo callbacks can register their message reference for compatibility. Delivery and wallet credits remain idempotent.
- Payments settings expose live fixed/floating provider minimums for the merchant route, a new-invoice rate-mode selector, BNB Smart Chain support and a configurable shop floor down to $0.10. Existing shops retain fixed-rate mode unless changed explicitly. The actual usable minimum is max(shop floor, provider route minimum); $0.10 is not available for every currency. Floating invoices settle against the provider's current required amount, never an outdated lower quote.
- Order, customer and deposit views read persisted business records. Never seed paid orders, wallet balances or payment confirmations to make the dashboard appear live.
- Telegram's rules require Stars for digital goods sold inside bots. NOWPayments QR payments do not override Telegram/provider rules; the activation UI states this explicitly.

## Run & Operate

- Imported workspace setup: dependencies are installed with `pnpm install --frozen-lockfile`, the development PostgreSQL schema is initialized with `pnpm --filter @workspace/db run push`, and the existing app services are registered from their artifact manifests. Use Replit's Run workflows below, not a root `pnpm dev` command.
- Development setup preserves password-only dashboard login. Clerk supplies the existing bootstrap identity behind the scenes, not an OTP screen. Set `TELECART_ADMIN_INITIAL_PASSWORD` securely in Secrets to finish admin setup; the imported `TELECART_ADMIN_EMAIL` is `admin@admin.com` and should be changed to an address you control before live operation.
- Keep development `TELECART_PUBLIC_URL` equal to the current workspace HTTPS origin for sign-in Origin checks. Telegram is explicitly disabled with `TELECART_TELEGRAM_DISABLED=true`; no live bot or payment credentials have been configured by the import setup.
- Managed workflows: `artifacts/api-server: API Server`, `artifacts/telecart: web`.
- `pnpm run typecheck` — complete workspace type check.
- `pnpm --filter @workspace/api-spec run codegen` — regenerate client hooks and server validation.
- `pnpm --filter @workspace/db run push` — development schema updates only.
- Use the existing artifact-managed workflows; do not create duplicate servers.
- `pnpm --filter @workspace/api-server exec tsx --test tests/commerce.test.ts` — isolated-owner database tests with mocked providers, no real invoices/messages; this suite intentionally refuses to replace an already connected bot. `tests/payment-recovery.test.ts` and `tests/admin-auth.test.ts` can test isolated records while a live bot remains connected.
- Workspace Telegram testing does not require publishing. Configure development `TELECART_ALLOW_WORKSPACE_TESTING=true` and `TELECART_PUBLIC_URL` to the exact current HTTPS `REPLIT_DEV_DOMAIN` origin; securely configure the first admin, restart the API, and connect from Payments. The trusted `scripts/connect-workspace.ts` command can also connect the configured operator. The API uses outbound getUpdates polling and removes the bot webhook without dropping pending messages; a PostgreSQL session lock prevents overlapping pollers. Credentials stay in Replit Secrets. Keep the workspace running. Invoices/messages are real. Workspace protection can block incoming payment IPNs; automatic reconciliation fetches recent pending invoices and amounts about every 30 seconds (review/terminal retries are slower). Buyer/admin Check payment also refreshes immediately. Reconciliation only uses stored provider IDs, never recreates ambiguous invoices, and retains finished-only/full-amount settlement.
- For production activation, use the verified published HTTPS origin, resolve the intended admin in production (Clerk users differ from workspace), and connect on the published site. Production rejects workspace callback URLs. Never let the first arbitrary signup claim shared credentials.
- Optional trusted first-admin bootstrap: configure `TELECART_ADMIN_EMAIL` and securely supply `TELECART_ADMIN_INITIAL_PASSWORD`. At server startup, the app creates that account in the current Clerk environment and binds its returned identity as operator, unless an explicit owner binding already matches. This is not a default login. Existing unrelated accounts are never reset/promoted; revoked roles stay revoked. Use a merchant-controlled email for recovery, and never commit the initial password. Republish to run this in production; creating a development user alone does not establish production access.
- External endpoints: `/api/telegram/webhook` (Telegram secret header) and `/api/nowpayments/ipn` (NOWPayments signature); callback URL is automatically supplied at payment creation.
- Configure your receiving wallet and IPN secret in NOWPayments. Preserve the bot identity and SESSION_SECRET; rotating to a different bot needs a buyer/payment migration.

## Stack & Source of Truth

- React/Vite web app in `artifacts/telecart`; Express API in `artifacts/api-server`.
- API contract: `lib/api-spec/openapi.yaml`. Generated React Query hooks and Zod schemas are workspace libraries.
- PostgreSQL/Drizzle schema: `lib/db/src/schema/`.
- Auth: Replit-managed Clerk, cookie-based web sessions and canonical frontend API proxy.
- Server reads and writes are scoped by the authenticated Clerk owner. Never accept an owner ID from the browser or grant the first signup access to another shop.
- Public GETs serve safe samples or empty arrays, not private data. All mutations require authentication.

## Security & Operations

- Inventory accepts one `login:password` line per account, at most 500 per request. Records are encrypted with AES-256-GCM, owner/product AAD and a random nonce.
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
