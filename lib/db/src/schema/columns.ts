// SQLite builders shared by the existing models. Names retained here keep the
// application model contract stable during the storage-engine migration.
import { sql } from "drizzle-orm";
import { customType, integer, text } from "drizzle-orm/sqlite-core";
export { sqliteTable as pgTable, text, integer, uniqueIndex, index, foreignKey, primaryKey, check } from "drizzle-orm/sqlite-core";
export const serial = (name: string) => integer(name).primaryKey({ autoIncrement: true });
export const boolean = (name: string) => integer(name, { mode: "boolean" });
export const jsonb = (name: string) => text(name, { mode: "json" });
export function uuid(name: string) {
  const builder = text(name);
  return Object.assign(builder, {
    defaultRandom() { return builder.notNull().default(sql`(telecart_uuid())`); },
  });
}
const isoDate = customType<{ data: Date; driverData: string }>({
  dataType: () => "text",
  toDriver: value => value.toISOString(),
  fromDriver: value => new Date(value),
});
export function timestamp(name: string, _options?: { withTimezone: boolean }) {
  const builder = isoDate(name);
  // Date metadata is also used by portable archives and drizzle-zod.
  (builder as unknown as { config: { dataType: string } }).config.dataType = "date";
  return Object.assign(builder, {
    defaultNow() { return builder.notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z')`); },
  });
}
