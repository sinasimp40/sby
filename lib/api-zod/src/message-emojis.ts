// A small plain-text token keeps message settings portable without accepting
// merchant-supplied HTML. Telegram entities use UTF-16 offsets, as JS does.
const tokenPattern = () => /\{\{emoji:([1-9]\d{0,31})\|([^{}|\r\n]{1,32})\}\}/gu;
const segments = new Intl.Segmenter("en", { granularity: "grapheme" });
const isEmoji = (value: string) => Array.from(segments.segment(value)).length === 1 &&
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3/u.test(value);
export type MessageEmojiPart = { text: string; customEmojiId?: string };
export function messageEmojiToken(id: string, fallback: string) {
  if (!/^[1-9]\d{0,31}$/.test(id) || !isEmoji(fallback)) throw new Error("Choose a valid custom emoji.");
  return `{{emoji:${id}|${fallback}}}`;
}
export function parseMessageEmojis(source: string) {
  const parts: MessageEmojiPart[] = [];
  const entities: { type: "custom_emoji"; offset: number; length: number; custom_emoji_id: string }[] = [];
  let cursor = 0;
  let text = "";
  for (const match of source.matchAll(tokenPattern())) {
    if (!isEmoji(match[2]!)) continue;
    const plain = source.slice(cursor, match.index);
    if (plain) { parts.push({ text: plain }); text += plain; }
    parts.push({ text: match[2]!, customEmojiId: match[1]! });
    entities.push({ type: "custom_emoji", offset: text.length, length: match[2]!.length, custom_emoji_id: match[1]! });
    text += match[2]!;
    cursor = match.index! + match[0].length;
  }
  const tail = source.slice(cursor);
  if (tail) { parts.push({ text: tail }); text += tail; }
  return { text, parts, entities };
}
export function removeMessageEmoji(source: string, id: string) {
  return parseMessageEmojis(source).parts.map(part =>
    part.customEmojiId && part.customEmojiId !== id ? messageEmojiToken(part.customEmojiId, part.text) : part.text).join("");
}
