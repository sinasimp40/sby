import { Api } from "telegram";
import bigInt from "big-integer";
import type { AdvertisingTextEntity } from "@workspace/api-zod";
import { CommerceError } from "./commerce-providers";

const invalid = (detail: string): never => { throw new CommerceError(`Invalid advertisement formatting: ${detail}`, 400); };
const boundary = (text: string, at: number) => !(at > 0 && at < text.length &&
  /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!));
export function validateAdEntities(text: string, input: unknown): AdvertisingTextEntity[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 100) return invalid("use at most 100 text entities.");
  const result: AdvertisingTextEntity[] = [];
  for (const value of input) {
    if (!value || typeof value !== "object") return invalid("a text entity is malformed.");
    const e = value as AdvertisingTextEntity;
    if (!["bold", "italic", "text_link", "custom_emoji"].includes(e.type) ||
      !Number.isSafeInteger(e.offset) || !Number.isSafeInteger(e.length) || e.offset < 0 || e.length < 1 ||
      e.offset + e.length > text.length || !boundary(text, e.offset) || !boundary(text, e.offset + e.length))
      return invalid("ranges must cover complete characters inside the message.");
    if (Object.keys(value).some(k => !["type", "offset", "length", "url", "documentId"].includes(k)))
      return invalid("unsupported entity fields.");
    const clean: AdvertisingTextEntity = { type: e.type, offset: e.offset, length: e.length };
    if (e.type === "text_link") {
      try {
        if (typeof e.url !== "string" || e.url.length > 2048) throw new Error();
        const url = new URL(e.url);
        if (url.protocol !== "https:" || url.username || url.password) throw new Error();
        clean.url = e.url;
      } catch { return invalid("links must be HTTPS URLs without credentials."); }
    } else if (e.url !== undefined) return invalid("only a text link can contain a URL.");
    if (e.type === "custom_emoji") {
      if (typeof e.documentId !== "string" || !/^[1-9]\d{0,18}$/.test(e.documentId) || BigInt(e.documentId) > 9223372036854775807n)
        return invalid("custom emoji need a valid Telegram document ID.");
      const fallback = text.slice(e.offset, e.offset + e.length);
      if ([...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(fallback)].length !== 1 ||
        !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(fallback))
        return invalid("a custom emoji must wrap one complete ordinary emoji fallback.");
      clean.documentId = e.documentId;
    } else if (e.documentId !== undefined) return invalid("only a custom emoji can contain a document ID.");
    if (!result.some(old => JSON.stringify(old) === JSON.stringify(clean))) result.push(clean);
  }
  for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
    const a = result[i]!, b = result[j]!, ae = a.offset + a.length, be = b.offset + b.length;
    const overlap = a.offset < be && b.offset < ae;
    const nested = (a.offset <= b.offset && ae >= be) || (b.offset <= a.offset && be >= ae);
    if (overlap && (!nested || (a.type === "text_link" && b.type === "text_link") ||
      (a.type === "custom_emoji" && b.type === "custom_emoji")))
      return invalid("ranges must be separate or nested; links and custom emoji cannot overlap their own kind.");
  }
  return result.sort((a, b) => a.offset - b.offset || b.length - a.length || a.type.localeCompare(b.type));
}
export function telegramAdEntities(entities: AdvertisingTextEntity[]): Api.TypeMessageEntity[] {
  return entities.map(e => {
    const range = { offset: e.offset, length: e.length };
    if (e.type === "bold") return new Api.MessageEntityBold(range);
    if (e.type === "italic") return new Api.MessageEntityItalic(range);
    if (e.type === "text_link") return new Api.MessageEntityTextUrl({ ...range, url: e.url! });
    return new Api.MessageEntityCustomEmoji({ ...range, documentId: bigInt(e.documentId!) });
  });
}
