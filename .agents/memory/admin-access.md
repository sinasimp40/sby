---
name: Dashboard sign-in requirement
description: User requires admin and password sign-in without OTP for this dashboard.
---

The user explicitly said: "remove that use only admin and password" for the web dashboard, and repeated that OTP must be removed.

**Why:** The user asked for password-only dashboard access and is blocked by the existing OTP flow.

**How to apply:** Do not present an OTP-based flow as satisfying this requirement. The user explicitly approved replacing Clerk dashboard sign-in with a dedicated password-only admin login. Preserve the existing shop owner binding and data; do not restore Clerk's OTP widget in future dashboard work.
