import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { AccountError, type AccountDriver, type AccountFactory } from "./advertising-account-driver";

type PendingQr = { id: string; expires: number; apiId: number; apiHash: string; session: string };
type LiveQr = { id: string; driver: AccountDriver; lease: PoolClient; timer: ReturnType<typeof setTimeout>; onLeaseError: () => void };
const live = new Map<string, LiveQr>();
const lockKey = (owner: string) => `advertising-qr:${owner}`;

// A QR challenge needs its connected client to receive UpdateLoginToken.
// Hold a dedicated database lease so a second process cannot reuse its auth key
// concurrently (including from another server/IP).
export async function closeQrDriver(owner: string, id?: string) {
  const current = live.get(owner);
  if (!current || (id && current.id !== id)) return;
  live.delete(owner);
  clearTimeout(current.timer);
  current.lease.removeListener("error", current.onLeaseError);
  try { await current.driver.disconnect(); }
  finally {
    await current.lease.query("SELECT pg_advisory_unlock(hashtextextended($1,76))", [lockKey(owner)]).catch(() => undefined);
    current.lease.release();
  }
}

export async function connectedQrDriver(owner: string, pending: PendingQr, factory: AccountFactory) {
  const current = live.get(owner);
  if (current?.id === pending.id) return current.driver;
  if (current) await closeQrDriver(owner);
  const lease = await pool.connect();
  let locked = false;
  let driver: AccountDriver | undefined;
  try {
    const result = await lease.query("SELECT pg_try_advisory_lock(hashtextextended($1,76)) AS acquired", [lockKey(owner)]);
    locked = result.rows[0]?.acquired === true;
    if (!locked) throw new AccountError("This QR login is active on another server. Use one Telecart server and keep the same login page open; do not repeatedly reconnect.", "network");
    driver = factory(pending);
    await driver.connect();
    const timer = setTimeout(() => { void closeQrDriver(owner, pending.id).catch(() => undefined); }, Math.max(1, pending.expires - Date.now()));
    timer.unref();
    const onLeaseError = () => { void closeQrDriver(owner, pending.id).catch(() => undefined); };
    live.set(owner, { id: pending.id, driver, lease, timer, onLeaseError });
    lease.once("error", onLeaseError);
    return driver;
  } catch (error) {
    await driver?.disconnect().catch(() => undefined);
    if (locked) await lease.query("SELECT pg_advisory_unlock(hashtextextended($1,76))", [lockKey(owner)]).catch(() => undefined);
    lease.release();
    throw error;
  }
}
