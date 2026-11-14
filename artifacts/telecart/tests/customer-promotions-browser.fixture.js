// Browser init script for safe UI verification. Install BEFORE navigation.
// All /api requests are answered in-page; never enables a real shop schedule.
(() => {
  const key = "TEST_ONLY_PROMOTION_BROWSER_STATE";
  const groupId = "cc000000-0000-4000-8000-000000000001";
  const initial = { enabled: false, intervalMinutes: 60, flags: {}, requests: [] };
  const load = () => JSON.parse(localStorage.getItem(key) || JSON.stringify(initial));
  const save = state => localStorage.setItem(key, JSON.stringify(state));
  const product = (id, name, extra = {}) => ({
    id, name, description: "TEST_ONLY product description", category: "", price: id === 701 ? 5 : 6,
    status: "active", deliveryFormat: "user:pass", stock: 3, sold: 0, buttonEmoji: "",
    buttonCustomEmojiId: null, imageUrl: null, groupId: null, groupName: null,
    groupDescription: null, optionName: null, createdAt: "2026-11-01T00:00:00Z", ...extra,
  });
  const options = [
    product(701, "Southwest — 15–20k points", { groupId, groupName: "Southwest", optionName: "15–20k points" }),
    product(702, "Southwest — 20–40k points", { groupId, groupName: "Southwest", optionName: "20–40k points" }),
  ];
  const products = [...options, product(703, "TEST_ONLY Standalone"), product(704, "TEST_ONLY Sold out", { stock: 0 })];
  const status = () => {
    const state = load();
    return {
      enabled: state.enabled, intervalMinutes: state.intervalMinutes,
      nextAt: state.enabled ? new Date(Date.now() + state.intervalMinutes * 60000).toISOString() : null,
      info: state.enabled ? "Waiting for the next shared promotion round." : "Customer promotions are disabled.",
      eligibleCount: products.filter(p => state.flags[p.id] && p.status === "active" && p.stock > 0).length,
      recipientCount: 3, products: Object.entries(state.flags).map(([productId, enabled]) => ({ productId: Number(productId), enabled })),
      rounds: [{ id: "TEST_ONLY_ROUND", productId: 701, productName: options[0].name, status: "completed",
        sent: 2, failed: 0, uncertain: 1, skipped: 0, info: "TEST_ONLY prior round. Uncertain delivery was not retried.",
        createdAt: "2026-11-01T10:00:00Z", completedAt: "2026-11-01T10:01:00Z" }],
      deliveries: [{ id: "TEST_ONLY_DELIVERY", roundId: "TEST_ONLY_ROUND", status: "unknown", attempts: 1,
        error: "TEST_ONLY uncertain Telegram outcome. Not automatically retried.", updatedAt: "2026-11-01T10:01:00Z" }],
    };
  };
  const isApi = input => new URL(typeof input === "string" ? input : input.url || String(input), location.origin).pathname.startsWith("/api/");
  async function respond(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url || String(input), location.origin);
    const method = String(init.method || input.method || "GET").toUpperCase();
    const path = url.pathname;
    let body = {}, code = 200;
    if (path === "/api/admin/session") body = { signedIn: true, ownerId: "TEST_ONLY_PROMO_OWNER", email: "test-only@example.invalid" };
    else if (path === "/api/shop/products") body = products;
    else if (path === "/api/shop/product-groups") body = [{ id: groupId, name: "Southwest", description: "", imageUrl: null, buttonEmoji: "", buttonCustomEmojiId: null, options }];
    else if (path === "/api/shop/settings") body = { shopName: "TEST_ONLY promotions", currency: "USD" };
    else if (path === "/api/shop/customer-promotions" || path === "/api/shop/customer-promotions/products") {
      const state = load();
      if (method !== "GET") {
        const data = JSON.parse(init.body || await input.clone().text());
        state.requests.push({ path, method, data });
        if (method === "PUT") { state.enabled = data.enabled; state.intervalMinutes = data.intervalMinutes; }
        else if (method === "POST") for (const id of data.productIds) state.flags[id] = data.enabled;
        else code = 403;
        save(state);
      }
      body = status();
    } else if (!["GET", "HEAD"].includes(method)) { code = 403; body = { error: "TEST_ONLY unexpected write blocked" }; }
    else if (path.endsWith("/orders") || path.endsWith("/activity")) body = [];
    return new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json" } });
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => isApi(input) ? respond(input, init) : originalFetch(input, init);
  const NativeXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends NativeXHR {
    open(method, url, ...args) {
      this._testApi = isApi(String(url));
      if (this._testApi) { this._testMethod = method; this._testUrl = String(url); }
      else super.open(method, url, ...args);
    }
    send(body) {
      if (!this._testApi) return super.send(body);
      void respond(this._testUrl, { method: this._testMethod, body }).then(async response => {
        const text = await response.text();
        for (const [field, value] of Object.entries({ readyState: 4, status: response.status, responseText: text, response: text }))
          Object.defineProperty(this, field, { configurable: true, value });
        this.dispatchEvent(new Event("readystatechange")); this.dispatchEvent(new Event("load")); this.dispatchEvent(new Event("loadend"));
      });
    }
  };
  const NativeEvents = window.EventSource;
  window.EventSource = function(url, options) {
    if (!isApi(String(url))) return new NativeEvents(url, options);
    const target = new EventTarget(); target.readyState = 2; target.close = () => {}; return target;
  };
  const beacon = navigator.sendBeacon?.bind(navigator);
  navigator.sendBeacon = (url, data) => isApi(String(url)) ? true : beacon ? beacon(url, data) : false;
  window.__TEST_ONLY_PROMOTIONS__ = { state: load, groupId, status };
})();
