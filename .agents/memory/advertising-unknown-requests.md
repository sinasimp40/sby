---
name: Unconfirmed advertising requests
description: User-required UNKNOWN skips without account logout, group departure or automatic replay.
---

An unclassified UNKNOWN Telegram request must not log out or invalidate the advertising account. Skip that group and continue to the next eligible campaign group. Bypassing an UNKNOWN request does not authorize leaving or deleting the group.

**Why:** The user explicitly quoted “Account connection stopped [UNKNOWN]. Telegram did not confirm the request” and said not to log out the session, but to bypass it and move to the next group.

**How to apply:** Preserve the existing authorization and connection when no actual transport/security failure is identified. Keep the skipped occurrence excluded from automatic retries and Resume, including later history cleanup. Preserve Telegram-required waits. Genuine revocation, restrictions, lease loss and identified transport failures still use containment. A legacy UNKNOWN stop can be explicitly checked using the saved authorization; never start a new login or resume a stopped campaign automatically.
