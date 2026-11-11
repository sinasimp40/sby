import { Router, raw } from "express";
import { getShopAuth } from "../lib/admin-auth";
import { CommerceError } from "../lib/commerce-providers";
import {
  GetShopTransferStatusResponse, PreviewShopDataResponse, ImportShopDataResponse,
  ReviewShopDataBody, ReviewShopDataResponse,
} from "@workspace/api-zod";
import { exportShopTransfer, previewShopTransfer, importShopTransfer, shopTransferStatus, reviewShopTransfer } from "../lib/shop-transfer";
import { MAX_ZIP_BYTES } from "../lib/shop-transfer-tables";

const router = Router();
const zipBody = raw({ type: ["application/zip", "application/octet-stream", "application/x-zip-compressed"], limit: MAX_ZIP_BYTES });
function uploadedZip(body: unknown) {
  if (!Buffer.isBuffer(body)) throw new CommerceError("Upload the original .zip file as application/zip.");
  return body;
}
router.get("/data-transfer", async (req, res): Promise<void> => {
  res.json(GetShopTransferStatusResponse.parse(await shopTransferStatus(getShopAuth(req).userId)));
});
router.post("/data-transfer/export", async (req, res): Promise<void> => {
  const archive = await exportShopTransfer(getShopAuth(req).userId);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="telecart-shop-${new Date().toISOString().replace(/[:.]/g, "-")}.zip"`);
  res.send(archive.zip);
});
router.post("/data-transfer/preview", zipBody, async (req, res): Promise<void> => {
  res.json(PreviewShopDataResponse.parse(await previewShopTransfer(getShopAuth(req).userId, uploadedZip(req.body))));
});
router.post("/data-transfer/import", zipBody, async (req, res): Promise<void> => {
  if (req.get("x-transfer-confirm") !== "IMPORT EMPTY SHOP") throw new CommerceError("Explicit empty-shop import confirmation is required.");
  const token = req.get("x-transfer-token");
  if (!token || token.length > 100) throw new CommerceError("Validate the ZIP before importing.");
  res.json(ImportShopDataResponse.parse(await importShopTransfer(getShopAuth(req).userId, uploadedZip(req.body), token)));
});
router.post("/data-transfer/review", async (req, res): Promise<void> => {
  const parsed = ReviewShopDataBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.sourceStopped || !parsed.data.recordsReviewed) throw new CommerceError("Confirm the source is stopped and the imported records have been reviewed.");
  res.json(ReviewShopDataResponse.parse(await reviewShopTransfer(getShopAuth(req).userId)));
});
export default router;
