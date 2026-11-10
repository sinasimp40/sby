---
name: Shared dependency upgrades
description: A pnpm/Vite environment quirk that can make installed React versions disagree with browser bundles.
---

After a workspace React upgrade, a Vite restart alone may still serve optimizer bundles resolved to the old pnpm package paths.

**Why:** This environment retained old React DOM optimizer resolution alongside newly installed React, producing a runtime version mismatch even though package resolution reported matching installed versions.

**How to apply:** When installed versions match but the browser reports a mismatch, inspect optimizer metadata before changing dependency versions again. Treat cached resolution and installed package resolution as separate evidence.
