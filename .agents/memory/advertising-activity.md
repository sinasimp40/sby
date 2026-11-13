---
name: Advertising history limits
description: User-requested display and retention limits for personal-account posting activity.
---

Show approximately ten posting records in a scrollable window, allow access to additional records for the selected calendar date, and keep normal advertising posting logs for five days.

**Why:** The user explicitly requested a date-filter button and five days of logs to avoid database growth, then clarified that days with more than ten posts must be scrollable rather than capped at ten total results.

**How to apply:** Keep server requests paginated and bounded without making ten a total-history cap. Filter by the same local date shown for the post, including successful sends crossing midnight. Prune expired completed posting history automatically, not shop orders, payments, or start-command deduplication records. Never delete in-flight or current-occurrence evidence before reconciliation: losing it after an outage could cause an already-posted message to be sent again.
