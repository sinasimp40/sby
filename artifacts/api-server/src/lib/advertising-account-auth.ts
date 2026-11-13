import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { pool } from "@workspace/db";
import type { AdvertisingAccount, AdvertisingAccountLoginInput, AdvertisingAccountVerification, AdvertisingAppCredentialsInput } from "@workspace/api-zod";
import { encryptProviderSecret, decryptProviderSecret } from "./provider-credentials";
import { withAdvertisingLock, type AdvertisingClient } from "./advertising-store";
import { stopAdvertising } from "./advertising-management";
import { AccountError, safeAccountError, createAccountDriver, type AccountFactory, type AccountDriver } from "./advertising-account-driver";
import { connectedLoginDriver, closeQrDriver } from "./advertising-account-qr";
import { connectedAccountSession, closeAccountSession, loginConnectionKey, accountConnectionKey,
  promoteAccountSession, setAccountSessionFailureHandler } from "./advertising-account-session";
import { isSessionStopped, isTransportFailure, sessionStopped, stoppedAccountError, reportAccountError, type AccountOperation } from "./advertising-account-errors";
import { queueNetworkRecovery, recoveryState, recoverAccountConnection } from "./advertising-account-recovery";

export type PendingAccountLogin = { id: string; method: "qr" | "phone"; step: "qr" | "code" | "password"; apiId: number; apiHash: string; session: string; phone?: string; hash?: string; qrUrl?: string; expires: number };
const seal = (value: string, owner: string) => encryptProviderSecret(value, owner, "advertising-account");
const open = (value: string, owner: string) => decryptProviderSecret(value, owner, "advertising-account");
export async function stopAccountSchedules(owner: string, client: AdvertisingClient, ids?: string[], note = "Stopped by the merchant.") {
  await client.query(`UPDATE advertising_schedules SET running=false,next_send_at=NULL,revision=revision+1,last_status='stopped',note=$2
    WHERE owner_id=$1 ${ids ? "AND group_id=ANY($3::uuid[])" : ""}`, ids ? [owner, note, ids] : [owner, note]);
  await client.query(`UPDATE advertising_account_runs SET status='uncertain',note='Interrupted posting. Check the group before starting again.'
    WHERE owner_id=$1 AND status='sending' ${ids ? "AND group_id=ANY($2::uuid[])" : ""}`, ids ? [owner, ids] : [owner]);
}
export async function initializeAccountAdvertising(owner: string) {
  return withAdvertisingLock(owner, async client => {
    const exists = (await client.query("SELECT 1 FROM advertising_accounts WHERE owner_id=$1", [owner])).rowCount;
    if (exists) return;
    await stopAdvertising(owner, client);
    await client.query("UPDATE advertising_bots SET token_encrypted=NULL,bot_id=NULL,checked_at=NULL,last_error=NULL WHERE owner_id=$1", [owner]);
    await client.query("UPDATE advertising_groups SET status='pending',account_generation=NULL,checked_at=NULL,note='Connect your Telegram account and check membership/posting permission.' WHERE owner_id=$1", [owner]);
    await client.query("INSERT INTO advertising_accounts(owner_id) VALUES($1) ON CONFLICT DO NOTHING", [owner]);
  });
}
export async function accountStatus(owner: string): Promise<AdvertisingAccount> {
  const row = (await pool.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
  let login: AdvertisingAccount["login"] = null;
  if (row?.login_encrypted && row.login_expires_at) {
    const pending = JSON.parse(open(row.login_encrypted, owner)) as PendingAccountLogin;
    const expired = new Date(row.login_expires_at).getTime() <= Date.now();
    login = { id: pending.id, method: pending.method, step: expired ? "expired" : pending.step,
      expiresAt: new Date(row.login_expires_at),
      qrImage: !expired && pending.step === "qr" && pending.qrUrl ? await QRCode.toDataURL(pending.qrUrl, { margin: 2, width: 240 }) : null };
  }
  return { appConfigured: Boolean(row?.api_id && row.api_hash_encrypted), configured: Boolean(row?.session_encrypted), connected: Boolean(row?.session_encrypted && row.checked_at && !row.last_error && !row.login_encrypted),
    accountId: row?.account_id ?? null, username: row?.username ?? "", displayName: row?.display_name ?? "",
    checkedAt: row?.checked_at?.toISOString() ?? null, error: row?.last_error ?? null, login };
}
async function savePending(owner: string, p: PendingAccountLogin, client: AdvertisingClient) {
  await client.query(`INSERT INTO advertising_accounts(owner_id,login_id,login_encrypted,login_expires_at) VALUES($1,$2,$3,$4)
    ON CONFLICT(owner_id) DO UPDATE SET login_id=EXCLUDED.login_id,login_encrypted=EXCLUDED.login_encrypted,login_expires_at=EXCLUDED.login_expires_at`,
    [owner, p.id, seal(JSON.stringify(p), owner), new Date(p.expires)]);
}
export async function recordStoppedAccount(owner: string, client: AdvertisingClient, generation: number, error: AccountError) {
  const row = (await client.query("SELECT generation,last_error FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
  if (!row || row.generation !== generation) return;
  const message = sessionStopped(error);
  if (row.last_error !== message) await stopAccountSchedules(owner, client, undefined, message);
  await client.query("UPDATE advertising_accounts SET last_error=$2,checked_at=now() WHERE owner_id=$1", [owner, message]);
}
export function watchAccount(owner: string, generation: number) {
  return (error: AccountError) => {
    void withAdvertisingLock(owner, client => isTransportFailure(error)
      ? queueNetworkRecovery(owner, client, generation, error)
      : recordStoppedAccount(owner, client, generation, error))
      .catch(error => { reportAccountError("background", error); });
  };
}
function watchLogin(owner: string, pending: PendingAccountLogin) {
  setAccountSessionFailureHandler(owner, loginConnectionKey(pending.id), error => {
    void withAdvertisingLock(owner, async client => {
      const row = (await client.query("SELECT login_id FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
      if (row?.login_id !== pending.id) return;
      await stopAccountSchedules(owner, client, undefined, sessionStopped(error));
      await client.query("UPDATE advertising_accounts SET login_id=NULL,login_encrypted=NULL,login_expires_at=NULL,last_error=$2 WHERE owner_id=$1", [owner, sessionStopped(error)]);
    }).catch(error => { reportAccountError("background", error); });
  });
}
async function revokePending(owner: string, client: AdvertisingClient, factory: AccountFactory) {
  const row = (await client.query("SELECT login_encrypted FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
  if (!row?.login_encrypted) return;
  let driver: AccountDriver | undefined;
  try {
    const pending = JSON.parse(open(row.login_encrypted, owner)) as PendingAccountLogin;
    driver = await connectedLoginDriver(owner, pending, factory);
    await driver.logout();
  } catch {
    // A pending, unauthorised session may reject logout. Never retain its key.
    // The owner can terminate any already-approved device from Telegram.
  } finally {
    // All login methods now use the managed client; never leave it reusable.
    await closeAccountSession(owner);
    await client.query("UPDATE advertising_accounts SET login_id=NULL,login_encrypted=NULL,login_expires_at=NULL WHERE owner_id=$1", [owner]);
  }
}
async function finishLogin(owner: string, pending: PendingAccountLogin, driver: AccountDriver, client: AdvertisingClient, factory: AccountFactory) {
  const me = await driver.me();
  if (!me) throw new AccountError("Telegram has not completed sign-in yet.");
  const previous = (await client.query("SELECT api_id,api_hash_encrypted,session_encrypted FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
  await stopAccountSchedules(owner, client, undefined, "Account connection changed. Verify groups and start selected groups again.");
  await stopAdvertising(owner, client);
  const saved = (await client.query(`UPDATE advertising_accounts SET api_id=$2,api_hash_encrypted=$3,session_encrypted=$4,account_id=$5,username=$6,
    display_name=$7,generation=generation+1,checked_at=now(),last_error=NULL,login_id=NULL,login_encrypted=NULL,login_expires_at=NULL WHERE owner_id=$1 RETURNING generation`,
    [owner, pending.apiId, seal(pending.apiHash, owner), seal(driver.session(), owner), me.id, me.username, me.displayName])).rows[0];
  promoteAccountSession(owner, pending.id, saved.generation, driver);
  setAccountSessionFailureHandler(owner, accountConnectionKey(saved.generation), watchAccount(owner, saved.generation));
  await client.query("UPDATE advertising_groups SET status='pending',account_generation=NULL,checked_at=NULL,note='Verify this account is a member and may post before starting.' WHERE owner_id=$1", [owner]);
  if (previous?.api_id && previous.api_hash_encrypted && previous.session_encrypted && open(previous.session_encrypted, owner) !== driver.session()) {
    let old: AccountDriver | undefined;
    try {
      old = factory({ apiId: previous.api_id, apiHash: open(previous.api_hash_encrypted, owner), session: open(previous.session_encrypted, owner) });
      await old.connect(); await old.logout();
    } catch {
      await client.query("UPDATE advertising_accounts SET last_error=$2 WHERE owner_id=$1", [owner, "New session saved, but previous remote logout was not confirmed. Review Telegram Settings → Devices, then check this connection."]);
    } finally { await old?.disconnect(); }
  }
}
export async function beginAccountLogin(owner: string, input: AdvertisingAccountLoginInput, factory: AccountFactory = createAccountDriver) {
  if (input.method === "phone" && !/^\+[1-9]\d{6,14}$/.test(input.phone?.trim() ?? "")) throw new AccountError("Enter your phone number in international +country-code format.");
  await initializeAccountAdvertising(owner);
  return withAdvertisingLock(owner, async client => {
    const saved = (await client.query("SELECT api_id,api_hash_encrypted,session_encrypted FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    if ((input.apiId === undefined) !== (input.apiHash === undefined)) throw new AccountError("Provide both API app credentials, or use the saved app setup.");
    const apiId = input.apiId ?? saved?.api_id;
    const apiHash = input.apiHash ?? (saved?.api_hash_encrypted ? open(saved.api_hash_encrypted, owner) : "");
    if (!Number.isInteger(apiId) || apiId < 1 || apiId > 2147483647 || !/^[a-f0-9]{32}$/i.test(apiHash))
      throw new AccountError("Complete the one-time Telegram app setup before signing in.");
    await stopAccountSchedules(owner, client, undefined, "Posting stopped while signing in.");
    await revokePending(owner, client, factory);
    await closeAccountSession(owner);
    await client.query("UPDATE advertising_accounts SET login_id=NULL,login_encrypted=NULL,login_expires_at=NULL WHERE owner_id=$1", [owner]);
    const pending: PendingAccountLogin = { id: randomUUID(), method: input.method, step: input.method === "qr" ? "qr" : "code",
      apiId, apiHash, session: "", phone: input.phone?.trim(), expires: Date.now() + 10 * 60000 };
    const driver = await connectedLoginDriver(owner, pending, factory);
    let keep = false;
    try {
      if (pending.method === "phone") pending.hash = await driver.sendCode(pending.phone!);
      else {
        const qr = await driver.qr();
        pending.qrUrl = qr.url;
      }
      pending.session = driver.session();
      await savePending(owner, pending, client);
      // Preserve a successful first setup even if the merchant cancels login.
      // Existing active sessions keep their original app until replacement succeeds.
      if (!saved?.session_encrypted) await client.query("UPDATE advertising_accounts SET api_id=$2,api_hash_encrypted=$3 WHERE owner_id=$1", [owner, apiId, seal(apiHash, owner)]);
      watchLogin(owner, pending);
      keep = true;
    } catch (error) { throw reportAccountError("begin_login", error); }
    finally {
      if (!keep) await closeAccountSession(owner);
    }
  });
}
export async function saveAccountApp(owner: string, input: AdvertisingAppCredentialsInput) {
  if (!Number.isInteger(input.apiId) || input.apiId < 1 || input.apiId > 2147483647 || !/^[a-f0-9]{32}$/i.test(input.apiHash))
    throw new AccountError("Enter a valid API ID and 32-character API hash from my.telegram.org.");
  await initializeAccountAdvertising(owner);
  return withAdvertisingLock(owner, async client => {
    const row = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    const unchanged = row.api_id === input.apiId && row.api_hash_encrypted && open(row.api_hash_encrypted, owner) === input.apiHash;
    if (!unchanged && (row.session_encrypted || row.login_encrypted)) throw new AccountError("Disconnect the account and cancel any pending login before changing app credentials.");
    await client.query("UPDATE advertising_accounts SET api_id=$2,api_hash_encrypted=$3 WHERE owner_id=$1", [owner, input.apiId, seal(input.apiHash, owner)]);
  });
}
export async function advanceAccountLogin(owner: string, input: AdvertisingAccountVerification, polling = false, factory: AccountFactory = createAccountDriver) {
  return withAdvertisingLock(owner, async client => {
    const row = (await client.query("SELECT login_id,login_encrypted,login_expires_at FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    if (!row?.login_encrypted || row.login_id !== input.loginId) throw new AccountError("This login session is no longer active. Start again.");
    if (new Date(row.login_expires_at).getTime() <= Date.now()) {
      await closeQrDriver(owner, input.loginId);
      throw new AccountError("The sign-in session expired. Cancel and start again.", "expired");
    }
    const pending = JSON.parse(open(row.login_encrypted, owner)) as PendingAccountLogin;
    if (polling && pending.step !== "qr") return;
    if (!polling && pending.step === "code" && !input.code) throw new AccountError("Enter the login code Telegram sent you.");
    if (!polling && pending.step === "password" && !input.password) throw new AccountError("Enter your Telegram two-step password.");
    let driver: AccountDriver | undefined;
    let keep = true;
    try {
      driver = await connectedLoginDriver(owner, pending, factory);
      watchLogin(owner, pending);
      const alreadyAuthorized = await driver.me(true);
      if (!alreadyAuthorized && pending.step === "password") await driver.password(input.password!);
      else if (!alreadyAuthorized && pending.step === "code") await driver.code(pending.phone!, pending.hash!, input.code!);
      else {
        if (!alreadyAuthorized) {
          const qr = await driver.qr();
          pending.qrUrl = qr.url;
          if (!qr.authorized) { pending.session = driver.session(); await savePending(owner, pending, client); return; }
        }
      }
      await finishLogin(owner, pending, driver, client, factory);
    } catch (error) {
      const safe = reportAccountError(polling ? "qr_poll" : "verify_login", error);
      if (safe.kind === "password" && driver) { pending.step = "password"; pending.qrUrl = undefined; pending.session = driver.session(); await savePending(owner, pending, client); return; }
      if (!driver || ["auth", "restricted", "network", "expired", "rate_limit"].includes(safe.kind)) {
        keep = false;
        await stopAccountSchedules(owner, client, undefined, safe.message);
        await client.query("UPDATE advertising_accounts SET login_id=NULL,login_encrypted=NULL,login_expires_at=NULL,last_error=$2 WHERE owner_id=$1", [owner, sessionStopped(safe)]);
      }
      throw safe;
    } finally {
      if (!keep) await closeAccountSession(owner);
    }
  });
}
export async function withAccountDriver<T>(owner: string, client: AdvertisingClient, fn: (driver: AccountDriver, row: Record<string, any>) => Promise<T>, factory: AccountFactory = createAccountDriver, operation: AccountOperation = "account_operation") {
  const row = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
  if (!row?.session_encrypted || !row.api_hash_encrypted || !row.api_id) throw new AccountError("Connect your Telegram account first.");
  if (row.login_encrypted) throw new AccountError("Finish or cancel the pending account login first.");
  if (recoveryState(row.last_error)) throw new AccountError("Network recovery is in progress. No operation was replayed.");
  if (isSessionStopped(row.last_error)) throw stoppedAccountError(row.last_error);
  const key = accountConnectionKey(row.generation);
  let driver: AccountDriver | undefined;
  try {
    driver = await connectedAccountSession(owner, key, { apiId: row.api_id, apiHash: open(row.api_hash_encrypted, owner), session: open(row.session_encrypted, owner) },
      factory, { onFailure: watchAccount(owner, row.generation) });
    const result = await fn(driver, row);
    // A DC migration can change the serialized session. Preserve it encrypted.
    await client.query("UPDATE advertising_accounts SET session_encrypted=$2 WHERE owner_id=$1 AND generation=$3",
      [owner, seal(driver.session(), owner), row.generation]);
    return result;
  }
  catch (error) {
    const safe = reportAccountError(operation, error);
    if (["auth", "restricted", "network"].includes(safe.kind)) {
      if (isTransportFailure(safe)) await queueNetworkRecovery(owner, client, row.generation, safe);
      else await recordStoppedAccount(owner, client, row.generation, safe);
      await closeAccountSession(owner, key, safe);
    } else if (safe.kind === "rate_limit") {
      await client.query(`UPDATE advertising_accounts SET
        telegram_wait_until=greatest(telegram_wait_until,now()+$2*interval '1 second'),
        next_send_at=greatest(next_send_at,now()+$2*interval '1 second') WHERE owner_id=$1`, [owner, safe.waitSeconds]);
    }
    throw safe;
  }
}
export async function checkAccountConnection(owner: string, factory: AccountFactory = createAccountDriver) {
  return withAdvertisingLock(owner, async client => {
    const row = (await client.query("SELECT generation,last_error FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    if (/^Account connection stopped \[(CONNECTION_LOST|REQUEST_TIMEOUT|TRANSPORT_UNAVAILABLE)\]/.test(row?.last_error ?? ""))
      await queueNetworkRecovery(owner, client, row.generation, stoppedAccountError(row.last_error));
    if (recoveryState((await client.query("SELECT last_error FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0]?.last_error)) {
      await recoverAccountConnection(owner, client, factory);
      return;
    }
    try {
      await withAccountDriver(owner, client, async (driver, row) => {
        const me = await driver.me();
        if (!me || me.id !== row.account_id) throw new AccountError("The saved account identity could not be verified. Review Telegram Devices before another login.", "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
        await client.query("UPDATE advertising_accounts SET checked_at=now(),last_error=NULL WHERE owner_id=$1", [owner]);
      }, factory, "check_account");
    } catch (error) {
      const safe = safeAccountError(error);
      if (isTransportFailure(safe)) return; // Already queued; do not turn a recoverable drop into a hard stop.
      await stopAccountSchedules(owner, client, undefined, "Posting stopped because the account connection could not be verified.");
      await client.query("UPDATE advertising_accounts SET checked_at=now(),last_error=$2 WHERE owner_id=$1", [owner,
        ["auth", "restricted", "network"].includes(safe.kind) ? sessionStopped(safe) : safe.message]);
    }
  });
}
export async function cancelAccountLogin(owner: string, factory: AccountFactory = createAccountDriver) {
  return withAdvertisingLock(owner, async client => {
    await revokePending(owner, client, factory);
    await client.query("UPDATE advertising_accounts SET login_id=NULL,login_encrypted=NULL,login_expires_at=NULL WHERE owner_id=$1", [owner]);
  });
}
export async function disconnectAccount(owner: string, factory: AccountFactory = createAccountDriver, forgetApp = false) {
  return withAdvertisingLock(owner, async client => {
    await stopAccountSchedules(owner, client);
    await revokePending(owner, client, factory);
    let warning: string | null = null;
    const hasSession = (await client.query("SELECT 1 FROM advertising_accounts WHERE owner_id=$1 AND session_encrypted IS NOT NULL", [owner])).rowCount;
    try { if (hasSession) await withAccountDriver(owner, client, driver => driver.logout(), factory); }
    catch { warning = "Local session removed. Telegram could not confirm remote logout; terminate Telecart Advertising in Telegram Settings → Devices."; }
    finally { await closeAccountSession(owner); }
    await client.query(`UPDATE advertising_accounts SET api_id=CASE WHEN $3 THEN NULL ELSE api_id END,
      api_hash_encrypted=CASE WHEN $3 THEN NULL ELSE api_hash_encrypted END,session_encrypted=NULL,account_id=NULL,username='',
      display_name='',generation=generation+1,checked_at=NULL,last_error=$2,login_id=NULL,login_encrypted=NULL,login_expires_at=NULL WHERE owner_id=$1`, [owner, warning, forgetApp]);
    await client.query("UPDATE advertising_groups SET account_generation=NULL,status='pending',checked_at=NULL WHERE owner_id=$1", [owner]);
  });
}
