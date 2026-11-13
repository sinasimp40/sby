import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

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
    const { GroupsPerIntervalPanel, groupsPerIntervalOk } = await vite.ssrLoadModule("/src/components/advertising/forwarding-panels.tsx");
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
