import test from "node:test";
import assert from "node:assert/strict";
import { pollBatch, workspacePollingEnabled } from "../src/lib/workspace-polling";

test("polling acknowledges only successful ordered processing", async () => {
  const seen: number[] = [];
  const updates = [{ update_id: 10 }, { update_id: 11 }, { update_id: 12 }];
  await assert.rejects(pollBatch(updates, async update => {
    seen.push(update.update_id);
    if (update.update_id === 11) throw new Error("retry");
  }, 0));
  assert.deepEqual(seen, [10, 11]);
  assert.equal(await pollBatch(updates, async () => {}, 0), 13);
  assert.equal(await pollBatch([], async () => {}, 13), 13);
});

test("workspace polling is never enabled in production", () => {
  const env = process.env.NODE_ENV;
  const flag = process.env.TELECART_ALLOW_WORKSPACE_TESTING;
  try {
    process.env.TELECART_ALLOW_WORKSPACE_TESTING = "true";
    process.env.NODE_ENV = "production";
    assert.equal(workspacePollingEnabled(), false);
    process.env.NODE_ENV = "development";
    assert.equal(workspacePollingEnabled(), true);
    delete process.env.TELECART_ALLOW_WORKSPACE_TESTING;
    assert.equal(workspacePollingEnabled(), false);
  } finally {
    if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
    if (flag === undefined) delete process.env.TELECART_ALLOW_WORKSPACE_TESTING; else process.env.TELECART_ALLOW_WORKSPACE_TESTING = flag;
  }
});
