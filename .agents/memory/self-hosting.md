---
name: Dashboard controls for self-hosting
description: User wants routine bot operation configurable in the dashboard before moving to their own computer.
---

The user asked to put enable/disable and “everything I need” in the dashboard because they plan to run the app on localhost on their computer.

**Why:** Requiring Replit configuration edits for routine bot operation does not meet the user's self-hosting goal.

**How to apply:** Keep routine bot/provider controls portable and dashboard-managed, with explicit consent before receiver takeover and real messages. Installation trust (database access, encryption secret, owner binding and initial admin credentials) remains a one-time prerequisite, not an unauthenticated setup endpoint. Do not silently activate the bot or copy/reset shop data when adding local support.

The user chose **portable shop-data files inside a ZIP**, rather than a native PostgreSQL archive, for dashboard export/import. They explicitly called complete data preservation crucial.

**Why:** They plan to move the shop to their own computer and want the database records carried with it, not just a product CSV.

**How to apply:** Preserve the complete persistent business dataset and payment/delivery idempotency when evolving transfers. Keep installation secrets and login identity separate. Empty-destination import and a processing hold are intentional safeguards against overwriting money or running two copies.

Previously exported, authenticated shop ZIPs must remain usable when routine product-customization features add fields or datasets.

**Why:** A shop owner preparing a move must not lose access to a valid export simply because they updated the dashboard before importing it.

**How to apply:** Preserve known signed formats and migrate only after signature verification, with safe defaults for new optional features. Custom emoji libraries are portable business data; short-lived emoji pairing links are installation-local authorization, like login sessions.

The user requires that new transfers work with the ZIP alone, without a matching secret or transfer password, and contain a `.db` rather than JSON files.

**Why:** The user lost access to the source key and explicitly requested ZIP-only imports and SQLite files because large JSON logs are difficult to open.

**How to apply:** Keep the live PostgreSQL database and its encryption; use SQLite only for portable transfer files. Do not export the installation secret. Warn clearly that possession of a portable ZIP exposes its stock and saved provider credentials. Preserve legacy authenticated imports without claiming old encrypted values can be recovered without their original key.
