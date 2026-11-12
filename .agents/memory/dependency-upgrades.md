---
name: Shared dependency upgrades
description: Runtime and cached-resolution differences that can break tooling independently of the app.
---

After a workspace React upgrade, a Vite restart alone may still serve optimizer bundles resolved to the old pnpm package paths.

**Why:** This environment retained old React DOM optimizer resolution alongside newly installed React, producing a runtime version mismatch even though package resolution reported matching installed versions.

**How to apply:** When installed versions match but the browser reports a mismatch, inspect optimizer metadata before changing dependency versions again. Treat cached resolution and installed package resolution as separate evidence.

Code-generation dependencies can require newer JavaScript runtime features even when the app and TypeScript checks still work.

**Why:** Orval's Zod generator started relying on a collection API unavailable in this project's Node 20 runtime. Generation failed after cleaning the previous output, making otherwise valid server imports temporarily disappear.

**How to apply:** Diagnose the generator's runtime separately from application dependencies and schema validity. Preserve Node 20 compatibility unless a runtime upgrade is explicitly in scope; regenerate both client and validation outputs after a failed generation.
