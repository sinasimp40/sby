// Explicit, development-only sample data insertion. Never runs on app startup.
import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pool, shopProducts, shopInventory, shopActivity } from "@workspace/db";
import { encryptCredential, decryptCredential, credentialFingerprint } from "../src/lib/inventory-encryption";

async function main() {
  assert.equal(process.argv.includes("--confirm-sample-data"), true, "Explicit confirmation required.");
  assert.notEqual(process.env.NODE_ENV, "production", "Development only.");
  const domain = process.env.REPLIT_DEV_DOMAIN;
  const origin = process.env.TELECART_ADMIN_ORIGIN || process.env.TELECART_PUBLIC_URL;
  assert.ok(domain && origin && process.env.TELECART_ADMIN_EMAIL && process.env.TELECART_ADMIN_INITIAL_PASSWORD);
  const base = `https://${domain}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.TELECART_ADMIN_EMAIL, password: process.env.TELECART_ADMIN_INITIAL_PASSWORD }),
  });
  assert.equal(login.status, 200, "Admin authentication required.");
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const headers = { Origin: origin, Cookie: cookie };
  try {
    const session = await fetch(`${base}/api/admin/session`, { headers });
    assert.equal(session.status, 200);
    const identity = await session.json() as { signedIn: boolean; ownerId: string };
    assert.ok(identity.signedIn && identity.ownerId);
    const ownerId = identity.ownerId;
    const categories = [
      ["Design", "Icon Library", "Social Media Kit", "Presentation Pack", "UI Wireframes", "Branding Toolkit"],
      ["Productivity", "Daily Planner", "Project Tracker", "Budget Workbook", "Habit Journal", "Meeting Templates"],
      ["Learning", "Language Flashcards", "Coding Exercises", "Study Planner", "Math Practice", "Writing Prompts"],
      ["Creative", "Photo Presets", "Illustration Pack", "Video Overlays", "Music Loops", "Font Collection"],
      ["Business", "Invoice Templates", "Marketing Planner", "Proposal Kit", "Store Checklist", "Content Calendar"],
      ["Developer", "Starter Templates", "API Practice Kit", "Dashboard Widgets", "CSS Components", "Testing Exercises"],
    ];
    const prices = [100, 250, 500, 750, 1000];
    const result = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sample-catalog:${ownerId}`}))`);
      const products = [];
      let addedProducts = 0;
      let addedStock = 0;
      for (const [category, ...names] of categories) {
        for (const [index, title] of names.entries()) {
          const name = `Sample · ${title}`;
          const description = "DEMO ONLY — fictional sample product and sample credentials. No real service or access is provided. Replace all sample inventory before activating.";
          const [existing] = await tx.select().from(shopProducts)
            .where(and(eq(shopProducts.ownerId, ownerId), eq(shopProducts.name, name)));
          if (existing) {
            assert.equal(existing.description, description, "Existing non-sample product must not be changed.");
            products.push(existing);
            continue;
          }
          const [product] = await tx.insert(shopProducts).values({
            ownerId, name, description, category, priceCents: prices[index],
            status: "draft", deliveryFormat: "email:pass",
          }).returning();
          assert.ok(product);
          const entries = Array.from({ length: 5 }, (_, unit) =>
            `sample-${product.id}-${unit + 1}@example.invalid:DEMO-ONLY-NO-REAL-ACCESS-${unit + 1}`);
          await tx.insert(shopInventory).values(entries.map(value => ({
            ownerId, productId: product.id, status: "available" as const,
            encryptedCredential: encryptCredential(value, ownerId, product.id),
            fingerprint: credentialFingerprint(value, ownerId, product.id),
          })));
          const stock = await tx.select().from(shopInventory)
            .where(and(eq(shopInventory.ownerId, ownerId), eq(shopInventory.productId, product.id)));
          assert.equal(stock.length, 5);
          assert.ok(stock.every(row => row.status === "available"));
          assert.deepEqual(stock.map(row => decryptCredential(row.encryptedCredential, ownerId, product.id)).sort(), entries.sort());
          products.push(product);
          addedProducts++;
          addedStock += stock.length;
        }
      }
      assert.equal(products.length, 30);
      if (addedProducts) await tx.insert(shopActivity).values({
        ownerId, title: "Sample catalog added",
        description: `${addedProducts} draft sample products and ${addedStock} fictional stock items added. Existing products and balances were not changed.`,
        type: "product",
      });
      return { addedProducts, addedStock, ids: products.map(product => product.id) };
    });
    const catalogResponse = await fetch(`${base}/api/shop/products`, { headers });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json() as { id: number }[];
    assert.ok(result.ids.every(id => catalog.some(product => product.id === id)));
    const stock = await db.select({ count: sql<number>`count(*)::int` }).from(shopInventory)
      .where(and(eq(shopInventory.ownerId, ownerId), inArray(shopInventory.productId, result.ids)));
    console.log(JSON.stringify({
      addedProducts: result.addedProducts, addedStock: result.addedStock,
      verifiedSampleProducts: result.ids.length, verifiedSampleStock: stock[0].count,
      dashboardVerified: true, existingProductsAndBalancesUnchanged: true,
    }));
  } finally {
    await fetch(`${base}/api/admin/logout`, { method: "POST", headers });
  }
}
main().catch(() => {
  console.error("Sample catalog insertion or verification failed. Private response bodies were not logged.");
  process.exitCode = 1;
}).finally(() => pool.end());
