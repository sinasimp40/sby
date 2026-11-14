import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("credit amounts and browser retry references cannot silently change a financial operation", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cacheDir = mkdtempSync(join(tmpdir(), "telecart-wallet-ui-"));
  const vite = await createServer({
    configFile: false, root, cacheDir, logLevel: "error",
    resolve: { alias: { "@": join(root, "src") } }, esbuild: { jsx: "automatic" },
    optimizeDeps: { noDiscovery: true, include: [] }, ssr: { noExternal: [/^@workspace\//] },
    server: { middlewareMode: true, hmr: false },
  });
  const originalWindow = globalThis.window;
  try {
    const { walletCreditCents, readPendingCredit, pendingCreditKey, creditFailureIsDefinite } = await vite.ssrLoadModule("/src/lib/wallet-credit.ts");
    for (const [text, cents] of [["0.01", 1], ["1", 100], ["12.34", 1234], [" 10.5 ", 1050], ["20000000.00", 2000000000]])
      assert.equal(walletCreditCents(text), cents);
    for (const text of ["", "0", "-1", "1.005", "1e3", "NaN", "Infinity", "1,000", "20000000.01", "100000000000", ".5", "01.00"])
      assert.equal(walletCreditCents(text), null, text);
    const key = pendingCreditKey("TEST_ONLY_OWNER", "TEST_ONLY_CUSTOMER");
    assert.notEqual(key, pendingCreditKey("TEST_ONLY_OTHER", "TEST_ONLY_CUSTOMER"));
    assert.notEqual(key, pendingCreditKey("TEST_ONLY_OWNER", "TEST_ONLY_OTHER"));
    let value = null;
    globalThis.window = { sessionStorage: { getItem: () => value } };
    assert.deepEqual(readPendingCredit(key), { input: null, error: "" });
    const input = { requestKey: "12345678-1234-4234-8234-123456789012", amountCents: 1000, reason: "TEST_ONLY reason" };
    value = JSON.stringify(input);
    assert.deepEqual(readPendingCredit(key).input, input);
    for (const bad of ["not JSON", "null", JSON.stringify({ ...input, amountCents: 1.5 }), JSON.stringify({ ...input, reason: "" })]) {
      value = bad;
      assert.equal(readPendingCredit(key).input, null);
      assert.match(readPendingCredit(key).error, /pending credit reference/);
    }
    globalThis.window.sessionStorage.getItem = () => { throw new Error("TEST_ONLY blocked storage"); };
    assert.match(readPendingCredit(key).error, /pending credit reference/);
    for (const status of [400, 401, 403, 404, 409, 429]) assert.equal(creditFailureIsDefinite({ status }), true);
    for (const error of [new Error("timeout"), { status: 408 }, { status: 500 }, { status: 502 }, { status: 503 }, null])
      assert.equal(creditFailureIsDefinite(error), false, "unknown outcomes must retain the original operation key");
  } finally {
    globalThis.window = originalWindow;
    await vite.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
