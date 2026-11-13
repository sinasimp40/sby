---
name: Advertising history limits
description: User-requested display and retention limits for personal-account posting activity.
---

Show only ten posting records at a time, allow filtering by a calendar date, and keep normal advertising posting logs for five days.

**Why:** The user explicitly requested ten posts, a date-filter button, and five days of logs to avoid database growth.

**How to apply:** Apply limits on the server as well as the screen. Filter by the same local date shown for the post, including successful sends crossing midnight. Prune expired completed posting history automatically, not shop orders, payments, or start-command deduplication records. Never delete in-flight or current-occurrence evidence before reconciliation: losing it after an outage could cause an already-posted message to be sent again.
