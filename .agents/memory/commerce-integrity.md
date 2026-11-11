---
name: Checkout integrity decisions
description: Owner binding and conservative recovery requirements for a single shared Telegram/NOWPayments deployment.
---

Shared service credentials must be bound deliberately to the intended shop owner, never claimed automatically by the first account that signs up. The user explicitly wants real Telegram testing from the running workspace without requiring publication.

**Why:** The admin app has private per-owner shops, but the deployment holds one merchant API key and one bot token. First-signup claiming would let an unrelated visitor control them, and Clerk preview identities differ from production.

**How to apply:** Preserve explicit operator binding. Allow workspace activation only with deliberate testing opt-in and the exact current workspace HTTPS host; verify external reachability. Explain that workspace availability limits callbacks and the bot has only one webhook. Changing bot identity or merchant ownership requires a migration, not silently replacing the connection.

An owner-configured first-admin bootstrap must resolve identities independently inside development and production, without importing live Clerk credentials into the workspace.

**Why:** The user requested a production administrator after publishing. Creating only a preview identity would not fulfill that request; blindly promoting an existing email could take over an unrelated account.

**How to apply:** Use trusted deployment configuration and secure initial-password entry. Only reaccept an account carrying the bootstrap's signed creation marker; never reset an existing user's password or restore a revoked admin grant on restart.

Treat uncertain invoice creation and Telegram delivery separately from financial settlement.

**Why:** A provider timeout can still create a payable invoice; a Telegram send can succeed before the process records success. Retrying by creating a new invoice or taking a new stock line could lose funds or expose multiple accounts.

**How to apply:** Keep uncertain reservations for review; release only after authoritative terminal provider status. Retry only the already assigned credential, with at-most-once stock allocation and wallet credits. Do not promise exactly-once Telegram message delivery.
