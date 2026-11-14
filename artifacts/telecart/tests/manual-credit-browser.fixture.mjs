/**
 * Safe browser-only fixture: install before navigating. EVERY /api request is
 * fulfilled locally; nothing, including a wallet POST, reaches the live shop.
 * Tests may toggle failNextAfterApply to simulate an uncertain server outcome.
 */
export async function installManualCreditFixture(page) {
  const customerId = "aa000000-0000-4000-8000-000000000001";
  const ownerId = "TEST_ONLY_OWNER";
  const state = { balanceCents: 1000, entries: [], operations: new Map(), requests: [], failNextAfterApply: false };
  const customer = () => ({ id: customerId, username: "@TEST_ONLY_WALLET", telegramId: "900000000001",
    orderCount: 0, spent: 0, walletBalance: state.balanceCents / 100, joinedAt: "2026-11-01T00:00:00Z" });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/admin/session") return reply({ signedIn: true, ownerId, email: "test-only@example.invalid" });
    if (path === "/api/shop/customers") return reply([customer()]);
    if (path === "/api/shop/orders" || path === "/api/shop/activity") return reply([]);
    if (path === "/api/shop/settings") return reply({ shopName: "TEST_ONLY wallet test", currency: "USD" });
    if (path === `/api/shop/customers/${customerId}/credits`) {
      if (request.method() === "GET") return reply({ entries: state.entries, nextCursor: null, balanceCents: state.balanceCents, currency: "USD" });
      if (request.method() === "POST") {
        const input = request.postDataJSON();
        state.requests.push(input);
        let credit = state.operations.get(input.requestKey);
        const replayed = !!credit;
        if (!credit) {
          const before = state.balanceCents;
          state.balanceCents += input.amountCents;
          credit = { id: `bb000000-0000-4000-8000-${String(state.entries.length + 1).padStart(12, "0")}`,
            customerId, actorId: ownerId, amountCents: input.amountCents,
            balanceBeforeCents: before, balanceAfterCents: state.balanceCents,
            reason: input.reason, createdAt: new Date().toISOString() };
          state.operations.set(input.requestKey, credit); state.entries.unshift(credit);
        }
        if (state.failNextAfterApply) {
          state.failNextAfterApply = false;
          return reply({ error: "TEST_ONLY response lost after applying credit. Retry safely." }, 500);
        }
        return reply({ credit, balanceCents: state.balanceCents, currency: "USD", replayed });
      }
    }
    // Never fall through to real APIs, even if the UI unexpectedly calls one.
    if (!["GET", "HEAD"].includes(request.method())) return reply({ error: "TEST_ONLY unexpected write blocked" }, 403);
    if (path === "/api/shop/overview") return reply({ isDemo: false, walletBalance: state.balanceCents / 100, revenue: 0,
      orderCount: 0, customerCount: 1, productCount: 0, stockCount: 0, pendingPayments: 0,
      botConnected: false, paymentsConnected: false, recentOrders: [], topProducts: [], checklist: [] });
    return reply({});
  });
  return { state, customerId, ownerId };
}
