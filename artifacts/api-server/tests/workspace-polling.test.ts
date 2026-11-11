import test from "node:test";
import assert from "node:assert/strict";
import { pollBatch, pollingEnabled } from "../src/lib/workspace-polling";

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

test("saved dashboard mode selects polling independently of the host environment", () => {
  assert.equal(pollingEnabled({ enabled: true, transport: "polling", publicUrl: "" }), true);
  assert.equal(pollingEnabled({ enabled: false, transport: "polling", publicUrl: "" }), false);
  assert.equal(pollingEnabled({ enabled: true, transport: "webhook", publicUrl: "https://shop.example.com" }), false);
});
