---
name: Separate advertising account
description: Merchant-required Telegram personal-account advertising, independent of the shop bot, with explicit recurring group controls.
---

The user explicitly requires advertising through their own Telegram client account, not an advertising bot, inside the same dashboard. Support both phone plus login code and QR login, Telegram two-step verification, selected destination groups, individual group intervals, and Start/Stop controls. Keep `.txt` group-link segregation and manual group entry.

**Why:** The user explicitly replaced the earlier separate-bot approach with an account that can chat in groups. They were concerned about advertisements interfering with customers using the shop bot.

**How to apply:** Keep the personal-account approach when diagnosing authentication or Telegram security notifications; do not propose replacing it with an advertising bot. Never reuse or change the shop bot credentials/sending path for advertisements. Keep advertising independent of shop maintenance. Stop legacy advertising-bot jobs during the switch, preserve history, and require explicit selected-group confirmation before any account posting.

Advertising content should be selected from the user's Telegram Saved Messages and forwarded to the chosen groups, rather than recreated in an advertisement editor.

**Why:** The user clarified: “all we need is to select the message” saved in Saved Messages and forward it to the groups.

**How to apply:** Treat the custom-formatting editor approach as superseded for the primary workflow. Use native forwarding, retain selected-group and interval controls, and respect Telegram's forwarding restrictions rather than silently copying or rebuilding unsupported content.

Account authorization belongs in the protected dashboard, never chat. Explain the API app ID/hash requirement and full-account access, and allow checking connection and revoking the saved session.

**Why:** The user requested both login methods and clear connection feedback; personal Telegram sessions grant substantially broader access than bot tokens.

**How to apply:** Encrypt sessions and pending challenges per owner; never persist codes/passwords or expose saved credentials. Connecting alone never starts posting. Personal accounts cannot attach inline bot buttons: render the optional shop link as ordinary message/caption text.

API ID/hash setup is one-time; later logins should ask only for phone plus code (and two-step password when enabled), or QR.

**Why:** The user explicitly asked to simplify login rather than re-enter app credentials.

**How to apply:** Preserve encrypted app credentials across normal account disconnects and cancelled logins. Provide an explicit confirmed Forget setup action that stops advertising and removes both app credentials and sessions. Never export these credentials.

A group link does not grant membership or posting permission. Do not automatically join groups or message personal contacts.

**Why:** The requested import is a list of destinations, not permission to join or advertise. Assuming otherwise would mislead the merchant and risk unsolicited posts.

**How to apply:** Segregate and deduplicate before saving, discover only already-joined groups/channels, require permission confirmation, and verify membership/posting rights before sends. Keep unresolved invite links out of active schedules.

Absence from a bounded chat list is not proof that an account has not joined a group.

**Why:** A Telegram account's chat list includes personal conversations as well as groups, so the first 1,000 entries can omit a joined destination.

**How to apply:** For public usernames, resolve the group and verify the connected account's membership directly. Keep the confirmed chat ID fixed when a username is resolved again; never redirect a scheduled advertisement to a different group.

The installed GramJS `ignoreMigrated` option incorrectly excludes channels and supergroups from dialog discovery.

**Why:** Its dialog iterator tests for the presence of a migrated-chat property instead of excluding only chats with a migration destination. Discovery can consequently return success with no joined supergroups.

**How to apply:** Fetch unfiltered dialogs and exclude obsolete/left groups explicitly. Retain a regression test through the real SDK dialog iterator, not only a mocked group list, when upgrading GramJS.

Freeze the exact confirmed message, account, recipients and intervals. Never automatically retry an unconfirmed send, catch up missed intervals in a burst, or resume imported advertising jobs.

**Why:** Advertising is an external action that cannot reliably be undone, and a network timeout can occur after Telegram accepted a message.

**How to apply:** Use durable request deduplication, selected-only controls, account-wide Telegram wait periods and explicit uncertain outcomes that stop the affected group. Imported schedules stay stopped. Portable ZIPs include business schedules/history but deliberately exclude personal-account sessions, login challenges and API app credentials; require fresh authorization and group checks.

Phone-code login needs a separate request-attempt policy from advertising sends.

**Why:** GramJS counts a phone data-centre migration as a request attempt. With one attempt it switches servers but exits before requesting the code there, returning an unhelpful generic failure.

**How to apply:** Allow bounded additional attempts only during phone-code initiation and restore the single-attempt policy afterward, including on failure. Do not solve login routing by globally enabling advertising-message retries.

Treat Telegram security notifications and session revocations as a reason to stop, not to repeatedly authenticate or try alternate connections.

**Why:** Account-level security actions can revoke devices and bot credentials beyond the advertising feature. Reusing one pending account authorization concurrently from different servers can invalidate it; read-only channel checks are not proof that Telegram will consider a session safe.

**How to apply:** Keep pending QR ownership exclusive across servers, never automatically retry a failed login indefinitely, and preserve read-only group checks. Diagnose with synthetic RPC/browser responses unless a real account action is explicitly authorized. Do not claim app fixes can reverse Telegram restrictions or prove what caused a security notification.

Prioritize session containment after security failures, but distinguish temporary network loss from revoked authorization.

**Why:** The user approved hardening after repeated security notices, then explicitly approved bounded network recovery when transient transport drops stopped advertising even though Telegram still listed the authorization in Devices. A network socket closure alone does not establish revocation; repeatedly creating new logins is not the remedy.

**How to apply:** Keep exclusive ownership and fully dispose of the old client before bounded transport recovery. Reuse and pin the saved authorization, verify the same account, and never enable the SDK's request-replaying reconnect loop. Security/identity failures, lease loss, failed disposal and exhausted recovery remain hard stops. Never replay uncertain posts, enable paused groups or send catch-up bursts. Locks protect only installations sharing their database, not separately copied databases.

Do not rely solely on GramJS 2.26's `autoReconnect: false` option.

**Why:** The installed sender stores that setting but does not consult it in its reconnect path, including delayed retries. A declared no-reconnect policy is not enforced by that option.

**How to apply:** Preserve explicit sender/lifecycle guards and native-SDK regression coverage. Re-audit this behavior when changing versions; never allow a closed or failed client to send the next RPC or a delayed post.

Load a saved GramJS StringSession before deciding whether its authorization key exists.

**Why:** Its constructor decodes serialized key bytes, but the public `authKey` remains empty until asynchronous `load()` completes. Checking immediately would incorrectly reject every valid stored authorization during recovery.

**How to apply:** Await loading before pinning a copy of the existing key, and keep a regression using a real serialized SDK session with all network methods mocked. Never respond to a missing key by generating another authorization automatically.

Check upstream maintenance and distinguish logout reports from verified fixes before changing Telegram client libraries.

**Why:** On 2026-11-12, the GramJS GitHub repository displayed an archived status dated 2026-07-14. Its cloud-hosted logout reports describe similar symptoms even with static IPs, but do not establish a cause or reliable remedy for this shop.

**How to apply:** Recheck current maintenance before upgrades or migrations. Do not present a library switch, geographic match, changed client metadata or hosting change as a guaranteed solution to security notifications.

Advertising browser tests must fail closed on unmocked external-capable requests.

**Why:** A synthetic workspace response alone does not isolate the real saved API app credentials. If browser interception misses the begin-login POST, the live backend can still create a real pending Telegram challenge.

**How to apply:** Prove mutation interception or use a fully isolated fake server before clicking login, verification, discovery, channel checks or posting. An interception miss is a reason to stop and clean up the exact test-created challenge, not retry the live flow.

Treat posting success as evidence captured at send time, not as proof that a message remains visible.

**Why:** The user reported a successful activity entry with no visible group message, followed by a disconnect. Previously, an RPC resolving without throwing was enough to claim success; that does not establish a usable message receipt or continued visibility.

**How to apply:** Require a correlated receipt and exact-group read-back before success. Never resend merely because confirmation/read-back failed, and never retroactively certify historical records that lack evidence. Keep connection loss separate from message verification: a later disconnection neither disproves an earlier verified post nor explains whether moderators removed it.

Keep advertisement fingerprints independent of PostgreSQL JSON object-key order.

**Why:** JSONB can reorder entity fields across a save or portable ZIP restore. Comparing serialized raw objects can report a change even when text and formatting are identical, undermining dirty tracking and duplicate-start protection.

**How to apply:** Canonicalize formatting ranges and field order before fingerprinting; compare restored metadata structurally in tests rather than comparing raw JSON strings. Preserve exact message text when formatting offsets are present.

Message and emoji previews must not broaden account activity just to display artwork.

**Why:** The account has experienced security notifications and authorization resets. Additional media downloads and data-centre authorizations need a separate containment review.

**How to apply:** Keep pack lookup explicitly requested and read-only, without installing packs or posting. Any future artwork preview must preserve the main session's containment guarantees; do not silently enable SDK reconnects or use the shop bot as a substitute.
