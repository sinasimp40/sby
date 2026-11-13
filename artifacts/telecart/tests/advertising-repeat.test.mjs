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
    const { alphabeticalGroups, retainedGroupSelection, filteredGroups, selectedGroupIdsInView, selectGroupsInView, snapshotGroupRemoval, snapshotEnabledGroups, ScrollableGroupList, groupListViewportHeight } = await vite.ssrLoadModule("/src/components/advertising/group-list.tsx");
    const { CampaignGroupCounts, campaignGroupCounts } = await vite.ssrLoadModule("/src/components/advertising/campaign-group-counts.tsx");
    const countGroups = Array.from({ length: 211 }, (_, i) => ({
      id: `count-${i}`, title: `Group ${i}`, target: `-${i + 1}`, chatId: i < 205 ? `-${i + 1}` : null,
      status: i >= 175 && i < 205 ? "pending" : "ready", enabled: !(i >= 165 && i < 175), running: i < 165,
    }));
    const countWs = { groups: countGroups, forwarding: { running: true, groupIds: countGroups.slice(0, 165).map(group => group.id) } };
    const countSelection = new Set([...countGroups.map(group => group.id), "removed-group"]);
    assert.deepEqual(campaignGroupCounts(countWs, countSelection), {
      selected: 211, eligible: 165, active: 165, disabled: 10, needsPermission: 30, missingIdentity: 6,
      eligibleOutsideCampaign: 0, activeOutsideSelection: 0, legacyActive: 0,
    });
    const countHtml = renderToStaticMarkup(createElement(CampaignGroupCounts, { ws: countWs, selected: countSelection }));
    assert.match(countHtml, /Selected for a new campaign/);
    assert.match(countHtml, /Eligible for a new campaign/);
    assert.match(countHtml, /In the running campaign/);
    assert.match(countHtml, /46 selected groups are not eligible/);
    assert.match(countHtml, /10 disabled; 30 need a successful permission check; 6 missing a verified Telegram group ID/);
    assert.match(countHtml, /Checkbox changes do not change the running campaign/);
    const eligibleAllWs = { ...countWs, groups: countGroups.map(group => ({ ...group, enabled: true, status: "ready", chatId: group.target })) };
    assert.equal(campaignGroupCounts(eligibleAllWs, countSelection).eligibleOutsideCampaign, 46);
    const deselected = new Set(countGroups.slice(1).map(group => group.id));
    assert.equal(campaignGroupCounts(eligibleAllWs, deselected).activeOutsideSelection, 1);
    const stoppedCounts = campaignGroupCounts({ ...countWs, forwarding: { running: false, groupIds: countWs.forwarding.groupIds } }, countSelection);
    assert.equal(stoppedCounts.active, 0, "a saved/stopped plan is not an active campaign");
    assert.equal(stoppedCounts.legacyActive, 165, "older running schedules must still be disclosed separately");
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
    const filterFixture = [
      { id: "bad-1", title: "Alpha error", status: "error", target: "-123", chatId: "-100123" },
      { id: "bad-2", title: "Beta error", status: "error", target: "@test_only", chatId: "-100456" },
      { id: "good", title: "Alpha ready", status: "ready", target: "-789", chatId: "-100789" },
      ...["pending", "needs_setup", "duplicate"].map(status => ({ id: status, status, title: status, target: `@${status}`, chatId: null })),
    ];
    const allSelected = new Set(filterFixture.map(group => group.id));
    const errors = filteredGroups(filterFixture, "error", "");
    assert.deepEqual(selectedGroupIdsInView(errors, allSelected), ["bad-1", "bad-2"],
      "error-category actions cannot target selected ready or hidden groups");
    const searchedErrors = filteredGroups(filterFixture, "error", " ALPHA ");
    assert.deepEqual(selectedGroupIdsInView(searchedErrors, allSelected), ["bad-1"]);
    assert.deepEqual(filteredGroups(filterFixture, "all", "-100456").map(group => group.id), ["bad-2"]);
    for (const status of ["ready", "pending", "needs_setup", "duplicate"])
      assert.deepEqual(filteredGroups(filterFixture, status, "").map(group => group.id), [status === "ready" ? "good" : status]);
    const enabledFixture = filterFixture.map((group, index) => ({ ...group, enabled: index !== 0 && index !== 2 }));
    const disabled = filteredGroups(enabledFixture, "disabled", "");
    assert.deepEqual(disabled.map(group => group.id), ["bad-1", "good"],
      "disabled is based on the enable switch, regardless of permission status");
    assert.deepEqual(filteredGroups(enabledFixture, "disabled", "ready").map(group => group.id), ["good"]);
    assert.deepEqual(selectedGroupIdsInView(disabled, allSelected), ["bad-1", "good"]);
    assert.deepEqual(snapshotGroupRemoval(disabled, allSelected).map(group => group.id), ["bad-1", "good"]);
    assert.deepEqual([...selectGroupsInView(disabled, new Set(), true)], ["bad-1", "good"]);
    assert.deepEqual(filteredGroups(enabledFixture.map(group => ({ ...group, enabled: true })), "disabled", ""), []);
    const disableErrors = snapshotEnabledGroups(filteredGroups(enabledFixture, "error", ""));
    assert.deepEqual(disableErrors.map(group => group.id), ["bad-2"],
      "Disable all shown ignores hidden categories and groups already off");
    assert.deepEqual(snapshotEnabledGroups(filteredGroups(enabledFixture, "all", "beta")).map(group => group.id), ["bad-2"],
      "Disable all shown also respects search");
    assert.deepEqual(snapshotEnabledGroups(disabled), [], "Disabled filter has nothing left to turn off");
    assert.deepEqual(snapshotEnabledGroups([]), []);
    const disableAll = snapshotEnabledGroups(enabledFixture);
    assert.equal(disableAll.length, enabledFixture.filter(group => group.enabled).length);
    enabledFixture[1].title = "Later live update";
    enabledFixture.push({ ...enabledFixture[1], id: "later-enabled-group" });
    assert.equal(disableErrors[0].title, "Beta error", "confirmation is a frozen list, not expanded by live updates");
    assert.equal(disableAll.some(group => group.id === "later-enabled-group"), false);
    const withoutErrors = selectGroupsInView(errors, allSelected, false);
    assert.ok(withoutErrors.has("good"));
    assert.ok(!withoutErrors.has("bad-1"));
    assert.equal(allSelected.size, filterFixture.length, "selection updates cannot mutate saved choices");
    assert.deepEqual([...selectGroupsInView(errors, new Set(["good"]), true)], ["good", "bad-1", "bad-2"]);
    assert.deepEqual(selectedGroupIdsInView(filteredGroups(filterFixture, "error", "no-match"), allSelected), []);
    const confirmed = snapshotGroupRemoval(searchedErrors, allSelected);
    filterFixture[0].title = "Changed by a live update";
    searchedErrors.push({ ...filterFixture[1], id: "new-live-error" });
    assert.deepEqual(confirmed, [{ id: "bad-1", title: "Alpha error", target: "-123" }],
      "a live update cannot expand or retarget the confirmed removal");
    const { GroupsPanel } = await vite.ssrLoadModule("/src/components/advertising-panels.tsx");
    const renderGroups = (visible, refreshing = false, selection = staleSelected) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(GroupsPanel, { ws: { groups: visible, account: { connected: false } }, selected: selection,
        setSelected: () => {}, sequential: true, onRefresh: () => {}, refreshing })));
    const groupHtml = renderGroups(groups);
    assert.match(groupHtml, /data-testid="filter-group-disabled"/);
    assert.match(groupHtml, /data-testid="text-selected-count">5 selected/);
    assert.match(groupHtml, /Select all 5 shown/);
    assert.match(groupHtml, /data-testid="text-visible-selected-count">5 selected here/);
    assert.match(groupHtml, /data-testid="button-remove-selected-groups"/);
    assert.match(groupHtml, /data-testid="button-disable-all-groups"/);
    assert.match(renderGroups(groups, false, new Set([groups[0].id])), /aria-checked="mixed"/);
    const noSelection = renderGroups(groups, false, new Set());
    assert.match(noSelection, /<button[^>]*disabled=""[^>]*data-testid="button-remove-selected-groups"/);
    const disableButton = noSelection.match(/<button[^>]*data-testid="button-disable-all-groups"[^>]*>/)?.[0];
    assert.ok(disableButton);
    assert.doesNotMatch(disableButton, /\sdisabled(?:=""|(?=\s|>))/,
      "Disable all shown must work even when no campaign checkboxes are selected");
    assert.match(renderGroups(groups.map(group => ({ ...group, enabled: false }))), /<button[^>]*disabled=""[^>]*data-testid="button-disable-all-groups"/);
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
