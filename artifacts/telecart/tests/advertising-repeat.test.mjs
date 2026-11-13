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
    const { GroupsPerIntervalPanel, groupsPerIntervalOk, queueGroups } = await vite.ssrLoadModule("/src/components/advertising/forwarding-panels.tsx");
    const { alphabeticalGroups, ScrollableGroupList, groupListViewportHeight } = await vite.ssrLoadModule("/src/components/advertising/group-list.tsx");
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
    assert.deepEqual(alphabeticalGroups(groups).map(g => g.title || g.target), ["Alpha", "beta 2", "beta 10", "Charlie", "Zulu"]);
    assert.deepEqual(groups.map(g => g.id), original, "sorting must not mutate the cached workspace");
    assert.deepEqual(queueGroups({ groups }, new Set(original)).map(g => g.id), alphabeticalGroups(groups).map(g => g.id));
    const rows = Array.from({ length: 12 }, (_, i) => ({ getBoundingClientRect: () => ({ bottom: 110 + (i + 1) * 81 }) }));
    assert.equal(groupListViewportHeight({ children: rows, getBoundingClientRect: () => ({ top: 110 }) }), 811);
    assert.equal(groupListViewportHeight({ children: rows.slice(0, 10), getBoundingClientRect: () => ({ top: 110 }) }), undefined);
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
