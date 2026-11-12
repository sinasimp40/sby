import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  BeginAdvertisingAccountLoginBody, VerifyAdvertisingAccountLoginBody, PollAdvertisingAccountLoginBody,
  StartAdvertisingAccountSchedulesBody, StopAdvertisingAccountSchedulesBody,
  SaveAdvertisingAppCredentialsBody,
  LoadAdvertisingEmojiSetBody, LoadAdvertisingEmojiSetResponse,
  LoadAdvertisingSavedMessagesBody, LoadAdvertisingSavedMessagesResponse, StartAdvertisingForwardLoopBody,
} from "@workspace/api-zod";
import { getShopAuth } from "../lib/admin-auth";
import { CommerceError } from "../lib/commerce-providers";
import { advertisingWorkspace } from "../lib/advertising-store";
import { beginAccountLogin, advanceAccountLogin, cancelAccountLogin, checkAccountConnection, disconnectAccount, saveAccountApp } from "../lib/advertising-account-auth";
import { startAccountSchedules, stopSelectedAccountSchedules } from "../lib/advertising-account-schedules";
import { withAdvertisingLock } from "../lib/advertising-store";
import { withAccountDriver } from "../lib/advertising-account-auth";
import { emojiPackName } from "../lib/advertising-account-emoji";
import { AccountError } from "../lib/advertising-account-errors";
import { loadOwnerSavedMessages, startForwardLoop } from "../lib/advertising-forward-loop";

const router: IRouter = Router();
router.post("/advertising/account/emoji-set", async (req: Request, res: Response): Promise<void> => {
  const owner = getShopAuth(req).userId;
  if (!owner) { res.status(401).json({ error: "Sign in to load emoji packs." }); return; }
  try {
    const name = emojiPackName(LoadAdvertisingEmojiSetBody.parse(req.body).link);
    const result = await withAdvertisingLock(owner, client => withAccountDriver(owner, client, driver => {
      if (!driver.emojiSet) throw new AccountError("This account client does not support emoji packs.");
      return driver.emojiSet(name);
    }, undefined, "emoji_set"));
    res.json(LoadAdvertisingEmojiSetResponse.parse(result));
  } catch (error) {
    res.status(error instanceof CommerceError ? error.status : error instanceof z.ZodError ? 400 : 500).json({
      error: error instanceof CommerceError ? error.message : "The emoji pack could not be loaded. Check the link and account connection.",
    });
  }
});
const jsonRun = (fn: (owner: string, req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  const owner = getShopAuth(req).userId;
  if (!owner) { res.status(401).json({ error: "Sign in to manage account advertising." }); return; }
  try { res.json(await fn(owner, req)); }
  catch (error) {
    res.status(error instanceof CommerceError ? error.status : error instanceof z.ZodError ? 400 : 500).json({
      error: error instanceof CommerceError ? error.message : error instanceof z.ZodError ? "Check the account sign-in fields, intervals and selected groups." : "Account operation could not be completed. Credentials were not exposed.",
    });
  }
};
const run = (fn: (owner: string, req: Request) => Promise<unknown>) => jsonRun(async (owner, req) => {
  await fn(owner, req);
  return advertisingWorkspace(owner);
});
router.post("/advertising/account/saved-messages", jsonRun(async (owner, req) =>
  LoadAdvertisingSavedMessagesResponse.parse(await loadOwnerSavedMessages(owner, LoadAdvertisingSavedMessagesBody.parse(req.body)))));
router.post("/advertising/forwarding/start", run((owner, req) => startForwardLoop(owner, StartAdvertisingForwardLoopBody.parse(req.body))));
router.post("/advertising/account/login", run((owner, req) => beginAccountLogin(owner, BeginAdvertisingAccountLoginBody.parse(req.body))));
router.put("/advertising/account/app", run((owner, req) => saveAccountApp(owner, SaveAdvertisingAppCredentialsBody.parse(req.body))));
router.delete("/advertising/account/app", run(owner => disconnectAccount(owner, undefined, true)));
router.delete("/advertising/account/login", run(owner => cancelAccountLogin(owner)));
router.post("/advertising/account/login/verify", run((owner, req) => advanceAccountLogin(owner, VerifyAdvertisingAccountLoginBody.parse(req.body))));
router.post("/advertising/account/login/poll", run((owner, req) => advanceAccountLogin(owner, PollAdvertisingAccountLoginBody.parse(req.body), true)));
router.post("/advertising/account/check", run(owner => checkAccountConnection(owner)));
router.delete("/advertising/account", run(owner => disconnectAccount(owner)));
router.post("/advertising/schedules/start", run((owner, req) => startAccountSchedules(owner, StartAdvertisingAccountSchedulesBody.parse(req.body))));
router.post("/advertising/schedules/stop", run((owner, req) => stopSelectedAccountSchedules(owner, StopAdvertisingAccountSchedulesBody.parse(req.body).groupIds)));
router.post("/advertising/schedules/stop-all", run(owner => stopSelectedAccountSchedules(owner)));
export default router;
