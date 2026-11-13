---
name: Shared dependency upgrades
description: Runtime and cached-resolution differences that can break tooling independently of the app.
---

After a workspace React upgrade, a Vite restart alone may still serve optimizer bundles resolved to the old pnpm package paths.

**Why:** This environment retained old React DOM optimizer resolution alongside newly installed React, producing a runtime version mismatch even though package resolution reported matching installed versions.

**How to apply:** When installed versions match but the browser reports a mismatch, inspect optimizer metadata before changing dependency versions again. Treat cached resolution and installed package resolution as separate evidence.

Code-generation dependencies can require newer JavaScript runtime features even when the app and TypeScript checks still work.

**Why:** Orval's Zod generator started relying on a collection API unavailable in this project's Node 20 runtime. Generation failed after cleaning the previous output, making otherwise valid server imports temporarily disappear.

**How to apply:** Diagnose the generator's runtime separately from application dependencies and schema validity; passing app type checks do not validate the generator runtime. Regenerate both client and validation outputs after a failed generation.

Do not prune other operating systems' optional native dependencies to optimize Replit-only installs.

**Why:** Linux checks passed while the inherited workspace overrides explicitly removed Windows Rollup, esbuild, Tailwind Oxide and Lightning CSS bindings. Fixing only the first missing module would leave the next Windows failure in place.

**How to apply:** Keep the dependency graph portable for the user's localhost installation. Test native package loading and actual client/CSS transforms, not just package-directory presence or an HTTP response serving index.html. Distinguish Linux results from execution on a real Windows runner.

Drizzle Kit can misread an absolute migration output directory as a path prefixed with `./`.

**Why:** Migration generation failed to load an existing snapshot even though the snapshot was present; passing the output directory relative to the current working directory resolved it without changing packages.

**How to apply:** If generation reports a snapshot path containing `.//` followed by an absolute workspace path, verify the file exists and use a working-directory-relative output path before regenerating snapshots or replacing dependencies.
