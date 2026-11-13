import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";
import { sqlite, acquireDatabase, bindValue } from "./sqlite-engine";
export { pool, sqlitePath, type PoolClient } from "./sqlite-engine";
export * from "./schema";

// Hold the mutex for the ENTIRE async transaction, not individual statements:
// unrelated requests must never execute inside another request's transaction.
const transactionContext = new AsyncLocalStorage<boolean>();
const database = drizzle(async (sql, parameters, method) => {
  const release = transactionContext.getStore() ? undefined : await acquireDatabase();
  try {
    const statement = sqlite.prepare(sql);
    const values = parameters.map(bindValue);
    if (method === "run") { statement.run(...values); return { rows: [] }; }
    statement.setReturnArrays(true);
    const rows = statement.all(...values) as unknown as unknown[][];
    return { rows: method === "get" ? rows[0] ?? [] : rows };
  } finally { release?.(); }
}, { schema });
const originalTransaction = database.transaction.bind(database);
database.transaction = async (callback, config) => {
  if (transactionContext.getStore()) throw new Error("Use the provided transaction for nested operations.");
  const release = await acquireDatabase();
  try {
    return await transactionContext.run(true, () => originalTransaction(callback, { ...config, behavior: "immediate" }));
  } finally { release(); }
};
export const db = database;
