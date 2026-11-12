import { Router, type IRouter } from "express";
import { getShopAuth as getAuth } from "../lib/admin-auth";
import { and, eq } from "drizzle-orm";
import { db, shopProducts, shopInventory, shopActivity } from "@workspace/db";
import {
  CreateProductBody, CreateProductResponse, UpdateProductBody, UpdateProductParams,
  UpdateProductResponse, DeleteProductParams, ImportInventoryBody, ImportInventoryParams,
  ImportInventoryResponse, ListInventoryParams, ListInventoryResponse, DeleteInventoryItemParams,
} from "@workspace/api-zod";
import { productsForOwner, ownedProduct, recordActivity } from "../lib/shop-store";
import { encryptCredential, credentialFingerprint } from "../lib/inventory-encryption";
import { isProductEmoji } from "../lib/product-emoji";

const router: IRouter = Router();

router.get("/products", async (req, res): Promise<void> => {
  res.json(await productsForOwner(getAuth(req).userId));
});

router.post("/products", async (req, res): Promise<void> => {
  const parsed = CreateProductBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.name.trim() || !parsed.data.category.trim()) {
    res.status(400).json({ error: "Enter a product name, category, valid price and delivery format." });
    return;
  }
  const ownerId = getAuth(req).userId!;
  const { price, ...input } = parsed.data;
  if (input.buttonEmoji !== undefined && !isProductEmoji(input.buttonEmoji)) {
    res.status(400).json({ error: "Choose or paste one ordinary emoji for the product button." }); return;
  }
  const [product] = await db.insert(shopProducts).values({
    ...input, name: input.name.trim(), category: input.category.trim(), priceCents: Math.round(price * 100), ownerId,
  }).returning();
  await recordActivity(ownerId, "Product created", input.name.trim(), "product");
  const rows = await productsForOwner(ownerId);
  res.status(201).json(CreateProductResponse.parse(rows.find((row) => row.id === product!.id)));
});

router.patch("/products/:id", async (req, res): Promise<void> => {
  const params = UpdateProductParams.safeParse(req.params);
  const body = UpdateProductBody.safeParse(req.body);
  if (!params.success || !body.success || !body.data.name.trim() || !body.data.category.trim()) {
    res.status(400).json({ error: "Invalid product details." });
    return;
  }
  const ownerId = getAuth(req).userId!;
  const { price, ...input } = body.data;
  if (input.buttonEmoji !== undefined && !isProductEmoji(input.buttonEmoji)) {
    res.status(400).json({ error: "Choose or paste one ordinary emoji for the product button." }); return;
  }
  const [product] = await db.update(shopProducts).set({
    ...input, name: input.name.trim(), category: input.category.trim(), priceCents: Math.round(price * 100),
  }).where(and(eq(shopProducts.ownerId, ownerId), eq(shopProducts.id, params.data.id))).returning();
  if (!product) { res.status(404).json({ error: "Product not found." }); return; }
  await recordActivity(ownerId, "Product updated", input.name.trim(), "product");
  const rows = await productsForOwner(ownerId);
  res.json(UpdateProductResponse.parse(rows.find((row) => row.id === product.id)));
});

router.delete("/products/:id", async (req, res): Promise<void> => {
  const params = DeleteProductParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid product." }); return; }
  const ownerId = getAuth(req).userId!;
  const [product] = await db.delete(shopProducts).where(and(
    eq(shopProducts.id, params.data.id), eq(shopProducts.ownerId, ownerId),
  )).returning();
  if (!product) { res.status(404).json({ error: "Product not found." }); return; }
  await recordActivity(ownerId, "Product deleted", product.name, "product");
  res.sendStatus(204);
});

router.get("/products/:id/inventory", async (req, res): Promise<void> => {
  const ownerId = getAuth(req).userId;
  if (!ownerId) { res.json([]); return; }
  const params = ListInventoryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid product." }); return; }
  if (!await ownedProduct(ownerId, params.data.id)) { res.status(404).json({ error: "Product not found." }); return; }
  const rows = await db.select({
    id: shopInventory.id, productId: shopInventory.productId, status: shopInventory.status, createdAt: shopInventory.createdAt,
  }).from(shopInventory).where(and(eq(shopInventory.ownerId, ownerId), eq(shopInventory.productId, params.data.id)));
  res.json(ListInventoryResponse.parse(rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))));
});

router.post("/products/:id/inventory", async (req, res): Promise<void> => {
  const params = ImportInventoryParams.safeParse(req.params);
  const body = ImportInventoryBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Choose a product and enter login:password lines." }); return; }
  const ownerId = getAuth(req).userId!;
  if (!await ownedProduct(ownerId, params.data.id)) { res.status(404).json({ error: "Product not found." }); return; }
  const lines = body.data.entries.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 500) {
    res.status(400).json({ error: "Import between 1 and 500 accounts at a time." }); return;
  }
  const invalidIndex = lines.findIndex((line) => line.indexOf(":") <= 0 || line.indexOf(":") === line.length - 1);
  if (invalidIndex !== -1) {
    res.status(400).json({ error: `Line ${invalidIndex + 1} must contain a login and password separated by a colon.` }); return;
  }
  if (!process.env.SESSION_SECRET) {
    res.status(503).json({ error: "Secure inventory storage needs configuration before accounts can be imported." }); return;
  }
  const productId = params.data.id;
  const rows = [...new Set(lines)].map((line) => ({
    productId, ownerId, encryptedCredential: encryptCredential(line, ownerId, productId),
    fingerprint: credentialFingerprint(line, ownerId, productId),
  }));
  const result = await db.transaction(async (tx) => {
    const inserted = await tx.insert(shopInventory).values(rows).onConflictDoNothing().returning({ id: shopInventory.id });
    await tx.insert(shopActivity).values({
      ownerId, title: "Inventory imported", description: `${inserted.length} accounts securely added`, type: "inventory",
    });
    return inserted.length;
  });
  res.status(201).json(ImportInventoryResponse.parse({ imported: result, skipped: lines.length - result }));
});

router.delete("/inventory/:id", async (req, res): Promise<void> => {
  const params = DeleteInventoryItemParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid inventory item." }); return; }
  const ownerId = getAuth(req).userId!;
  const [row] = await db.delete(shopInventory).where(and(
    eq(shopInventory.id, params.data.id), eq(shopInventory.ownerId, ownerId), eq(shopInventory.status, "available"),
  )).returning({ id: shopInventory.id });
  if (!row) { res.status(404).json({ error: "Available inventory item not found." }); return; }
  await recordActivity(ownerId, "Inventory item removed", "An undelivered account was removed from stock", "inventory");
  res.sendStatus(204);
});

export default router;
