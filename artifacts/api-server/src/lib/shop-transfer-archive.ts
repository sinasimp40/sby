import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { z } from "zod/v4";
import { CommerceError } from "./commerce-providers";
import {
  parseTransferData, tableKeys, transferSchemaHash, singleItemTransferSchemaHash, quantityTransferSchemaHash, productEmojiTransferSchemaHash, customEmojiTransferSchemaHash, MAX_TRANSFER_BYTES, MAX_ZIP_BYTES,
  stockAnnouncementTransferSchemaHash, type TransferData,
} from "./shop-transfer-tables";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const countsSchema = z.record(z.string(), z.number().int().nonnegative());
const manifestSchema = z.object({
  format: z.literal("telecart-shop-data"), version: z.literal(1),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(), sourceOwnerId: z.string().min(1).max(300),
  counts: countsSchema, dataSha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
function secret() {
  if (!process.env.SESSION_SECRET) throw new CommerceError("Configure the original SESSION_SECRET before transferring encrypted shop data.", 503);
  return process.env.SESSION_SECRET;
}
function signature(manifest: Omit<Manifest, "signature">) {
  return createHmac("sha256", secret()).update(JSON.stringify(manifest)).digest("hex");
}
export const transferReadme = `TELECART PORTABLE SHOP DATA

This is a one-time application-data export, not a PostgreSQL backup or a code archive.
manifest.json records the format, schema fingerprint, counts and authenticated checksum.
shop-data.json contains ALL rows of the listed tables for this shop at one consistent read-only snapshot.
JSONB columns are encoded as JSON text to preserve large numbers exactly. UTC timestamp
strings retain PostgreSQL microseconds rather than rounding through JavaScript dates.

Includes products, encrypted inventory, customers and balances, payments and cancellation
markers, wallet credits, legacy records, settings, activity, encrypted provider credentials,
bot runtime/connection settings and that bot's Telegram update deduplication records.

Not included: login sessions, admin login passwords, SESSION_SECRET, database connection
credentials, other shops, application code, PostgreSQL schema or platform configuration.
Provider credentials held ONLY in environment variables must be configured separately.

SECURITY: The ZIP contains customer and financial data. Treat it as confidential.
Inventory and saved provider secrets remain encrypted; the matching original SESSION_SECRET
must be configured securely on the destination. Never send that key in chat or add it to this ZIP.
Only the matching Telecart schema/format can import this file. Do not edit archive contents.

Import only into an EMPTY shop. It is atomic and does not merge or overwrite financial history.
Numeric product/inventory IDs may be remapped; relationships and encrypted delivery data are preserved.
The bot and payment processing remain paused after import. Public callback URLs are cleared,
polling mode is selected, and unfinished Telegram selections are cleared. Stop the SOURCE server,
review pending payments and delivered orders before acknowledging the transfer, then verify
credentials and enable the destination bot. Never run two copies of the same shop.

Importing an older export loses all changes made after that export. For a move, stop source
processing, download a FINAL export, and keep the source stopped. Replit database disaster
recovery uses its own checkpoint/PITR tools, not this feature.
`;

export function encodeShopArchive(sourceOwnerId: string, data: TransferData) {
  // Validate even internally generated exports; no partial ZIP if schema/limits fail.
  const parsed = parseTransferData(JSON.parse(JSON.stringify(data)));
  const bytes = strToU8(JSON.stringify(parsed));
  if (bytes.length > MAX_TRANSFER_BYTES) throw new CommerceError("Shop data exceeds the 30 MB portable transfer limit. No partial export was created.", 413);
  const core = {
    format: "telecart-shop-data" as const, version: 1 as const, schemaHash: transferSchemaHash,
    createdAt: new Date().toISOString(), sourceOwnerId,
    counts: Object.fromEntries(tableKeys.map(key => [key, parsed[key].length])),
    dataSha256: digest(bytes),
  };
  const manifest: Manifest = { ...core, signature: signature(core) };
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "shop-data.json": bytes, "README.txt": strToU8(transferReadme),
  }, { level: 6 });
  if (zip.length > MAX_ZIP_BYTES) throw new CommerceError("ZIP exceeds the 20 MB portable transfer limit. No partial export was created.", 413);
  return { zip: Buffer.from(zip), manifest };
}

export function decodeShopArchive(zip: Buffer) {
  try {
    if (!zip.length || zip.length > MAX_ZIP_BYTES) throw new Error("ZIP size exceeds the allowed limit.");
    const seen = new Set<string>();
    let expanded = 0;
    const files = unzipSync(zip, { filter(file) {
      if (!["manifest.json", "shop-data.json", "README.txt"].includes(file.name) || seen.has(file.name)) throw new Error("Unexpected or duplicate ZIP entry.");
      seen.add(file.name);
      expanded += file.originalSize;
      if (expanded > MAX_TRANSFER_BYTES + 50000 || file.originalSize > MAX_TRANSFER_BYTES) throw new Error("Expanded ZIP is too large.");
      return true;
    } });
    if (seen.size !== 3 || !files["manifest.json"] || files["manifest.json"].length > 20000 || !files["shop-data.json"]) throw new Error("Required archive files are missing.");
    const manifest = manifestSchema.parse(JSON.parse(strFromU8(files["manifest.json"])));
    const { signature: signed, ...core } = manifest;
    if (![transferSchemaHash, stockAnnouncementTransferSchemaHash, singleItemTransferSchemaHash, quantityTransferSchemaHash, productEmojiTransferSchemaHash, customEmojiTransferSchemaHash].includes(manifest.schemaHash)) throw new Error("The app schema differs. Use the same Telecart version on source and destination.");
    if (digest(files["shop-data.json"]) !== manifest.dataSha256) throw new Error("Data checksum does not match.");
    if (!timingSafeEqual(Buffer.from(signed, "hex"), Buffer.from(signature(core), "hex"))) {
      throw new Error("Cannot authenticate this archive. Configure the matching original SESSION_SECRET and use an unmodified export.");
    }
    const rawData = JSON.parse(strFromU8(files["shop-data.json"]));
    const legacy = [singleItemTransferSchemaHash, quantityTransferSchemaHash, productEmojiTransferSchemaHash].includes(manifest.schemaHash);
    // Verify signed legacy table counts BEFORE introducing safe new defaults.
    if (legacy) {
      const oldKeys = tableKeys.filter(key => key !== "customEmojis");
      if (!rawData || typeof rawData !== "object" || "customEmojis" in rawData ||
        Object.keys(rawData).length !== oldKeys.length || Object.keys(manifest.counts).length !== oldKeys.length ||
        oldKeys.some(key => !Array.isArray(rawData[key]) || rawData[key].length !== manifest.counts[key])) throw new Error("Table counts do not match.");
      rawData.customEmojis = [];
      rawData.products = rawData.products.map((row: Record<string, unknown>) => {
        if (!row || typeof row !== "object" || "buttonCustomEmojiId" in row) throw new Error("Invalid legacy product shape.");
        return { ...row, buttonCustomEmojiId: null };
      });
    }
    if ([singleItemTransferSchemaHash, quantityTransferSchemaHash].includes(manifest.schemaHash) && Array.isArray(rawData?.products)) {
      rawData.products = rawData.products.map((row: Record<string, unknown>) => {
        if (!row || typeof row !== "object" || "buttonEmoji" in row) throw new Error("Invalid legacy product shape.");
        return { ...row, buttonEmoji: "🛍" };
      });
    }
    // Authenticated exports created before quantity support remain importable.
    if (manifest.schemaHash === singleItemTransferSchemaHash && Array.isArray(rawData?.payments)) {
      rawData.payments = rawData.payments.map((row: Record<string, unknown>) => {
        if (!row || typeof row !== "object" || "quantity" in row || "inventoryIds" in row) throw new Error("Invalid legacy payment shape.");
        return { ...row, quantity: 1, inventoryIds: null };
      });
    }
    if (![transferSchemaHash, stockAnnouncementTransferSchemaHash].includes(manifest.schemaHash) && Array.isArray(rawData?.products)) {
      rawData.products = rawData.products.map((row: Record<string, unknown>) => {
        if (!row || typeof row !== "object" || "stockAnnouncedAt" in row) throw new Error("Invalid legacy product shape.");
        const stocked = Array.isArray(rawData.inventory) && rawData.inventory.some((stock: Record<string, unknown>) => stock.productId === row.id);
        return { ...row, stockAnnouncedAt: stocked ? row.createdAt : null };
      });
    }
    if (manifest.schemaHash !== transferSchemaHash && Array.isArray(rawData?.products)) {
      rawData.products = rawData.products.map((row: Record<string, unknown>) => {
        if (!row || typeof row !== "object" || "imageUrl" in row) throw new Error("Invalid legacy product shape.");
        return { ...row, imageUrl: null };
      });
    }
    const data = parseTransferData(rawData);
    if (!legacy && (Object.keys(manifest.counts).length !== tableKeys.length || tableKeys.some(key => manifest.counts[key] !== data[key].length))) throw new Error("Table counts do not match.");
    return { data, manifest, archiveHash: digest(zip) };
  } catch (error) {
    if (error instanceof CommerceError) throw error;
    // Never return JSON, row values, credentials, library parse errors or ZIP paths.
    const allowed = [
      "The app schema differs. Use the same Telecart version on source and destination.",
      "Cannot authenticate this archive. Configure the matching original SESSION_SECRET and use an unmodified export.",
      "Data checksum does not match.", "Table counts do not match.",
    ];
    throw new CommerceError(error instanceof Error && allowed.includes(error.message)
      ? error.message : "Invalid, incomplete or oversized Telecart ZIP. Use an unmodified export from this app.", 400);
  }
}

export function previewToken(ownerId: string, archiveHash: string, expires = Date.now() + 5 * 60000) {
  const tag = createHmac("sha256", secret()).update(`transfer-preview:${ownerId}:${archiveHash}:${expires}`).digest("hex");
  return `${expires}.${tag}`;
}
export function verifyPreviewToken(token: string, ownerId: string, archiveHash: string) {
  const [timestamp, tag] = token.split(".");
  const expires = Number(timestamp);
  if (token.split(".").length !== 2 || !/^\d{13}$/.test(timestamp ?? "") || !/^[a-f0-9]{64}$/.test(tag ?? "") || expires < Date.now() || expires > Date.now() + 6 * 60000) {
    throw new CommerceError("Import preview expired. Validate this ZIP again.", 409);
  }
  const expected = previewToken(ownerId, archiveHash, expires);
  if (!timingSafeEqual(Buffer.from(token), Buffer.from(expected))) throw new CommerceError("ZIP or destination changed. Validate it again.", 409);
}
