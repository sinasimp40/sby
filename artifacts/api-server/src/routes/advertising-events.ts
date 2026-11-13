import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { databaseChanges } from "@workspace/db";
import { getShopAuth, hasCurrentAdminSession } from "../lib/admin-auth";
import { advertisingWorkspace } from "../lib/advertising-store";
import { GetAdvertisingWorkspaceResponse } from "@workspace/api-zod";

const router: IRouter = Router();
router.get("/advertising/events", async (req, res): Promise<void> => {
  const owner = getShopAuth(req).userId;
  if (!owner) { res.sendStatus(401); return; }
  // EventSource is same-origin and cookie-authenticated, never token-in-URL.
  res.status(200).set({
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive", "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 1000\n\n");
  let closed = false, running = false, dirty = false, fingerprint = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    if (closed) return;
    if (running) { dirty = true; return; }
    running = true;
    try {
      if (!await hasCurrentAdminSession(req)) { res.end(); return; }
      const workspace = GetAdvertisingWorkspaceResponse.parse(await advertisingWorkspace(owner));
      const next = createHash("sha256").update(JSON.stringify(workspace)).digest("hex");
      // Changes in another shop must not leak even a notification.
      if (!closed && next !== fingerprint) {
        fingerprint = next;
        if (!res.write(`event: workspace\ndata: ${JSON.stringify(workspace)}\n\n`)) {
          // A full send buffer is normal for hundreds of groups, not a failed
          // stream. Wait for drain and coalesce further changes while waiting.
          await new Promise<void>(resolve => {
            const finish = () => {
              clearTimeout(deadline);
              res.off("drain", finish); res.off("close", finish);
              resolve();
            };
            const deadline = setTimeout(() => { res.destroy(); finish(); }, 10000);
            res.once("drain", finish); res.once("close", finish);
            if (res.destroyed) finish();
          });
        }
      }
    } catch (error) {
      // Reconnect and rehydrate rather than serving a fabricated empty list.
      req.log.warn({ errorType: error instanceof Error ? error.name : "Unknown" },
        "Advertising live update failed; the client will reconnect. No workspace data was logged.");
      res.end();
    } finally {
      running = false;
      if (dirty && !closed) { dirty = false; schedule(); }
    }
  };
  const schedule = () => {
    if (!closed && !timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 75);
  };
  databaseChanges.on("advertising", schedule);
  const heartbeat = setInterval(() => {
    void hasCurrentAdminSession(req).then(valid => {
      if (!valid) res.end();
      else if (!closed) res.write(": heartbeat\n\n");
    }).catch(() => res.end());
  }, 15000);
  const cleanup = () => {
    closed = true; clearInterval(heartbeat); clearTimeout(timer);
    databaseChanges.off("advertising", schedule);
  };
  res.on("close", cleanup);
  void refresh();
});
export default router;
