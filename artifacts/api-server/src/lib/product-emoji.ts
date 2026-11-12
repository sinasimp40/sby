const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const emojiCharacter = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3/u;

export function isProductEmoji(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32 &&
    Array.from(graphemes.segment(value)).length === 1 && emojiCharacter.test(value);
}
