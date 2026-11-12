---
name: Separate advertising bot
description: Merchant-approved separation of group advertising from shop transactions and the safety requirements behind it.
---

The user requires a separate advertising bot controlled from the same dashboard, with its own connection status, advertisement text, `.txt` group-link segregation and manual group entry.

**Why:** The user was concerned that advertising in different groups could interfere with customers using the shop bot. They explicitly chose separate bots.

**How to apply:** Never reuse the shop bot identity or shop sending path for advertisements. Authorize the new bot with its own protected BotFather token; a public bot link alone cannot connect it. Shop maintenance must not implicitly control this independent sender.

A group link does not grant membership or posting permission, and private invite links cannot make a Bot API bot join a group.

**Why:** The requested import is a list of destinations, not permission to join or advertise. Assuming otherwise would mislead the merchant and risk unsolicited posts.

**How to apply:** Segregate and deduplicate before saving, require permission confirmation, verify membership/posting rights before sends, and keep unresolved private links out of campaigns. Do not remove another app's webhook silently.

Freeze the exact confirmed message and recipients; never automatically retry an unconfirmed send or resume imported advertising campaigns.

**Why:** Advertising is an external action that cannot reliably be undone, and a network timeout can occur after Telegram accepted a message.

**How to apply:** Use a separate durable, paced queue with request deduplication, explicit uncertain outcomes and cancellation of unsent work. Portable imports retain history and encrypted credentials but require reconnection checks and group verification before new campaigns.
