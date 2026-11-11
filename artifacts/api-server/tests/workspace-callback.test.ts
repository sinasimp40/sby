import test from "node:test";
import assert from "node:assert/strict";
import { publicBaseUrl } from "../src/lib/commerce-providers";

test("workspace callbacks require an explicit opt-in and exact current workspace host", () => {
  const keys = ["NODE_ENV", "TELECART_PUBLIC_URL", "TELECART_ALLOW_WORKSPACE_TESTING", "REPLIT_DEV_DOMAIN"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.REPLIT_DEV_DOMAIN = "my-workspace.replit.dev";
    process.env.TELECART_PUBLIC_URL = "https://my-workspace.replit.dev";
    process.env.NODE_ENV = "development";
    delete process.env.TELECART_ALLOW_WORKSPACE_TESTING;
    assert.equal(publicBaseUrl(), "");
    process.env.TELECART_ALLOW_WORKSPACE_TESTING = "true";
    assert.equal(publicBaseUrl(), "https://my-workspace.replit.dev");
    process.env.TELECART_PUBLIC_URL = "https://other-workspace.replit.dev";
    assert.equal(publicBaseUrl(), "");
    process.env.TELECART_PUBLIC_URL = "https://my-workspace.replit.dev";
    process.env.NODE_ENV = "production";
    assert.equal(publicBaseUrl(), "");
    process.env.TELECART_PUBLIC_URL = "https://shop.example.com";
    assert.equal(publicBaseUrl(), "https://shop.example.com");
    process.env.TELECART_PUBLIC_URL = "https://shop.example.com/unsafe";
    assert.equal(publicBaseUrl(), "");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
