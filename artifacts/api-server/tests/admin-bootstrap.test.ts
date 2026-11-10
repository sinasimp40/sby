import test from "node:test";
import assert from "node:assert/strict";
import { seedConfiguredAdmin } from "../src/lib/admin-bootstrap";

test("admin bootstrap creates once, preserves password and does not restore revoked access", async () => {
  let user: any;
  let creates = 0;
  const config = { email: "bootstrap@example.invalid", password: "TEST_ONLY_NOT_A_REAL_PASSWORD", signingSecret: "TEST_ONLY_SIGNING_SECRET", environment: "test" };
  const users = {
    find: async () => user ? [user] : [],
    create: async (input: any) => { creates++; user = { id: "TEST_ONLY_ADMIN", ...input }; return user; },
  };
  assert.equal(await seedConfiguredAdmin(config, users), "TEST_ONLY_ADMIN");
  assert.equal(creates, 1);
  assert.equal(await seedConfiguredAdmin({ ...config, password: "A_DIFFERENT_TEST_PASSWORD" }, users), "TEST_ONLY_ADMIN");
  assert.equal(creates, 1);
  user.publicMetadata.role = "user";
  assert.equal(await seedConfiguredAdmin(config, users), null);
  assert.equal(creates, 1);
});

test("existing unbound accounts cannot be taken over by matching email", async () => {
  let creates = 0;
  const users = {
    find: async () => [{ id: "UNRELATED_TEST_USER", publicMetadata: { role: "user" }, privateMetadata: {} }],
    create: async () => { creates++; throw new Error("Should not create"); },
  };
  await assert.rejects(() => seedConfiguredAdmin({
    email: "bootstrap@example.invalid", password: "TEST_ONLY", signingSecret: "TEST_ONLY", environment: "test",
  }, users), /unbound account/);
  assert.equal(creates, 0);
});

test("no shared/default password is assigned when initial secret is missing", async () => {
  let creates = 0;
  const users = { find: async () => [], create: async () => { creates++; throw new Error("Should not create"); } };
  assert.equal(await seedConfiguredAdmin({ email: "bootstrap@example.invalid", signingSecret: "TEST_ONLY", environment: "test" }, users), null);
  assert.equal(await seedConfiguredAdmin({ signingSecret: "TEST_ONLY", environment: "test" }, users), null);
  assert.equal(creates, 0);
});

test("concurrent creation accepts only a signed account from the same environment", async () => {
  let user: any;
  let calls = 0;
  const config = { email: "bootstrap@example.invalid", password: "TEST_ONLY", signingSecret: "TEST_ONLY", environment: "test" };
  await seedConfiguredAdmin(config, {
    find: async () => [],
    create: async input => { user = { id: "TEST_ONLY_RACE", ...input }; return user; },
  });
  assert.equal(await seedConfiguredAdmin(config, {
    find: async () => (++calls === 1 ? [] : [user]),
    create: async () => { throw new Error("Mock conflict"); },
  }), "TEST_ONLY_RACE");
  await assert.rejects(() => seedConfiguredAdmin({ ...config, environment: "production" }, {
    find: async () => [user], create: async () => { throw new Error("Should not create"); },
  }), /unbound account/);
});
