---
name: Dashboard controls for self-hosting
description: User wants routine bot operation configurable in the dashboard before moving to their own computer.
---

The user asked to put enable/disable and “everything I need” in the dashboard because they plan to run the app on localhost on their computer.

**Why:** Requiring Replit configuration edits for routine bot operation does not meet the user's self-hosting goal.

**How to apply:** Keep routine bot/provider controls portable and dashboard-managed, with explicit consent before receiver takeover and real messages. Installation trust (database access, encryption secret, owner binding and initial admin credentials) remains a one-time prerequisite, not an unauthenticated setup endpoint. Do not silently activate the bot or copy/reset shop data when adding local support.
