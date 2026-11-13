import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

test("groups-per-interval controls render one-copy semantics and bounded group counts", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cacheDir = mkdtempSync(join(tmpdir(), "telecart-repeat-ui-"));
  const vite = await createServer({
    configFile: false, root, cacheDir, logLevel: "error",
    resolve: { alias: { "@": join(root, "src") } },
    esbuild: { jsx: "automatic" },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: [/^@workspace\//] },
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const { GroupsPerIntervalPanel, ForwardingStatus, groupsPerIntervalOk, queueGroups } = await vite.ssrLoadModule("/src/components/advertising/forwarding-panels.tsx");
    const { alphabeticalGroups, retainedGroupSelection, ScrollableGroupList, groupListViewportHeight } = await vite.ssrLoadModule("/src/components/advertising/group-list.tsx");
    const { MembershipPanel } = await vite.ssrLoadModule("/src/components/advertising/membership-panel.tsx");
    const membershipHtml = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(MembershipPanel, { ws: { account: { connected: false, accountId: null, login: null }, membershipJobs: [] } })));
    assert.match(membershipHtml, /Join groups from .txt/);
    assert.match(membershipHtml, /UNCERTAIN posts remove that destination and queue leaving/);
    assert.match(membershipHtml, /<button[^>]*disabled=""[^>]*data-testid="button-membership-preview"/);
    assert.doesNotMatch(membershipHtml, /data-testid="button-membership-start"/, "no join action exists before preview and confirmation");
    const { ResumePanel } = await vite.ssrLoadModule("/src/components/advertising/resume-panel.tsx");
    const resumeHtml = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(ResumePanel, { ws: { account: { connected: true, accountId: "900000009", login: null },
        groups: [], forwarding: { source: {} }, resume: { planId: "TEST_ONLY", available: false,
          groupIds: [], heldGroupIds: [], groupsSentInInterval: 1, groupsPerInterval: 3, reason: "Campaign is already running." } } })));
    assert.match(resumeHtml, /Campaign is already running/);
    assert.match(resumeHtml, /<button[^>]*disabled=""[^>]*data-testid="button-open-resume"/);
    const groups = ["Zulu", "beta 10", "Alpha", "beta 2", ""].map((title, i) => ({
      id: String(i), title, target: title || "Charlie", enabled: true, status: "ready", chatId: `-${i + 1}`,
    }));
    const original = groups.map(g => g.id);
    const statusFixture = (running, resume) => ({
      groups, account: { connected: true, accountId: "900000009", login: null },
      forwarding: { running, source: null, groupIds: [groups[0].id], nextGroupId: groups[0].id, nextSendAt: null,
        intervalSeconds: 60, groupsPerInterval: 3, groupsSentInInterval: 1 },
      resume,
    });
    const renderStatus = ws => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(ForwardingStatus, { ws })));
    const runningStatus = renderStatus(statusFixture(true, null));
    const pauseButton = html => html.match(/<button[^>]*data-testid="button-pause-campaign"[^>]*>/)?.[0];
    assert.ok(pauseButton(runningStatus));
    assert.doesNotMatch(pauseButton(runningStatus), /\sdisabled(?:=""|(?=\s|>))/);
    const mixedStatus = renderStatus({ ...statusFixture(true, null), groups: [groups[0], { ...groups[1], running: true }] });
    assert.match(pauseButton(mixedStatus), /\sdisabled(?:=""|(?=\s|>))/);
    assert.match(mixedStatus, /Pause is unavailable until those schedules are stopped/);
    const saved = { planId: "TEST_ONLY_plan", groupIds: [groups[0].id], reason: "", available: true };
    const pausedStatus = renderStatus(statusFixture(false, saved));
    assert.match(pausedStatus, /data-testid="status-forwarding"[^>]*><span[^>]*><\/span>Paused<\/span>/);
    assert.match(pausedStatus, /data-testid="text-campaign-paused"/);
    assert.match(pauseButton(pausedStatus), /\sdisabled(?:=""|(?=\s|>))/);
    const stoppedStatus = renderStatus(statusFixture(false, null));
    assert.match(stoppedStatus, /data-testid="status-forwarding"[^>]*><span[^>]*><\/span>Stopped<\/span>/);
    assert.deepEqual(alphabeticalGroups(groups).map(g => g.title || g.target), ["Alpha", "beta 2", "beta 10", "Charlie", "Zulu"]);
    assert.deepEqual(groups.map(g => g.id), original, "sorting must not mutate the cached workspace");
    assert.deepEqual(queueGroups({ groups }, new Set(original)).map(g => g.id), alphabeticalGroups(groups).map(g => g.id));
    const staleSelected = new Set([...original, "TEST_ONLY_removed"]);
    const retained = retainedGroupSelection(groups, staleSelected);
    assert.deepEqual([...retained], original);
    assert.ok(staleSelected.has("TEST_ONLY_removed"), "pruning must not mutate prior selection state");
    assert.equal(retainedGroupSelection(groups, retained), retained, "unchanged selections must retain their identity");
    const afterLeave = groups.slice(1);
    const afterPoll = retainedGroupSelection(afterLeave, retained);
    assert.equal(afterPoll.size, afterLeave.length);
    assert.equal(afterPoll.has(groups[0].id), false);
    assert.equal(retainedGroupSelection([...afterLeave, { id: "newly-discovered" }], afterPoll).has("newly-discovered"), false,
      "a refresh must never select newly discovered destinations automatically");
    assert.equal(retainedGroupSelection([], afterPoll).size, 0);
    const { GroupsPanel } = await vite.ssrLoadModule("/src/components/advertising-panels.tsx");
    const renderGroups = (visible, refreshing = false) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(GroupsPanel, { ws: { groups: visible, account: { connected: false } }, selected: staleSelected,
        setSelected: () => {}, sequential: true, onRefresh: () => {}, refreshing })));
    const groupHtml = renderGroups(groups);
    assert.match(groupHtml, /data-testid="text-selected-count">5 selected/);
    assert.match(groupHtml, new RegExp(`data-testid="row-group-${groups[0].id}"`));
    const refreshedHtml = renderGroups(afterLeave, true);
    assert.match(refreshedHtml, /data-testid="text-selected-count">4 selected/);
    assert.doesNotMatch(refreshedHtml, new RegExp(`data-testid="row-group-${groups[0].id}"`));
    assert.match(refreshedHtml, /<button[^>]*disabled=""[^>]*data-testid="button-refresh-groups"/);
    let scrollTop = 0;
    let rowHeight = 81;
    const rows = Array.from({ length: 12 }, (_, i) => ({ getBoundingClientRect: () => ({
      top: 110 + i * rowHeight - scrollTop, bottom: 110 + (i + 1) * rowHeight - scrollTop,
    }) }));
    const viewport = { children: rows, getBoundingClientRect: () => ({ top: 110 }) };
    for (const position of [0, 100, 400, 811, 1200]) {
      scrollTop = position;
      assert.equal(groupListViewportHeight(viewport), 812, "scrolling must not shrink the ten-row window");
    }
    rowHeight = 132;
    assert.equal(groupListViewportHeight(viewport), 1322, "wrapped mobile rows must still fit ten rows");
    for (const count of [0, 1, 10])
      assert.equal(groupListViewportHeight({ ...viewport, children: rows.slice(0, count) }), undefined);
    const listHtml = renderToStaticMarkup(createElement(ScrollableGroupList, { count: 12 },
      Array.from({ length: 12 }, (_, i) => createElement("li", { key: i }, `Group ${i + 1}`))));
    assert.equal((listHtml.match(/<li>/g) ?? []).length, 12, "all rows remain reachable without pagination");
    assert.match(listHtml, /overflow-y-auto/);
    for (const value of ["1", "2", "500"]) {
      assert.equal(groupsPerIntervalOk(Number(value)), true);
      const html = renderToStaticMarkup(createElement(GroupsPerIntervalPanel, { value, onChange: () => {} }));
      assert.match(html, /data-testid="input-groups-per-interval"/);
      assert.match(html, /min="1" max="500" step="1"/);
      assert.match(html, new RegExp(`value="${value}"`));
      assert.match(html, /once to each/);
      assert.doesNotMatch(html, /Copies per group|Messages per group|copies\/group/);
      assert.doesNotMatch(html, /data-testid="error-groups-per-interval"/);
    }
    for (const value of ["", "0", "-1", "501", "1.5"]) {
      assert.equal(groupsPerIntervalOk(Number(value)), false);
      const html = renderToStaticMarkup(createElement(GroupsPerIntervalPanel, { value, onChange: () => {} }));
      assert.match(html, /data-testid="error-groups-per-interval"/);
    }
  } finally {
    await vite.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
