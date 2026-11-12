import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import {
  ConnectAdvertisingBotBody, PreviewAdvertisingGroupsBody, AddAdvertisingGroupsBody,
  CheckAdvertisingGroupsBody, UpdateAdvertisingGroupBody, SaveAdvertisingDraftBody, StartAdvertisingCampaignBody,
} from "@workspace/api-zod";
import { getShopAuth } from "../lib/admin-auth";
import { CommerceError } from "../lib/commerce-providers";
import { advertisingWorkspace, advertisingBotForOwner, advertisingCampaigns, withAdvertisingLock, cancelAdvertisingCampaign } from "../lib/advertising-store";
import { addAdvertisingTargets, checkAdvertisingTargets, connectAdvertising, discoverAdvertisingTargets, stopAdvertising } from "../lib/advertising-management";
import { parseAdvertisingTarget, segregateAdvertisingTargets } from "../lib/advertising-targets";
import { advertisingTelegram, validateAdvertisingDraft } from "../lib/advertising-telegram";
import { createAdvertisingCampaign } from "../lib/advertising-campaigns";
import accountRouter from "./shop-advertising-account";
import { accountMode, discoverAccountGroups, checkAccountGroups } from "../lib/advertising-account-groups";
import { stopAccountSchedules } from "../lib/advertising-account-auth";

const router: IRouter = Router();
router.use("/advertising", (req, res, next) => {
  if (!getShopAuth(req).userId) { res.status(401).json({ error: "Sign in to manage advertising." }); return; }
  next();
});
const owner = (req: Request) => getShopAuth(req).userId!;
const id = (req: Request) => z.string().uuid().parse(req.params.id);
const run = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { const result = await fn(req, res); if (!res.headersSent) res.json(result); }
  catch (error) {
    res.status(error instanceof CommerceError ? error.status : error instanceof z.ZodError ? 400 : 500)
      .json({ error: error instanceof CommerceError ? error.message : error instanceof z.ZodError ? "Check the advertising fields and selection." : "Advertising request could not be completed. No credentials were exposed." });
  }
};
router.get("/advertising", run(async req => advertisingWorkspace(owner(req))));
router.use(accountRouter);
router.post("/advertising/connection", run(async req => {
  if (await accountMode(owner(req))) throw new CommerceError("Advertising now uses a personal Telegram account. Use QR or phone login instead of a bot token.", 410);
  const input = ConnectAdvertisingBotBody.parse(req.body);
  await connectAdvertising(owner(req), input.token.trim());
  return advertisingWorkspace(owner(req));
}));
router.delete("/advertising/connection", run(async req => {
  if (await accountMode(owner(req))) throw new CommerceError("Use the account Disconnect control instead.", 410);
  await withAdvertisingLock(owner(req), async client => {
    await stopAdvertising(owner(req), client);
    await client.query("UPDATE advertising_bots SET token_encrypted=NULL,bot_id=NULL,checked_at=NULL,last_error=NULL WHERE owner_id=$1", [owner(req)]);
    await client.query("UPDATE advertising_groups SET status='pending',checked_at=NULL,note='Connect the advertising bot and check permissions again.' WHERE owner_id=$1", [owner(req)]);
  });
  return advertisingWorkspace(owner(req));
}));
router.post("/advertising/connection/check", run(async req => {
  if (await accountMode(owner(req))) throw new CommerceError("Use Check account connection instead.", 410);
  await withAdvertisingLock(owner(req), async client => {
    const { row, token } = await advertisingBotForOwner(owner(req), client);
    try {
      const me = await advertisingTelegram<{ id: number; username: string }>(token, "getMe");
      if (String(me.id) !== row.bot_id) throw new CommerceError("Bot identity changed. Reconnect the advertising bot.");
      await client.query("UPDATE advertising_bots SET checked_at=now(),last_error=NULL,username=$2 WHERE owner_id=$1", [owner(req), me.username]);
    } catch (error) {
      await client.query("UPDATE advertising_bots SET checked_at=now(),last_error=$2 WHERE owner_id=$1", [owner(req), error instanceof CommerceError ? error.message : "Connection could not be checked."]);
    }
  });
  return advertisingWorkspace(owner(req));
}));
router.post("/advertising/groups/discover", run(async req => {
  if (await accountMode(owner(req))) await discoverAccountGroups(owner(req));
  else await discoverAdvertisingTargets(owner(req));
  return advertisingWorkspace(owner(req));
}));
router.post("/advertising/groups/preview", run(async req => {
  const input = PreviewAdvertisingGroupsBody.parse(req.body);
  const existing = (await pool.query("SELECT target FROM advertising_groups WHERE owner_id=$1", [owner(req)])).rows;
  return segregateAdvertisingTargets(input.text, existing.map(row => row.target));
}));
router.post("/advertising/groups", run(async req => {
  const input = AddAdvertisingGroupsBody.parse(req.body);
  await addAdvertisingTargets(owner(req), input.targets, input.permissionConfirmed); return advertisingWorkspace(owner(req));
}));
router.post("/advertising/groups/check", run(async req => {
  const ids = CheckAdvertisingGroupsBody.parse(req.body).groupIds;
  if (await accountMode(owner(req))) await checkAccountGroups(owner(req), ids);
  else await checkAdvertisingTargets(owner(req), ids);
  return advertisingWorkspace(owner(req));
}));
router.patch("/advertising/groups/:id", run(async req => {
  const input = UpdateAdvertisingGroupBody.parse(req.body), groupId = id(req);
  if (input.target === undefined && input.enabled === undefined && input.intervalSeconds === undefined) throw new CommerceError("Choose a group change.");
  const parsed = input.target === undefined ? null : parseAdvertisingTarget(input.target);
  if (parsed && !parsed.target) throw new CommerceError(parsed.reason);
  await withAdvertisingLock(owner(req), async client => {
    const group = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=$2", [owner(req), groupId])).rows[0];
    if (!group) throw new CommerceError("Group not found.", 404);
    if (parsed) {
      const exists = await client.query("SELECT 1 FROM advertising_groups WHERE owner_id=$1 AND target=$2 AND id<>$3", [owner(req), parsed.target, groupId]);
      if (exists.rowCount) throw new CommerceError("That target is already saved.", 409);
      await stopAccountSchedules(owner(req), client, [groupId], "Target changed. Verify and restart this group.");
      await client.query("UPDATE advertising_groups SET target=$3,kind=$4,chat_id=NULL,title='',status=$5,note=$6,checked_at=NULL WHERE owner_id=$1 AND id=$2",
        [owner(req), groupId, parsed.target, parsed.kind, parsed.kind === "private_invite" ? "needs_setup" : "pending", parsed.reason]);
    }
    if (input.intervalSeconds !== undefined) {
      await stopAccountSchedules(owner(req), client, [groupId], "Interval changed. Confirm Start to use this interval.");
      await client.query(`INSERT INTO advertising_schedules(group_id,owner_id,interval_seconds) VALUES($1,$2,$3)
        ON CONFLICT(group_id) DO UPDATE SET interval_seconds=EXCLUDED.interval_seconds`, [groupId, owner(req), input.intervalSeconds]);
    }
    if (input.enabled === false) await stopAccountSchedules(owner(req), client, [groupId], "Group disabled.");
    if (input.enabled !== undefined) await client.query("UPDATE advertising_groups SET enabled=$3 WHERE owner_id=$1 AND id=$2", [owner(req), groupId, input.enabled]);
  });
  return advertisingWorkspace(owner(req));
}));
router.delete("/advertising/groups/:id", run(async req => {
  await withAdvertisingLock(owner(req), async client => {
    const result = await client.query("DELETE FROM advertising_groups WHERE owner_id=$1 AND id=$2", [owner(req), id(req)]);
    if (!result.rowCount) throw new CommerceError("Group not found.", 404);
    await stopAccountSchedules(owner(req), client, [id(req)], "Group removed.");
    await client.query("DELETE FROM advertising_schedules WHERE owner_id=$1 AND group_id=$2", [owner(req), id(req)]);
  });
  return advertisingWorkspace(owner(req));
}));
router.put("/advertising/draft", run(async req => {
  const draft = validateAdvertisingDraft(SaveAdvertisingDraftBody.parse(req.body));
  await withAdvertisingLock(owner(req), async client => {
    await client.query("INSERT INTO advertising_bots(owner_id,draft) VALUES($1,$2::jsonb) ON CONFLICT(owner_id) DO UPDATE SET draft=EXCLUDED.draft", [owner(req), JSON.stringify(draft)]);
  });
  return advertisingWorkspace(owner(req));
}));
router.post("/advertising/campaigns", run(async (req, res) => {
  if (await accountMode(owner(req))) throw new CommerceError("Use Start selected to post with your Telegram account.", 410);
  const campaign = await createAdvertisingCampaign(owner(req), StartAdvertisingCampaignBody.parse(req.body));
  res.status(201).json(campaign);
}));
router.get("/advertising/campaigns/:id", run(async req => {
  const campaign = (await advertisingCampaigns(owner(req), id(req)))[0];
  if (!campaign) throw new CommerceError("Campaign not found.", 404);
  const deliveries = (await pool.query(`SELECT id,target,status,note,sent_at AS "sentAt" FROM advertising_deliveries
    WHERE owner_id=$1 AND campaign_id=$2 ORDER BY id`, [owner(req), campaign.id])).rows.map(row => ({ ...row, sentAt: row.sentAt?.toISOString() ?? null }));
  return { campaign, deliveries };
}));
router.post("/advertising/campaigns/:id/cancel", run(async req => {
  await withAdvertisingLock(owner(req), client => cancelAdvertisingCampaign(owner(req), id(req), client));
  return advertisingWorkspace(owner(req));
}));
export default router;
