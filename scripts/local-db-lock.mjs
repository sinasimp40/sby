import { readFileSync, openSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolveSqlitePath } from "./sqlite-path.mjs";

export async function reviewLocalDatabaseLock(databasePath, {
  ask, host = hostname(), probe = pid => process.kill(pid, 0),
} = {}) {
  const file = resolveSqlitePath(databasePath);
  if (file.startsWith("\\\\")) throw new Error("Choose a private local SQLite file, not a shared network folder.");
  const lockPath = `${file}.lock`;
  let original;
  try { original = readFileSync(lockPath, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return; throw new Error("Cannot inspect the database lock. Check local folder permissions."); }
  let lock;
  try { lock = JSON.parse(original); } catch { /* refuse ambiguous locks */ }
  if (!lock?.host || !Number.isInteger(lock.pid) || lock.pid < 1 || !lock.token) {
    throw new Error("The SQLite lock is incomplete or unknown. Stop all Telecart copies and review the lock file before retrying; it was not removed.");
  }
  if (lock.host === host) {
    try { probe(lock.pid); }
    catch (error) { if (error.code === "ESRCH") return; }
    throw new Error(`SQLite is already open or process ${lock.pid} cannot be checked. Stop the existing Telecart window before retrying. Its lock was not removed.`);
  }
  console.warn("This SQLite file has a lock from a different computer.");
  console.warn("Stop the original shop first. Continue only for a private local copy, never a shared drive or two running copies.");
  console.warn("This preserves the database and moves only the old lock aside. Saved work may resume after the separate processing confirmation.");
  if (!ask || await ask("Type USE THIS LOCAL COPY to confirm the original is stopped, or press Enter to cancel: ") !== "USE THIS LOCAL COPY") {
    throw new Error("Local database takeover cancelled. Database, configuration and lock were left unchanged.");
  }
  // Coordinate with the live engine's recovery mechanism; never overwrite an
  // existing recovery claim or a lock that changed while confirmation was open.
  let fd;
  try { fd = openSync(`${lockPath}.recovery`, "wx", 0o600); }
  catch { throw new Error("Another process is reviewing this database lock. Retry once it finishes."); }
  try {
    if (readFileSync(lockPath, "utf8") !== original) throw new Error("The database lock changed. It was not removed; stop the other process and retry.");
    renameSync(lockPath, `${lockPath}.reviewed-${randomUUID()}`);
  } finally { closeSync(fd); unlinkSync(`${lockPath}.recovery`); }
  console.log("Copied database lock moved aside after confirmation. Database records and installation settings were preserved.");
}
