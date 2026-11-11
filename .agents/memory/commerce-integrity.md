---
name: Checkout integrity decisions
description: Owner binding and conservative recovery requirements for a single shared Telegram/NOWPayments deployment.
---

Shared service credentials must be bound deliberately to the intended shop owner, never claimed automatically by the first account that signs up. The user explicitly wants real Telegram testing from the running workspace without requiring publication.

**Why:** The admin app has private per-owner shops, but the deployment holds one merchant API key and one bot token. First-signup claiming would let an unrelated visitor control them, and Clerk preview identities differ from production.

**How to apply:** Preserve explicit operator binding. Workspace testing uses outbound Telegram polling with deliberate opt-in, not incoming webhooks: a workspace-local health check can pass while Telegram receives Replit's access-protection 307 redirect. Check Telegram's own delivery diagnostics before claiming inbound connectivity. Private workspace IPNs may also be blocked; settlement must retain an outbound status/amount reconciliation path, not depend only on notifications. Public deployments default to webhooks, but dashboard-selected polling must also support localhost/self-hosting. Changing bot identity or merchant ownership requires a migration.

An owner-configured first-admin bootstrap must resolve identities independently inside development and production, without importing live Clerk credentials into the workspace.

**Why:** The user requested a production administrator after publishing. Creating only a preview identity would not fulfill that request; blindly promoting an existing email could take over an unrelated account.

**How to apply:** Use trusted deployment configuration and secure initial-password entry. Only reaccept an account carrying the bootstrap's signed creation marker; never reset an existing user's password or restore a revoked admin grant on restart.

Treat uncertain invoice creation and Telegram delivery separately from financial settlement.

**Why:** A provider timeout can still create a payable invoice; a Telegram send can succeed before the process records success. Retrying by creating a new invoice or taking a new stock line could lose funds or expose multiple accounts.

**How to apply:** Keep uncertain reservations for review; release only after authoritative terminal provider status. Retry only the already assigned credential, with at-most-once stock allocation and wallet credits. Do not promise exactly-once Telegram message delivery.

Provider minimums depend on the coin, payout route and fixed-rate/fee settings; the shop's configured USD minimum is not enough to guarantee invoice creation.

**Why:** A deposit at the shop's minimum was below the selected route's provider minimum and appeared as an unexplained manual-review error.

**How to apply:** Ask the provider for the same route/flags before reserving stock or creating an attempt. Never silently increase a buyer's amount. Distinguish a known validation rejection from a timeout that could already have created a payable invoice.
