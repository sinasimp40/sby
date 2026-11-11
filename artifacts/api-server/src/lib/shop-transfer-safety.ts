import { eq } from "drizzle-orm";
import { db, botRuntimeSettings } from "@workspace/db";
import { CommerceError } from "./commerce-providers";

export async function assertTransferReviewed(ownerId: string) {
  const [row] = await db.select({ pending: botRuntimeSettings.transferReviewRequired }).from(botRuntimeSettings).where(eq(botRuntimeSettings.ownerId, ownerId));
  if (row?.pending) throw new CommerceError("Imported shop processing is paused. Review the transfer in Database transfer before resuming.", 503);
}
