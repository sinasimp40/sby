import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import type { AccountDriver, AccountFactory } from "./advertising-account-driver";
import { AccountError, isTransportFailure, reportAccountError } from "./advertising-account-errors";

type DriverInput = Parameters<AccountFactory>[0];
type Entry = {
  key: string; driver: AccountDriver; factory: AccountFactory; lease: PoolClient;
  timer?: ReturnType<typeof setTimeout>; onLeaseError: () => void;
  onFailure?: (error: AccountError) => void;
};
const live = new Map<string, Entry>();
const closing = new Map<string, Promise<void>>();
const quarantined = new Map<string, Entry>();
const failed = new Map<string, { key: string; error: AccountError }>();
let stopping = false;
// Retain the original QR lease namespace during the upgrade: old and new
// processes must contend on the same lock, including after login promotion.
const lockKey = (owner: string) => `advertising-qr:${owner}`;
export const loginConnectionKey = (id: string) => `login:${id}`;
export const accountConnectionKey = (generation: number) => `account:${generation}`;

// Call under withAdvertisingLock. The dedicated lease remains held between RPCs.
export async function connectedAccountSession(owner: string, key: string, input: DriverInput, factory: AccountFactory,
  options: { expires?: number; allowRestore?: boolean; recoverTransport?: boolean; onFailure?: (error: AccountError) => void } = {}) {
  if (stopping) throw new AccountError("Account connections are shutting down. No request was sent.", "network", 0, "CONNECTION_CLOSED");
  await closing.get(owner);
  if (quarantined.has(owner)) throw new AccountError("The previous connection could not be fully closed. Restart this server before connecting again.", "network", 0, "CONNECTION_CLOSED");
  const failure = failed.get(owner);
  if (failure?.key === key) {
    if (!options.recoverTransport || !(isTransportFailure(failure.error) ||
      (failure.error.kind === "network" && failure.error.telegramCode === "UNKNOWN"))) throw failure.error;
    failed.delete(owner); // Only the bounded recovery coordinator may opt in.
  }
  const current = live.get(owner);
  if (current?.key === key && current.factory === factory) {
    if (options.onFailure) current.onFailure = options.onFailure;
    return current.driver;
  }
  if (options.allowRestore === false && input.session) throw new AccountError(
    "This pending login lost its original connection, for example after a server restart. Cancel it and review Telegram Devices before starting another login.",
    "expired", 0, "CONNECTION_CLOSED");
  if (current) await closeAccountSession(owner);
  const lease = await pool.connect();
  let locked = false;
  let driver: AccountDriver | undefined;
  let entry: Entry | undefined;
  let published = false;
  let leaseLost = false;
  const onLeaseError = () => {
    leaseLost = true;
    const error = new AccountError("The account connection lost its exclusive server lease and was closed. Review the connection before proceeding.",
      "network", 0, "CONNECTION_LEASE_LOST");
    if (entry && published) failAccountSession(owner, entry.key, error);
    else void driver?.disconnect().catch(() => undefined);
  };
  lease.once("error", onLeaseError);
  try {
    locked = (await lease.query("SELECT pg_try_advisory_lock(hashtextextended($1,76)) AS acquired", [lockKey(owner)])).rows[0]?.acquired === true;
    if (!locked) throw new AccountError("This Telegram account connection is active on another server. Use only one Telecart server. No second connection was opened.", "network", 0, "CONNECTION_LEASE_LOST");
    if (stopping || leaseLost) throw new AccountError("Account connection ownership could not be confirmed.", "network", 0, "CONNECTION_LEASE_LOST");
    driver = factory(input);
    entry = { key, driver, factory, lease, onFailure: options.onFailure, onLeaseError };
    await driver.connect();
    if (stopping || leaseLost) throw new AccountError("Account connection ownership was lost during setup.", "network", 0, "CONNECTION_LEASE_LOST");
    const ready = entry;
    if (options.expires) {
      entry.timer = setTimeout(() => { void closeAccountSession(owner, key).catch(() => undefined); }, Math.max(1, options.expires - Date.now()));
      entry.timer.unref();
    }
    live.set(owner, entry);
    published = true;
    driver.onFailure?.(error => failAccountSession(owner, ready.key, error));
    return driver;
  } catch (error) {
    // A published entry owns its lease; otherwise this setup attempt owns it.
    if (entry) {
      if (!published) quarantined.set(owner, entry);
      await closeAccountSession(owner, key);
    }
    else {
      await driver?.disconnect().catch(() => undefined);
      if (locked) await lease.query("SELECT pg_advisory_unlock(hashtextextended($1,76))", [lockKey(owner)]).catch(() => undefined);
      lease.removeListener("error", onLeaseError);
      lease.release();
    }
    throw error;
  }
}

export function setAccountSessionFailureHandler(owner: string, key: string, handler: (error: AccountError) => void) {
  const entry = live.get(owner);
  if (entry?.key === key) entry.onFailure = handler;
}
export function promoteAccountSession(owner: string, loginId: string, generation: number, driver: AccountDriver) {
  const entry = live.get(owner);
  if (!entry || entry.key !== loginConnectionKey(loginId) || entry.driver !== driver)
    throw new AccountError("The login connection is no longer exclusively owned. No account action was started.", "network", 0, "CONNECTION_LEASE_LOST");
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.key = accountConnectionKey(generation);
  // Pending-login callbacks must not clear a newly promoted authorization.
  entry.onFailure = undefined;
  failed.delete(owner);
}
function failAccountSession(owner: string, key: string, error: AccountError) {
  const entry = live.get(owner);
  if (entry?.key !== key) return;
  failed.set(owner, { key, error });
  reportAccountError(error.telegramCode === "CONNECTION_LEASE_LOST" ? "lease_lost" : "background", error);
  const notify = entry.onFailure;
  void closeAccountSession(owner, key).catch(() => undefined);
  notify?.(error);
}
export async function closeAccountSession(owner: string, key?: string, error?: AccountError) {
  const inFlight = closing.get(owner);
  if (inFlight) { await inFlight; return; }
  const current = live.get(owner) ?? quarantined.get(owner);
  if (!current || (key && current.key !== key)) { await closing.get(owner); return; }
  if (error) failed.set(owner, { key: current.key, error });
  live.delete(owner);
  quarantined.set(owner, current);
  clearTimeout(current.timer);
  const close = (async () => {
    try { await current.driver.disconnect(); }
    catch {
      // Retain the lease if disposal failed. Releasing it would allow another
      // server to open the same authorization while the old TCP may be alive.
      const failure = new AccountError("The account client could not be fully closed. No replacement connection was opened. Restart this server and review Telegram Devices.",
        "network", 0, "CONNECTION_CLOSED");
      failed.set(owner, { key: current.key, error: failure });
      throw failure;
    }
    current.lease.removeListener("error", current.onLeaseError);
    let releaseBroken = false;
    try { await current.lease.query("SELECT pg_advisory_unlock(hashtextextended($1,76))", [lockKey(owner)]); }
    catch { releaseBroken = true; }
    current.lease.release(releaseBroken);
    quarantined.delete(owner);
  })();
  closing.set(owner, close);
  try { await close; }
  finally { if (closing.get(owner) === close) closing.delete(owner); }
}
export async function shutdownAccountSessions() {
  stopping = true;
  await Promise.allSettled([...new Set([...live.keys(), ...quarantined.keys()])].map(owner => closeAccountSession(owner)));
  await Promise.allSettled([...closing.values()]);
}
