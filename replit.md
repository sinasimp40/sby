# Telecart

A web administration workspace for a Telegram digital-product shop.

## Current scope

- Product creation, editing and deletion, encrypted credential inventory, nonsecret shop/bot/payment preferences and private owner workspaces.
- The public dashboard is a labelled preview. Its sample product listings are not real stock, and its sales totals are zero.
- Sign in creates access to the signed-in owner's empty, private shop, not shared administrator access.
- The Telegram interface is a **local preview**, not a running Telegram bot.
- NOWPayments is the requested provider. Live checkout, QR invoice creation, wallet deposits, payment callbacks and credential delivery are **not connected or implemented**.
- Order, customer and deposit views read persisted business records but start empty. Never seed paid orders, wallet balances or payment confirmations to make the dashboard appear live.
- Telegram's rules require Stars for digital goods sold inside bots. A compliant payment architecture and provider connection must be settled before enabling NOWPayments checkout for this use case.

## Run & Operate

- Managed workflows: `artifacts/api-server: API Server`, `artifacts/telecart: web`.
- `pnpm run typecheck` — complete workspace type check.
- `pnpm --filter @workspace/api-spec run codegen` — regenerate client hooks and server validation.
- `pnpm --filter @workspace/db run push` — development schema updates only.
- Use the existing artifact-managed workflows; do not create duplicate servers.

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
- Future payment handlers need verified signatures, idempotent state transitions and atomic wallet/stock updates; not just a QR image or client-side status change.

## Project structure

- `artifacts/telecart/src/` — dashboard, owner authentication and local Telegram preview.
- `artifacts/api-server/src/routes/shop*.ts` — shop API.
- `artifacts/api-server/src/lib/shop-*` — defaults and persistence queries.
- `artifacts/api-server/src/lib/inventory-encryption.ts` — credential encryption.
- `artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts` — canonical Clerk production proxy.
