import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("repeat controls render bounded values and errors without contacting Telegram", async () => {
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
    const { MessagesPerGroupPanel, copiesOk } = await vite.ssrLoadModule("/src/components/advertising/forwarding-panels.tsx");
    for (const value of ["1", "2", "10"]) {
      assert.equal(copiesOk(Number(value)), true);
      const html = renderToStaticMarkup(createElement(MessagesPerGroupPanel, { value, onChange: () => {} }));
      assert.match(html, /data-testid="input-messages-per-group"/);
      assert.match(html, /min="1" max="10" step="1"/);
      assert.match(html, new RegExp(`value="${value}"`));
      assert.doesNotMatch(html, /data-testid="error-messages-per-group"/);
    }
    for (const value of ["", "0", "-1", "11", "1.5"]) {
      assert.equal(copiesOk(Number(value)), false);
      const html = renderToStaticMarkup(createElement(MessagesPerGroupPanel, { value, onChange: () => {} }));
      assert.match(html, /data-testid="error-messages-per-group"/);
    }
  } finally {
    await vite.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
