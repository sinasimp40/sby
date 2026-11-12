---
name: Separate advertising account
description: Merchant-required Telegram personal-account advertising, independent of the shop bot, with explicit recurring group controls.
---

The user now requires advertising through a personal Telegram account, not an advertising bot, inside the same dashboard. Support both phone plus login code and QR login, Telegram two-step verification, selected destination groups, individual group intervals, and Start/Stop controls. Keep advertisement editing, `.txt` group-link segregation and manual group entry.

**Why:** The user explicitly replaced the earlier separate-bot approach with an account that can chat in groups. They were concerned about advertisements interfering with customers using the shop bot.

**How to apply:** Never reuse or change the shop bot credentials/sending path for advertisements. Keep advertising independent of shop maintenance. Stop legacy advertising-bot jobs during the switch, preserve history, and require explicit selected-group confirmation before any account posting.

Account authorization belongs in the protected dashboard, never chat. Explain the API app ID/hash requirement and full-account access, and allow checking connection and revoking the saved session.

**Why:** The user requested both login methods and clear connection feedback; personal Telegram sessions grant substantially broader access than bot tokens.

**How to apply:** Encrypt sessions and pending challenges per owner; never persist codes/passwords or expose saved credentials. Connecting alone never starts posting. Personal accounts cannot attach inline bot buttons: render the optional shop link as ordinary message/caption text.

API ID/hash setup is one-time; later logins should ask only for phone plus code (and two-step password when enabled), or QR.

**Why:** The user explicitly asked to simplify login rather than re-enter app credentials.

**How to apply:** Preserve encrypted app credentials across normal account disconnects and cancelled logins. Provide an explicit confirmed Forget setup action that stops advertising and removes both app credentials and sessions. Never export these credentials.

A group link does not grant membership or posting permission. Do not automatically join groups or message personal contacts.

**Why:** The requested import is a list of destinations, not permission to join or advertise. Assuming otherwise would mislead the merchant and risk unsolicited posts.

**How to apply:** Segregate and deduplicate before saving, discover only already-joined groups/channels, require permission confirmation, and verify membership/posting rights before sends. Keep unresolved invite links out of active schedules.

Absence from a bounded chat list is not proof that an account has not joined a group.

**Why:** A Telegram account's chat list includes personal conversations as well as groups, so the first 1,000 entries can omit a joined destination.

**How to apply:** For public usernames, resolve the group and verify the connected account's membership directly. Keep the confirmed chat ID fixed when a username is resolved again; never redirect a scheduled advertisement to a different group.

Freeze the exact confirmed message, account, recipients and intervals. Never automatically retry an unconfirmed send, catch up missed intervals in a burst, or resume imported advertising jobs.

**Why:** Advertising is an external action that cannot reliably be undone, and a network timeout can occur after Telegram accepted a message.

**How to apply:** Use durable request deduplication, selected-only controls, account-wide Telegram wait periods and explicit uncertain outcomes that stop the affected group. Imported schedules stay stopped. Portable ZIPs include business schedules/history but deliberately exclude personal-account sessions, login challenges and API app credentials; require fresh authorization and group checks.

Phone-code login needs a separate request-attempt policy from advertising sends.

**Why:** GramJS counts a phone data-centre migration as a request attempt. With one attempt it switches servers but exits before requesting the code there, returning an unhelpful generic failure.

**How to apply:** Allow bounded additional attempts only during phone-code initiation and restore the single-attempt policy afterward, including on failure. Do not solve login routing by globally enabling advertising-message retries.
