import { Router, type IRouter } from "express";
import { getShopAuth } from "../lib/admin-auth";
import {
  ListCustomEmojisResponse, ImportCustomEmojiPackBody, ImportCustomEmojiPackResponse,
  StartEmojiImportResponse, DeleteCustomEmojiParams, PreviewCustomEmojiParams,
} from "@workspace/api-zod";
import { customEmojiLibrary, importEmojiPack, removeCustomEmoji, customEmojiPreview } from "../lib/custom-emoji-library";
import { startEmojiImportSession, stopEmojiImportSession } from "../lib/emoji-import-session";

const router: IRouter = Router();
router.get("/custom-emojis", async (req, res): Promise<void> => {
  res.json(ListCustomEmojisResponse.parse(await customEmojiLibrary(getShopAuth(req).userId)));
});
router.post("/custom-emojis/pack", async (req, res): Promise<void> => {
  const parsed = ImportCustomEmojiPackBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter a custom emoji pack link or name." }); return; }
  res.json(ImportCustomEmojiPackResponse.parse(await importEmojiPack(getShopAuth(req).userId, parsed.data.pack)));
});
router.post("/custom-emojis/session", async (req, res): Promise<void> => {
  res.json(StartEmojiImportResponse.parse(await startEmojiImportSession(getShopAuth(req).userId)));
});
router.delete("/custom-emojis/session", async (req, res): Promise<void> => {
  await stopEmojiImportSession(getShopAuth(req).userId); res.sendStatus(204);
});
router.delete("/custom-emojis/:id", async (req, res): Promise<void> => {
  const parsed = DeleteCustomEmojiParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid custom emoji ID." }); return; }
  await removeCustomEmoji(getShopAuth(req).userId, parsed.data.id); res.sendStatus(204);
});
router.get("/custom-emojis/:id/preview", async (req, res): Promise<void> => {
  const parsed = PreviewCustomEmojiParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid custom emoji ID." }); return; }
  const preview = await customEmojiPreview(getShopAuth(req).userId, parsed.data.id);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.type(preview.type).send(preview.bytes);
});
export default router;
