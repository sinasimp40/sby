import test from "node:test";
import assert from "node:assert/strict";
import type { AdvertisingAccountRun } from "@workspace/api-client-react";
import { appendPostingPage, postingHeadChanged, postingDayRange, refreshLoadedPosts } from "../src/components/advertising/posting-history-state";

const row = (id: string, day = "2026-11-13"): AdvertisingAccountRun => ({
  id, groupId: "TEST_ONLY", target: "TEST_ONLY", status: "sent", note: "",
  startedAt: `${day}T00:00:00.000Z`, sentAt: null,
});

test("appending pages keeps server order, loaded rows and unique IDs", () => {
  const current = [row("2"), row("1")];
  const next = appendPostingPage(current, [row("1"), row("4"), row("4"), row("3")]);
  assert.deepEqual(next.map(r => r.id), ["2", "1", "4", "3"], "do not re-sort millisecond ties; the server orders full PostgreSQL precision");
  assert.equal(current.length, 2);
});

test("head polling detects inserted posts without discarding the loaded tail", () => {
  const current = [row("3"), row("2"), row("1")];
  assert.equal(postingHeadChanged(current, [row("3"), row("2")]), false);
  assert.equal(postingHeadChanged(current, [row("3"), row("new"), row("2")]), true);
  assert.equal(postingHeadChanged(current, []), true);
  const updated = refreshLoadedPosts(current, [{ ...row("2"), status: "failed" }, row("new")], 0);
  assert.deepEqual(updated.map(r => r.id), ["3", "2", "1"]);
  assert.equal(updated[1]!.status, "failed");
  assert.equal(current[1]!.status, "sent");
  assert.deepEqual(refreshLoadedPosts([row("old", "2026-11-01"), row("new")], [], Date.parse("2026-11-08T00:00Z")).map(r => r.id), ["new"]);
});

test("local date boundaries cover Taipei and daylight-saving days without mixing dates", () => {
  const oldTZ = process.env.TZ;
  try {
    process.env.TZ = "Asia/Taipei";
    assert.deepEqual(postingDayRange("2026-11-13"), { from: "2026-11-12T16:00:00.000Z", to: "2026-11-13T16:00:00.000Z" });
    process.env.TZ = "America/New_York";
    const spring = postingDayRange("2026-03-08")!;
    const autumn = postingDayRange("2026-11-01")!;
    assert.equal(Date.parse(spring.to) - Date.parse(spring.from), 23 * 3600000);
    assert.equal(Date.parse(autumn.to) - Date.parse(autumn.from), 25 * 3600000);
    assert.equal(postingDayRange("2026-02-31"), undefined);
    assert.equal(postingDayRange(""), undefined);
  } finally { if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ; }
});
