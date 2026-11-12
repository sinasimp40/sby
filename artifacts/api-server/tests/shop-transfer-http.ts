// Manual, read-only HTTP verification against the running development app.
// Credentials and downloaded customer data stay in memory and are never logged.
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { setBaseUrl } from "../../../lib/api-client-react/src/custom-fetch";
import { getShopTransferStatus, exportShopData, previewShopData } from "../../../lib/api-client-react/src/generated/api";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Development verification only.");
  const domain = process.env.REPLIT_DEV_DOMAIN;
  const origin = process.env.TELECART_ADMIN_ORIGIN || process.env.TELECART_PUBLIC_URL;
  if (!domain || !origin || !process.env.TELECART_ADMIN_EMAIL || !process.env.TELECART_ADMIN_INITIAL_PASSWORD) {
    throw new Error("Configured development admin login is required for HTTP verification.");
  }
  const base = `https://${domain}`;
  setBaseUrl(base);
  const signedOut = await fetch(`${base}/api/shop/data-transfer`);
  assert.equal(signedOut.status, 401);
  assert.equal((await fetch(`${base}/api/shop/custom-emojis`)).status, 401);
  assert.equal((await fetch(`${base}/api/shop/custom-emojis/session`, { method: "POST" })).status, 401);
  const login = await fetch(`${base}/api/admin/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.TELECART_ADMIN_EMAIL, password: process.env.TELECART_ADMIN_INITIAL_PASSWORD }) });
  assert.equal(login.status, 200, "Configured-admin sign-in must succeed.");
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("No admin session was issued.");
  const headers = { Origin: origin, Cookie: cookie };
  try {
    const library = await fetch(`${base}/api/shop/custom-emojis`, { headers });
    assert.equal(library.status, 200);
    const icons = await library.json() as { items: unknown[]; maxItems: number };
    assert.ok(Array.isArray(icons.items));
    assert.equal(icons.maxItems, 2000);
    const badPack = await fetch(`${base}/api/shop/custom-emojis/pack`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ pack: "https://example.invalid/addemoji/Test" }),
    });
    assert.equal(badPack.status, 400);
    const foreignSession = await fetch(`${base}/api/shop/custom-emojis/session`, {
      method: "POST", headers: { Cookie: cookie, Origin: "https://example.invalid" },
    });
    assert.equal(foreignSession.status, 403);
    const status = await getShopTransferStatus({ headers });
    const archive = await exportShopData({ headers, responseType: "blob" });
    assert.ok(archive instanceof Blob);
    assert.equal(archive.type, "application/zip");
    assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await archive.arrayBuffer()))).sort(), ["README.txt", "manifest.json", "shop-data.json"]);
    const preview = await previewShopData(archive, { headers });
    assert.equal(Object.keys(preview.counts).length, 13);
    if (!status.empty) assert.equal(preview.canImport, false);
    assert.ok(preview.confirmationToken);
    const badZip = await fetch(`${base}/api/shop/data-transfer/preview`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: "NOT_A_ZIP",
    });
    assert.equal(badZip.status, 400);
    const unconfirmedImport = await fetch(`${base}/api/shop/data-transfer/import`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: archive,
    });
    assert.equal(unconfirmedImport.status, 400);
    const unconfirmedReview = await fetch(`${base}/api/shop/data-transfer/review`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(unconfirmedReview.status, 400);
    const crossOrigin = await fetch(`${base}/api/shop/data-transfer/export`, {
      method: "POST", headers: { Cookie: cookie, Origin: "https://example.invalid" },
    });
    assert.equal(crossOrigin.status, 403);
    console.log("PASS: signed-out protection, authenticated ZIP download and generated-client upload, all 13 datasets, invalid ZIP rejection, explicit import/review confirmation and cross-origin protection. No shop data imported or changed.");
  } finally {
    await fetch(`${base}/api/admin/logout`, { method: "POST", headers });
  }
}
main().catch(() => { console.error("HTTP verification failed. Credentials and private response bodies were not logged."); process.exitCode = 1; });
