import type { AdvertisingImportRow } from "@workspace/api-zod";
import type { AdvertisingClient } from "./advertising-store";
import { withAccountDriver } from "./advertising-account-auth";
import { AccountError, createAccountDriver, safeAccountError, type AccountFactory } from "./advertising-account-driver";
import { segregateAdvertisingTargets } from "./advertising-targets";

type Identity = { chatId: string; title: string };

/** Read-only identity preflight. No joins, permission changes or placeholder rows. */
export async function reviewAdvertisingRows(owner: string, client: AdvertisingClient, inputs: AdvertisingImportRow[],
  factory: AccountFactory = createAccountDriver) {
  const saved = (await client.query("SELECT target,chat_id,kind FROM advertising_groups WHERE owner_id=$1", [owner])).rows;
  const targets = new Set<string>(saved.map(group => group.target));
  const chats = new Set<string>(saved.flatMap(group => group.chat_id ? [group.chat_id] : /^-\d+$/.test(group.target) ? [group.target] : []));
  const identities = new Map<string, Identity>();
  const rows = inputs.map(input => {
    const row = { ...input };
    if (row.target && row.status !== "invalid") {
      if (targets.has(row.target)) {
        row.status = "duplicate";
        row.reason = "Already saved or repeated in this list. Nothing will be added.";
      }
      targets.add(row.target);
    }
    return row;
  });
  const candidates = rows.filter(row => row.target && ["new", "needs_setup"].includes(row.status));
  const account = (await client.query("SELECT 1 FROM advertising_accounts WHERE owner_id=$1", [owner])).rowCount;
  if (account && candidates.length) {
    await withAccountDriver(owner, client, async (driver, connected) => {
      const wait = new Date(connected.telegram_wait_until).getTime() - Date.now();
      if (wait > 0)
        throw new AccountError("Telegram requested a wait. Try the group review after the displayed account wait.", "rate_limit", Math.ceil(wait / 1000));
      const me = await driver.me();
      if (!me || me.id !== connected.account_id)
        throw new AccountError("Verify the connected account before checking group identities.", "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
      if (!driver.membership) throw new AccountError("This account client cannot verify group identities before saving.");
      // Older unverified public entries may have no numeric ID yet. Resolve
      // them read-only so a numeric ID/new alias cannot bypass their identity.
      for (const group of saved.filter(group => !group.chat_id && group.kind !== "chat_id")) {
        try {
          const probe = await driver.membership(group.target);
          if (probe.chatId) chats.add(probe.chatId);
        } catch (error) {
          const safe = safeAccountError(error);
          if (["network", "auth", "restricted", "rate_limit"].includes(safe.kind)) throw safe;
        }
      }
      for (const row of candidates) {
        try {
          const probe = await driver.membership(row.target!);
          if (!probe.chatId || !/^-[1-9]\d*$/.test(probe.chatId))
            throw new AccountError("Cannot verify this group's identity. Use the separate membership preview before saving it.");
          if (/^-\d+$/.test(row.target!) && probe.chatId !== row.target)
            throw new AccountError("The returned group identity does not match this numeric ID.");
          if (chats.has(probe.chatId)) {
            row.status = "duplicate";
            row.reason = "This Telegram group is already saved or appears under another link in this list. Not saved again.";
          } else {
            chats.add(probe.chatId);
            identities.set(row.target!, { chatId: probe.chatId, title: probe.title });
            row.status = "new";
            row.reason = "Unique group identity verified. Posting permissions must still be checked before campaigning.";
          }
        } catch (error) {
          const safe = safeAccountError(error);
          if (["network", "auth", "restricted", "rate_limit"].includes(safe.kind)) throw safe;
          row.status = "invalid";
          row.reason = safe.message;
        }
      }
    }, factory, "membership");
  } else {
    // Legacy bot mode still rejects already-known numeric aliases locally.
    for (const row of candidates) if (chats.has(row.target!)) {
      row.status = "duplicate";
      row.reason = "This group is already saved under another target. Not saved again.";
    }
  }
  return { rows, identities };
}

export const advertisingPreviewRows = (text: string) => segregateAdvertisingTargets(text).rows;
