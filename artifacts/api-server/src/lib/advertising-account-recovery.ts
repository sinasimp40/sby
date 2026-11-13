import type { AccountFactory } from "./advertising-account-driver";
import { createAccountDriver } from "./advertising-account-driver";
import { AccountError, isTransportFailure, reportAccountError } from "./advertising-account-errors";
import { connectedAccountSession, closeAccountSession, accountConnectionKey } from "./advertising-account-session";
import { recordStoppedAccount, watchAccount } from "./advertising-account-auth";
import { withAdvertisingLock, type AdvertisingClient } from "./advertising-store";
import { decryptProviderSecret, encryptProviderSecret } from "./provider-credentials";

const prefix = "Account network recovery";
const delays = [5000, 15000, 45000];
const windowMs = 10 * 60_000;
const history = new Map<string, { generation: number; attempts: number[] }>();
const handled = new WeakSet<AccountError>();
export function recoveryState(message: unknown) {
  if (typeof message !== "string") return null;
  const match = /^Account network recovery \[(\d)\/3;(\d+)\]\./.exec(message);
  if (!match || Number(match[1]) > 3 || !Number.isSafeInteger(Number(match[2]))) return null;
  return { attempts: Number(match[1]), next: Number(match[2]) };
}
const recovering = (attempts: number, next: number) =>
  `${prefix} [${attempts}/3;${next}]. Network interrupted; retrying the saved authorization with limited backoff. No new login and no message replay.`;
function exhausted() {
  return new AccountError("Network recovery stopped after three attempts within ten minutes. Advertising is paused. No new login or message retry was performed.",
    "network", 0, "NETWORK_RECOVERY_EXHAUSTED");
}
function budget(owner: string, generation: number, now: number) {
  let current = history.get(owner);
  if (!current || current.generation !== generation) {
    current = { generation, attempts: [] };
    history.set(owner, current);
  }
  current.attempts = current.attempts.filter(at => now - at < windowMs);
  return current;
}
// All callers hold the owner lock. Only explicit transport failures qualify:
// missing message evidence, revoked keys and lease/disposal failures never do.
export async function queueNetworkRecovery(owner: string, client: AdvertisingClient, generation: number, error: AccountError, now = Date.now()) {
  if (!isTransportFailure(error) || handled.has(error)) return;
  const row = (await client.query("SELECT generation,last_error,session_encrypted,login_encrypted FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
  if (!row || row.generation !== generation || !row.session_encrypted || row.login_encrypted) return;
  const pending = recoveryState(row.last_error);
  if (pending) { handled.add(error); return; }
  // Never downgrade a hard stop to a transport retry. Permit an explicitly
  // checked legacy CONNECTION_LOST/REQUEST_TIMEOUT stop, but no other stop.
  if (row.last_error && !/^Account connection stopped \[(CONNECTION_LOST|REQUEST_TIMEOUT|TRANSPORT_UNAVAILABLE)\]/.test(row.last_error)) return;
  const used = budget(owner, generation, now).attempts.length;
  if (used >= 3) { await recordStoppedAccount(owner, client, generation, exhausted()); handled.add(error); return; }
  await client.query("UPDATE advertising_accounts SET last_error=$3 WHERE owner_id=$1 AND generation=$2",
    [owner, generation, recovering(used, now + delays[used]!)]);
  handled.add(error);
}
export async function recoverAccountConnection(owner: string, client: AdvertisingClient, factory: AccountFactory, now = Date.now()) {
  const row = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
  const state = recoveryState(row?.last_error);
  if (!state || state.next > now || !row.session_encrypted || row.login_encrypted) return;
  const attempts = budget(owner, row.generation, now);
  const used = Math.max(state.attempts, attempts.attempts.length);
  if (used >= 3) { await recordStoppedAccount(owner, client, row.generation, exhausted()); return; }
  const number = used + 1;
  // Persist the consumed attempt before network IO, so a process restart
  // cannot repeatedly replay the same uncounted connection attempt.
  await client.query("UPDATE advertising_accounts SET last_error=$3 WHERE owner_id=$1 AND generation=$2",
    [owner, row.generation, recovering(number, now + delays[Math.min(number, 2)]!)]);
  attempts.attempts.push(now);
  const key = accountConnectionKey(row.generation);
  try {
    const driver = await connectedAccountSession(owner, key, {
      apiId: row.api_id, apiHash: decryptProviderSecret(row.api_hash_encrypted, owner, "advertising-account"),
      session: decryptProviderSecret(row.session_encrypted, owner, "advertising-account"), preserveAuthorization: true,
    }, factory, { recoverTransport: true, onFailure: watchAccount(owner, row.generation) });
    const me = await driver.me(); // Read-only verification, never replay the failed operation.
    if (!me || me.id !== row.account_id) throw new AccountError("The saved authorization does not match this account. Recovery stopped.",
      "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
    await client.query("UPDATE advertising_accounts SET last_error=NULL,checked_at=now(),session_encrypted=$3 WHERE owner_id=$1 AND generation=$2",
      [owner, row.generation, encryptProviderSecret(driver.session(), owner, "advertising-account")]);
    // No catch-up send immediately after downtime. Never enable a stopped group.
    await client.query(`UPDATE advertising_schedules SET next_send_at=now()+interval_seconds*interval '1 second'
      WHERE owner_id=$1 AND running=true AND next_send_at<=now() AND NOT (COALESCE(draft,'{}'::jsonb) ? 'forward')`, [owner]);
    // Forward-loop row times are queue priorities. Preserve their order and
    // postpone the single account gate instead of turning them into group timers.
    await client.query(`UPDATE advertising_accounts SET next_send_at=GREATEST(next_send_at,date_add(now(),
      COALESCE((SELECT max(interval_seconds) FROM advertising_schedules WHERE owner_id=$1 AND running=true AND draft ? 'forward'),0),'second'))
      WHERE owner_id=$1`, [owner]);
  } catch (error) {
    const safe = reportAccountError("recover_connection", error);
    await closeAccountSession(owner, key, safe);
    if (isTransportFailure(safe) || (safe.kind === "network" && safe.telegramCode === "UNKNOWN")) {
      if (number >= 3) await recordStoppedAccount(owner, client, row.generation, exhausted());
      // Otherwise the durable marker already schedules the next bounded attempt.
    } else await recordStoppedAccount(owner, client, row.generation, safe);
  }
}
export async function processAccountRecovery(owner: string, factory: AccountFactory = createAccountDriver) {
  return withAdvertisingLock(owner, client => recoverAccountConnection(owner, client, factory));
}
