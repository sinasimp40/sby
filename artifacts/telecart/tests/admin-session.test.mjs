import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("background session checks preserve the screen but never revive expired or signed-out sessions", async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cacheDir = mkdtempSync(join(tmpdir(), "telecart-auth-test-"));
  const vite = await createServer({ configFile: false, root, cacheDir, logLevel: "error",
    server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  const user = { signedIn: true, ownerId: "TEST_ONLY_OWNER", email: "test-only@example.invalid" };
  const publicSession = { signedIn: false, ownerId: null, email: null };
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  try {
    const { AdminSessionController } = await vite.ssrLoadModule("/src/hooks/admin-session-controller.ts");
    await t.test("temporary errors preserve identity and repeated successful checks do not rerender the app", async () => {
      let response = user;
      const controller = new AdminSessionController({
        check: async () => { if (response instanceof Error) throw response; return { ...response }; },
        login: async () => user, logout: async () => {},
      });
      let changes = 0;
      const unsubscribe = controller.subscribe(() => changes++);
      await controller.refresh();
      assert.equal(changes, 1);
      const stable = controller.snapshot();
      await controller.refresh();
      assert.equal(controller.snapshot(), stable);
      assert.equal(changes, 1, "an unchanged periodic session check must not notify React");
      response = new TypeError("TEST_ONLY network interruption");
      await controller.refresh();
      assert.equal(controller.snapshot().session, stable.session);
      assert.equal(controller.snapshot().error, null);
      assert.match(controller.snapshot().connectionWarning, /Connection interrupted/);
      response = user;
      await controller.refresh();
      assert.equal(controller.snapshot().connectionWarning, null);
      assert.equal(controller.snapshot().session.ownerId, user.ownerId);
      unsubscribe();
    });
    await t.test("confirmed expiration and authorization rejection clear the old identity immediately", async () => {
      for (const failure of [publicSession, Object.assign(new Error("TEST_ONLY unauthorized"), { status: 401 }),
        Object.assign(new Error("TEST_ONLY forbidden"), { status: 403 })]) {
        let response = user;
        const controller = new AdminSessionController({
          check: async () => { if (response instanceof Error) throw response; return response; },
          login: async () => user, logout: async () => {},
        });
        await controller.refresh();
        response = failure;
        await controller.refresh();
        assert.equal(controller.snapshot().session.signedIn, false);
        assert.equal(controller.snapshot().session.ownerId, null);
        assert.equal(controller.snapshot().connectionWarning, null);
      }
    });
    await t.test("a failed initial check never invents a signed-in session and can recover without reload", async () => {
      let fail = true;
      const controller = new AdminSessionController({
        check: async () => { if (fail) throw new TypeError("TEST_ONLY offline"); return publicSession; },
        login: async () => user, logout: async () => {},
      });
      await controller.refresh();
      assert.equal(controller.snapshot().session, null);
      assert.equal(controller.snapshot().loaded, true);
      assert.match(controller.snapshot().error, /Reconnecting automatically/);
      fail = false;
      await controller.refresh();
      assert.equal(controller.snapshot().error, null);
      assert.equal(controller.snapshot().session.signedIn, false);
    });
    await t.test("an old background response cannot log a user back in after logout", async () => {
      const pending = deferred();
      const controller = new AdminSessionController({ check: () => pending.promise,
        login: async () => user, logout: async () => {} });
      await controller.signIn({ email: user.email, password: "TEST_ONLY" });
      const oldCheck = controller.refresh();
      await controller.signOut();
      pending.resolve(user);
      await oldCheck;
      assert.equal(controller.snapshot().session.signedIn, false);
    });
    await t.test("a delayed signed-out response cannot overwrite a successful login", async () => {
      const pending = deferred();
      const controller = new AdminSessionController({ check: () => pending.promise,
        login: async () => user, logout: async () => {} });
      const oldCheck = controller.refresh();
      await controller.signIn({ email: user.email, password: "TEST_ONLY" });
      pending.resolve(publicSession);
      await oldCheck;
      assert.equal(controller.snapshot().session.ownerId, user.ownerId);
    });
    await t.test("overlapping background checks coalesce and cancelled requests cannot update the screen", async () => {
      const pending = deferred();
      let checks = 0, signal;
      const controller = new AdminSessionController({ check: options => { checks++; signal = options.signal; return pending.promise; },
        login: async () => user, logout: async () => {} });
      const first = controller.refresh();
      await controller.refresh();
      assert.equal(checks, 1);
      controller.cancelCheck();
      assert.equal(signal.aborted, true);
      pending.resolve(user); await first;
      assert.equal(controller.snapshot().session, null);
    });
    await t.test("a genuine owner change is published so private query caches can be replaced", async () => {
      let response = user;
      const controller = new AdminSessionController({ check: async () => response,
        login: async () => user, logout: async () => {} });
      await controller.refresh();
      response = { ...user, ownerId: "TEST_ONLY_OTHER_OWNER" };
      await controller.refresh();
      assert.equal(controller.snapshot().session.ownerId, response.ownerId);
    });
  } finally { await vite.close(); rmSync(cacheDir, { recursive: true, force: true }); }
});
