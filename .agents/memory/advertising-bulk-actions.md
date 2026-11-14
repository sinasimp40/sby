---
name: Advertising bulk actions
description: Bulk local group changes must not fan out into individual dashboard writes.
---

Bulk local group-state changes should use one authenticated, owner-scoped request and an atomic transaction, not a loop of individual HTTP writes. Validate every confirmed destination before changing any of them. Retain the dashboard rate limit rather than bypassing or raising it to accommodate a bulk action.

**Why:** Implementing Enable all as individual requests caused HTTP 429 for a normal 181-group selection. Small rendering tests did not exercise the real write limiter.

**How to apply:** For bulk controls, test a realistic batch larger than the per-minute write allowance through the actual authenticated HTTP route with an isolated database. Verify unchanged hidden destinations, no posting or membership side effects, atomic validation, safe retries, and continued rate-limit enforcement.
