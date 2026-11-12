import { CommerceError } from "./commerce-providers";
import type { AdvertisingImportRow } from "@workspace/api-zod";

export function parseAdvertisingTarget(input: string): AdvertisingImportRow {
  const raw = input.trim().replace(/^[<("'[\]]+|[>)"'\].]+$/g, "");
  const invalid = (reason: string): AdvertisingImportRow => ({ input, target: null, kind: "invalid", status: "invalid", reason });
  if (/^-[1-9]\d{5,15}$/.test(raw)) return { input, target: raw, kind: "chat_id", status: "new", reason: "Group/chat ID; verify membership and permission to post." };
  let path = raw;
  const linked = /^(?:https?:\/\/|(?:www\.)?(?:t\.me|telegram\.me)\/)/i.test(raw);
  if (linked) {
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!["t.me", "telegram.me", "www.t.me", "www.telegram.me"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) return invalid("Use a Telegram group link, @username or negative chat ID.");
      path = url.pathname.replace(/^\/|\/$/g, "");
    } catch { return invalid("Invalid Telegram link."); }
  }
  if (/^(?:\+|joinchat\/)[A-Za-z0-9_-]{5,128}$/.test(path)) return {
    input, target: `https://t.me/+${path.replace(/^(?:\+|joinchat\/)/, "")}`, kind: "private_invite", status: "needs_setup",
    reason: "Join the group manually in Telegram, then discover it or replace this link with its negative chat ID. No automatic joining.",
  };
  const username = path.replace(/^@/, "").replace(/\/\d+$/, "");
  if ((!linked && !raw.startsWith("@")) || !/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username) || ["joinchat", "share", "proxy", "socks", "addstickers", "addemoji", "login"].includes(username.toLowerCase()))
    return invalid("Not a public group username, invite link or negative group ID.");
  return { input, target: `@${username.toLowerCase()}`, kind: "public", status: "new", reason: "Public Telegram name; membership and posting permission still need checking." };
}

export function segregateAdvertisingTargets(text: string, existing: string[] = []) {
  if (!text.trim() || text.length > 65536) throw new CommerceError("Paste a non-empty list or choose a UTF-8 .txt file up to 64 KB.");
  const inputs = text.replace(/^\uFEFF/, "").split(/[\s,;]+/).filter(Boolean);
  if (inputs.length > 500) throw new CommerceError("Review at most 500 group links at a time.");
  const seen = new Set(existing);
  return { rows: inputs.map(input => {
    const row = parseAdvertisingTarget(input);
    if (row.target) {
      if (seen.has(row.target)) return { ...row, status: "duplicate" as const, reason: "Already saved or repeated in this list." };
      seen.add(row.target);
    }
    return row;
  }) };
}
