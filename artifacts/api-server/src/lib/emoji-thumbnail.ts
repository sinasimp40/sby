// Telegram may serve a thumbnail as application/octet-stream; inspect its image
// signature rather than trusting either its filename or Content-Type header.
export async function readEmojiThumbnail(response: Response) {
  if (!response.ok || Number(response.headers.get("content-length") || 0) > 512000) throw new Error("Preview unavailable.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Preview unavailable.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 512000) { await reader.cancel(); throw new Error("Preview too large."); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  const type = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" :
    bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg" :
    bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
  if (!type) throw new Error("Unsupported preview format.");
  return { type, bytes };
}
