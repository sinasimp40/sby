---
name: Dashboard sign-in requirement
description: User requires admin and password sign-in without OTP for this dashboard.
---

The user explicitly said: "remove that use only admin and password" for the web dashboard, and repeated that OTP must be removed.

**Why:** The user asked for password-only dashboard access and is blocked by the existing OTP flow.

**How to apply:** Do not present an OTP-based flow as satisfying this requirement. The user explicitly approved replacing Clerk dashboard sign-in with a dedicated password-only admin login. Preserve the existing shop owner binding and data; do not restore Clerk's OTP widget in future dashboard work.

Password-only dashboard access does not remove the existing identity bootstrap's provider password requirements.

**Why:** An imported workspace could render the public dashboard, but its API refused to start when the securely supplied bootstrap password was rejected as too short. The generic startup error hid that cause.

**How to apply:** For a fresh environment, request a strong, unique bootstrap password through Secrets. If bootstrap fails, inspect only sanitized provider error codes, never passwords or raw provider payloads; do not bypass password checks or replace the requested login with OTP.

Keep the dashboard and unsaved selections visible during temporary background connection failures; do not treat a failed request as confirmed logout.

**Why:** The user reported whole-app refreshing and approved preserving the screen while background checks reconnect.

**How to apply:** Show a nonblocking connection warning and retry. Confirmed signed-out responses, authorization rejection and genuine owner changes must still clear private state; cached UI must never replace server authorization.
