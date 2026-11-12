import type { AdvertisingTextEntity, AdvertisingTextEntityType } from "@workspace/api-client-react";

export type Entity = AdvertisingTextEntity;
export const MAX_ENTITIES = 100;
const DOC_ID = /^[1-9][0-9]{0,18}$/;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** True when an offset falls between the two halves of a surrogate pair. */
export function splitsPair(text: string, i: number): boolean {
  return i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i));
}
export function safeHttps(url: string): boolean {
  try { const u = new URL(url.trim()); return u.protocol === "https:" && !u.username && !u.password && !!u.hostname && url.trim().length <= 2048; } catch { return false; }
}

/** Drop invalid spans, clamp, merge same-style ranges and sort deterministically. */
export function normalize(text: string, list: Entity[]): Entity[] {
  const ok = list.filter(e => Number.isInteger(e.offset) && Number.isInteger(e.length) && e.offset >= 0 && e.length > 0 && e.offset + e.length <= text.length
    && !splitsPair(text, e.offset) && !splitsPair(text, e.offset + e.length)
    && (e.type !== "text_link" || (!!e.url && safeHttps(e.url)))
    && (e.type !== "custom_emoji" || (!!e.documentId && DOC_ID.test(e.documentId))))
    .map(e => e.type === "text_link" ? { type: e.type, offset: e.offset, length: e.length, url: e.url!.trim() } : e.type === "custom_emoji" ? { type: e.type, offset: e.offset, length: e.length, documentId: e.documentId } : { type: e.type, offset: e.offset, length: e.length });
  const out: Entity[] = [];
  for (const t of ["bold", "italic"] as const) {
    const rs = ok.filter(e => e.type === t).sort((a, b) => a.offset - b.offset);
    for (const r of rs) {
      const last = out[out.length - 1];
      if (last && last.type === t && r.offset <= last.offset + last.length) last.length = Math.max(last.length, r.offset + r.length - last.offset);
      else out.push({ ...r });
    }
  }
  // links and custom emoji must not overlap others of their kind
  for (const t of ["text_link", "custom_emoji"] as const) {
    let end = -1;
    for (const r of ok.filter(e => e.type === t).sort((a, b) => a.offset - b.offset)) { if (r.offset >= end) { out.push(r); end = r.offset + r.length; } }
  }
  // Telegram permits nested spans, not crossing spans. Partition style spans
  // at every boundary so arbitrary selections remain valid without losing style.
  const cuts = [...new Set(out.flatMap(e => [e.offset, e.offset + e.length]))].sort((a, b) => a - b);
  const nested = out.flatMap(e => {
    if (e.type !== "bold" && e.type !== "italic") return [e];
    const points = cuts.filter(p => p >= e.offset && p <= e.offset + e.length);
    return points.slice(0, -1).map((p, i) => ({ ...e, offset: p, length: points[i + 1] - p }));
  });
  // Do not silently truncate formatting: the editor blocks saving over the limit.
  return nested.sort((a, b) => a.offset - b.offset || b.length - a.length || a.type.localeCompare(b.type));
}

/** Re-map entities after a plain-text edit from `prev` to `next`. */
export function adjustForEdit(prev: string, next: string, list: Entity[]): Entity[] {
  if (prev === next || !list.length) return normalize(next, list);
  let p = 0; const max = Math.min(prev.length, next.length);
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  if (p > 0 && isHigh(prev.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  if (s > 0 && isLow(prev.charCodeAt(prev.length - s))) s--;
  const start = p, oldEnd = prev.length - s, newEnd = next.length - s, delta = newEnd - oldEnd;
  const out: Entity[] = [];
  for (const e of list) {
    const end = e.offset + e.length;
    if (end <= start) { out.push(e); continue; }
    if (e.offset >= oldEnd) { out.push({ ...e, offset: e.offset + delta }); continue; }
    if (e.type === "custom_emoji") continue; // touched emoji fallback is no longer valid
    const ns = e.offset <= start ? e.offset : newEnd;
    const ne = end >= oldEnd ? end + delta : start;
    if (ne > ns) out.push({ ...e, offset: ns, length: ne - ns });
  }
  return normalize(next, out);
}

function subtract(list: Entity[], type: AdvertisingTextEntityType, s: number, e: number): Entity[] {
  const out: Entity[] = [];
  for (const x of list) {
    const xe = x.offset + x.length;
    if (x.type !== type || xe <= s || x.offset >= e) { out.push(x); continue; }
    if (x.offset < s) out.push({ ...x, length: s - x.offset });
    if (xe > e) out.push({ ...x, offset: e, length: xe - e });
  }
  return out;
}
export function covered(list: Entity[], type: AdvertisingTextEntityType, s: number, e: number): boolean {
  if (e <= s) return false;
  let pos = s;
  for (const x of list.filter(x => x.type === type).sort((a, b) => a.offset - b.offset)) {
    if (x.offset <= pos && x.offset + x.length > pos) pos = x.offset + x.length;
    if (pos >= e) return true;
  }
  return false;
}
export function toggleStyle(text: string, list: Entity[], type: "bold" | "italic", s: number, e: number): Entity[] {
  if (e <= s) return list;
  return normalize(text, covered(list, type, s, e) ? subtract(list, type, s, e) : [...list, { type, offset: s, length: e - s }]);
}
export function setLink(text: string, list: Entity[], s: number, e: number, url: string | null): Entity[] {
  if (e <= s) return list;
  const base = subtract(list, "text_link", s, e);
  return normalize(text, url ? [...base, { type: "text_link", offset: s, length: e - s, url }] : base);
}
export function linkAt(list: Entity[], s: number, e: number): Entity | undefined {
  return list.find(x => x.type === "text_link" && x.offset < Math.max(e, s + 1) && x.offset + x.length > s);
}
/** Replace the selection with the ordinary fallback and tag it as a custom emoji. */
export function insertEmoji(text: string, list: Entity[], s: number, e: number, fallback: string, documentId: string): { text: string; entities: Entity[] } {
  const next = text.slice(0, s) + fallback + text.slice(e);
  const moved = adjustForEdit(text, next, list).filter(x => !(x.type === "custom_emoji" && x.offset < s + fallback.length && x.offset + x.length > s));
  return { text: next, entities: normalize(next, [...moved, { type: "custom_emoji", offset: s, length: fallback.length, documentId }]) };
}
export function snapSelection(text: string, s: number, e: number): [number, number] {
  let a = Math.max(0, Math.min(s, text.length)), b = Math.max(a, Math.min(e, text.length));
  for (const part of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) {
    const end = part.index + part.segment.length;
    if (a > part.index && a < end) a = part.index;
    if (b > part.index && b < end) b = end;
  }
  return [a, b];
}
export function entitiesProblem(text: string, list: Entity[]): string {
  if (list.length > MAX_ENTITIES) return `Too many formatted spans (${list.length}); the limit is ${MAX_ENTITIES}.`;
  for (const e of list) {
    if (e.offset + e.length > text.length) return "Formatting points past the end of the text. Reapply it.";
    if (e.type === "text_link" && !safeHttps(e.url ?? "")) return "Every text link must be a public HTTPS link without a username or password.";
  }
  return "";
}

export type Segment = { text: string; bold: boolean; italic: boolean; url?: string; emojiId?: string };
export function segments(text: string, list: Entity[]): Segment[] {
  const cuts = new Set([0, text.length]);
  for (const e of list) { cuts.add(e.offset); cuts.add(e.offset + e.length); }
  const pts = [...cuts].filter(n => n >= 0 && n <= text.length).sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const on = (t: string) => list.find(e => e.type === t && e.offset <= a && e.offset + e.length >= b);
    out.push({ text: text.slice(a, b), bold: !!on("bold"), italic: !!on("italic"), url: on("text_link")?.url, emojiId: on("custom_emoji")?.documentId });
  }
  return out;
}
