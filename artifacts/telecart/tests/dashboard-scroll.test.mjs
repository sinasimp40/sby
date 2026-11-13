import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("dashboard record windows are bounded, keyboard accessible and do not truncate records", async () => {
  const css = readFileSync(join(root, "src/index.css"), "utf8");
  const scrollRule = css.match(/\.dashboard-scroll\s*\{([^}]+)\}/)[1];
  assert.match(scrollRule, /max-height:\s*min\(36rem,\s*70dvh\)/);
  assert.match(scrollRule, /overflow:\s*auto/);
  assert.match(css, /\.dashboard-table-scroll > table > thead\s*\{[^}]*position:\s*sticky/);
  for (const [file, region] of [
    ["pages/orders.tsx", "scroll-orders"], ["pages/products.tsx", "scroll-products"],
    ["pages/customers.tsx", "scroll-customers"], ["pages/wallets.tsx", "scroll-deposits"],
    ["pages/inventory.tsx", "scroll-inventory"], ["components/payment-attempts.tsx", "scroll-payments"],
    ["components/advertising/membership-panel.tsx", "scroll-membership-results"],
  ]) {
    const source = readFileSync(join(root, "src", file), "utf8");
    assert.match(source, new RegExp(`<[^>]*className="dashboard-scroll[^"]*"[^>]*tabIndex=\\{0\\}[^>]*data-testid="${region}"`), file);
  }
  assert.match(readFileSync(join(root, "src/components/ui/sheet.tsx"), "utf8"), /max-h-\[100dvh\] overflow-y-auto/);
  assert.match(readFileSync(join(root, "src/components/ui/alert-dialog.tsx"), "utf8"), /max-h-\[85dvh\] overflow-y-auto/);

  const cacheDir = mkdtempSync(join(tmpdir(), "telecart-scroll-ui-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in scroll regression tests"); };
  const vite = await createServer({
    configFile: false, root, cacheDir, logLevel: "error",
    resolve: { alias: { "@": join(root, "src") } }, esbuild: { jsx: "automatic" },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: [/^@workspace\//] },
    server: { middlewareMode: true, hmr: { host: "127.0.0.1", port: 0 } },
  });
  const client = new QueryClient();
  const render = component => renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(Router, { ssrPath: "/" }, component)));
  try {
    const api = await vite.ssrLoadModule("@workspace/api-client-react");
    const count = 40;
    const orders = Array.from({ length: count }, (_, i) => ({
      id: `TEST_ONLY_order_${i}`, customer: `@TEST_ONLY_${i}`, productName: `TEST_ONLY_product_${i}`,
      amount: 5, status: "delivered", paymentMethod: "wallet", createdAt: "2026-11-13T00:00:00Z",
    }));
    client.setQueryData(api.getListOrdersQueryKey(), orders);
    const customers = orders.map((order, i) => ({
      id: i + 1, username: order.customer, telegramId: String(9000000 + i),
      orderCount: 1, spent: 5, walletBalance: 0, joinedAt: order.createdAt,
    }));
    client.setQueryData(api.getListCustomersQueryKey(), customers);
    client.setQueryData(api.getListDepositsQueryKey(), orders.map((order, i) => ({
      id: `TEST_ONLY_deposit_${i}`, customer: order.customer, amount: 5,
      currency: "USDTTRC20", status: "finished", createdAt: order.createdAt, canCancel: false, cancelledAt: null,
    })));
    for (const [file, rowPrefix, region] of [
      ["orders", "row-order-", "scroll-orders"], ["customers", "row-customer-", "scroll-customers"],
      ["wallets", "row-deposit-", "scroll-deposits"],
    ]) {
      const { default: Page } = await vite.ssrLoadModule(`/src/pages/${file}.tsx`);
      const html = render(createElement(Page));
      assert.equal((html.match(new RegExp(`data-testid="${rowPrefix}`, "g")) ?? []).length, count, `${file} keeps every record`);
      assert.match(html, new RegExp(`data-testid="${region}"`));
    }
    const { MembershipPanel } = await vite.ssrLoadModule("/src/components/advertising/membership-panel.tsx");
    const html = render(createElement(MembershipPanel, { ws: {
      account: { connected: false, accountId: null, login: null },
      membershipJobs: orders.map((order, i) => ({
        id: order.id, target: `@TEST_ONLY_group_${i}`, title: `Group ${i}`,
        action: "leave", status: "left", note: "TEST_ONLY confirmed leaving", accountId: "900000009", createdAt: order.createdAt,
      })),
    } }));
    assert.equal((html.match(/data-testid="membership-job-/g) ?? []).length, count);
    assert.match(html, /aria-label="Group leave and join results"/);
    assert.match(html, /data-testid="scroll-membership-results"/);
  } finally {
    client.clear();
    await vite.close();
    globalThis.fetch = originalFetch;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
