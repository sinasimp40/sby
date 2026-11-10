---
name: Checkout integrity decisions
description: Owner binding and conservative recovery requirements for a single shared Telegram/NOWPayments deployment.
---

Shared service credentials must be bound deliberately to the intended shop owner, never claimed automatically by the first account that signs up. Live activation belongs on the published admin site.

**Why:** The admin app has private per-owner shops, but the deployment holds one merchant API key and one bot token. First-signup claiming would let an unrelated visitor control them, and Clerk preview identities differ from production.

**How to apply:** Preserve explicit operator binding and production-only webhook activation. Changing the bot identity or merchant ownership requires a migration, not silently replacing the connection.

Treat uncertain invoice creation and Telegram delivery separately from financial settlement.

**Why:** A provider timeout can still create a payable invoice; a Telegram send can succeed before the process records success. Retrying by creating a new invoice or taking a new stock line could lose funds or expose multiple accounts.

**How to apply:** Keep uncertain reservations for review; release only after authoritative terminal provider status. Retry only the already assigned credential, with at-most-once stock allocation and wallet credits. Do not promise exactly-once Telegram message delivery.
