import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  BeginAdvertisingAccountLoginBody, VerifyAdvertisingAccountLoginBody, PollAdvertisingAccountLoginBody,
  StartAdvertisingAccountSchedulesBody, StopAdvertisingAccountSchedulesBody,
} from "@workspace/api-zod";
import { getShopAuth } from "../lib/admin-auth";
import { CommerceError } from "../lib/commerce-providers";
import { advertisingWorkspace } from "../lib/advertising-store";
import { beginAccountLogin, advanceAccountLogin, cancelAccountLogin, checkAccountConnection, disconnectAccount } from "../lib/advertising-account-auth";
import { startAccountSchedules, stopSelectedAccountSchedules } from "../lib/advertising-account-schedules";

const router: IRouter = Router();
const run = (fn: (owner: string, req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  const owner = getShopAuth(req).userId;
  if (!owner) { res.status(401).json({ error: "Sign in to manage account advertising." }); return; }
  try { await fn(owner, req); res.json(await advertisingWorkspace(owner)); }
  catch (error) {
    res.status(error instanceof CommerceError ? error.status : error instanceof z.ZodError ? 400 : 500).json({
      error: error instanceof CommerceError ? error.message : error instanceof z.ZodError ? "Check the account sign-in fields, intervals and selected groups." : "Account operation could not be completed. Credentials were not exposed.",
    });
  }
};
router.post("/advertising/account/login", run((owner, req) => beginAccountLogin(owner, BeginAdvertisingAccountLoginBody.parse(req.body))));
router.delete("/advertising/account/login", run(owner => cancelAccountLogin(owner)));
router.post("/advertising/account/login/verify", run((owner, req) => advanceAccountLogin(owner, VerifyAdvertisingAccountLoginBody.parse(req.body))));
router.post("/advertising/account/login/poll", run((owner, req) => advanceAccountLogin(owner, PollAdvertisingAccountLoginBody.parse(req.body), true)));
router.post("/advertising/account/check", run(owner => checkAccountConnection(owner)));
router.delete("/advertising/account", run(owner => disconnectAccount(owner)));
router.post("/advertising/schedules/start", run((owner, req) => startAccountSchedules(owner, StartAdvertisingAccountSchedulesBody.parse(req.body))));
router.post("/advertising/schedules/stop", run((owner, req) => stopSelectedAccountSchedules(owner, StopAdvertisingAccountSchedulesBody.parse(req.body).groupIds)));
router.post("/advertising/schedules/stop-all", run(owner => stopSelectedAccountSchedules(owner)));
export default router;
