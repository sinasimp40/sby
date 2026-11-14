import { Router, type IRouter } from "express";
import { getShopAuth as getAuth, requireSameOrigin } from "../lib/admin-auth";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, shopSettings, shopActivity } from "@workspace/db";
import {
  GetOverviewResponse, ListOrdersResponse, ListCustomersResponse, ListDepositsResponse,
  ListActivityResponse, SaveSettingsBody, SaveSettingsResponse,
  RevealOrderDeliveryParams, RevealOrderDeliveryResponse,
  parseMessageEmojis,
} from "@workspace/api-zod";
import { productsForOwner, recordsForOwner, settingsForOwner, recordActivity } from "../lib/shop-store";
import productRouter from "./shop-products";
import productGroupRouter from "./shop-product-groups";
import commerceRouter from "./shop-commerce";
import { revealDeliveredInventory } from "../lib/order-delivery";
import transferRouter from "./shop-transfer";
import emojiRouter from "./shop-emojis";
import advertisingRouter from "./shop-advertising";
import walletCreditRouter from "./shop-wallet-credit";
import { validateCoinButtonIcons } from "../lib/coin-button-icons";
import { validProductMediaUrl, PRODUCT_MEDIA_ERROR } from "../lib/product-media";
import { WELCOME_CAPTION_LIMIT } from "../lib/welcome-message";
import { validateMessageEmojis } from "../lib/custom-emoji-library";

const router: IRouter = Router();
const writes = new Map<string, { count: number; expires: number }>();

router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) { next(); return; }
  const ownerId = getAuth(req).userId;
  if (!ownerId) { res.status(401).json({ error: "Sign in to manage your private shop." }); return; }
  if (!requireSameOrigin(req)) { res.status(403).json({ error: "Cross-origin changes are not permitted." }); return; }
  const now = Date.now();
  if (writes.size > 10000) for (const [id, item] of writes) if (item.expires < now) writes.delete(id);
  const current = writes.get(ownerId);
  const entry = current && current.expires > now ? current : { count: 0, expires: now + 60000 };
  entry.count += 1;
  writes.set(ownerId, entry);
  if (entry.count > 60) { res.status(429).json({ error: "Too many changes. Wait a minute and try again." }); return; }
  next();
});

router.use(productRouter);
router.use(productGroupRouter);
router.use(commerceRouter);
router.use(transferRouter);
router.use(emojiRouter);
router.use(advertisingRouter);
router.use(walletCreditRouter);

router.get("/overview", async (req, res): Promise<void> => {
  const ownerId = getAuth(req).userId;
  const [products, settings, rawOrders, rawCustomers] = await Promise.all([
    productsForOwner(ownerId), settingsForOwner(ownerId),
    recordsForOwner(ownerId, "order"), recordsForOwner(ownerId, "customer"),
  ]);
  const orders = ListOrdersResponse.parse(rawOrders);
  const customers = ListCustomersResponse.parse(rawCustomers);
  const revenue = orders.filter((order) => ["paid", "delivered"].includes(order.status))
    .reduce((total, order) => total + Math.round(order.amount * 100), 0) / 100;
  res.json(GetOverviewResponse.parse({
    isDemo: !ownerId, revenue, orderCount: orders.length, customerCount: customers.length,
    walletBalance: customers.reduce((total, customer) => total + Math.round(customer.walletBalance * 100), 0) / 100,
    productCount: new Set(products.map(product => product.groupId ?? `single:${product.id}`)).size,
    stockCount: products.reduce((total, product) => total + product.stock, 0),
    pendingPayments: orders.filter((order) => order.status === "pending").length,
    botConnected: settings.botConnected, paymentsConnected: settings.paymentsConnected,
    recentOrders: orders.slice(0, 5), topProducts: products.slice(0, 4),
    checklist: [
      { label: "Add your first product", complete: Boolean(ownerId && products.length), href: "/products" },
      { label: "Customize your bot", complete: Boolean(ownerId && settings.botUsername), href: "/bot" },
      { label: "Add product inventory", complete: products.some((product) => product.stock > 0), href: "/inventory" },
      { label: "Connect Telegram", complete: settings.botConnected, href: "/bot" },
      { label: "Set up NOWPayments", complete: settings.paymentsConnected, href: "/payments" },
    ],
  }));
});

router.get("/settings", async (req, res): Promise<void> => {
  res.json(await settingsForOwner(getAuth(req).userId));
});

router.put("/settings", async (req, res): Promise<void> => {
  const body = SaveSettingsBody.safeParse(req.body);
  if (!body.success || !body.data.shopName.trim() || !body.data.welcomeMessage.trim()) {
    res.status(400).json({ error: "Check the shop name, welcome message, payment preferences and menu labels." }); return;
  }
  const labels = [body.data.productsLabel, body.data.supportLabel, body.data.walletLabel, body.data.ordersLabel].map((label) => label.trim());
  if (labels.some((label) => !label) || new Set(labels).size !== labels.length) {
    res.status(400).json({ error: "Menu labels must be non-empty and different from one another." }); return;
  }
  if (new Set(body.data.acceptedCoins).size !== body.data.acceptedCoins.length) {
    res.status(400).json({ error: "Choose each payment currency only once." }); return;
  }
  const ownerId = getAuth(req).userId!;
  const previous = await settingsForOwner(ownerId);
  const welcomeImageUrl = body.data.welcomeImageUrl === undefined
    ? previous.welcomeImageUrl ?? null : body.data.welcomeImageUrl?.trim() || null;
  if (welcomeImageUrl && !validProductMediaUrl(welcomeImageUrl)) {
    res.status(400).json({ error: PRODUCT_MEDIA_ERROR }); return;
  }
  if (welcomeImageUrl && parseMessageEmojis(body.data.welcomeMessage).text.length > WELCOME_CAPTION_LIMIT) {
    res.status(400).json({ error: "Shorten the welcome message to 1,024 characters when using an image. The image and text must fit in one Telegram message." }); return;
  }
  const coinButtonIcons = body.data.coinButtonIcons ?? previous.coinButtonIcons ?? {};
  const preferences = { ...body.data, welcomeImageUrl, coinButtonIcons, shopName: body.data.shopName.trim() };
  await db.transaction(async tx => {
    // SQLite BEGIN IMMEDIATE serializes owner updates.
    await validateCoinButtonIcons(ownerId, coinButtonIcons, tx);
    await validateMessageEmojis(ownerId, [body.data.welcomeMessage, body.data.supportMessage], tx);
    await tx.insert(shopSettings).values({ ownerId, preferences }).onConflictDoUpdate({
      target: shopSettings.ownerId, set: { preferences, updatedAt: new Date() },
    });
  });
  await recordActivity(ownerId, "Shop settings saved", "Bot copy and payment preferences updated.", "settings");
  res.json(SaveSettingsResponse.parse(await settingsForOwner(ownerId)));
});

router.get("/orders", async (req, res): Promise<void> => {
  res.json(ListOrdersResponse.parse(await recordsForOwner(getAuth(req).userId, "order")));
});
router.post("/orders/:id/delivery", async (req, res): Promise<void> => {
  const params = RevealOrderDeliveryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid order reference." }); return; }
  const delivery = await revealDeliveredInventory(getAuth(req).userId, params.data.id);
  res.json(RevealOrderDeliveryResponse.parse(delivery));
});
router.get("/customers", async (req, res): Promise<void> => {
  res.json(ListCustomersResponse.parse(await recordsForOwner(getAuth(req).userId, "customer")));
});
router.get("/deposits", async (req, res): Promise<void> => {
  res.json(ListDepositsResponse.parse(await recordsForOwner(getAuth(req).userId, "deposit")));
});
router.get("/activity", async (req, res): Promise<void> => {
  const ownerId = getAuth(req).userId;
  if (!ownerId) { res.json([]); return; }
  const rows = await db.select({
    id: shopActivity.id, title: shopActivity.title, description: shopActivity.description,
    type: shopActivity.type, createdAt: shopActivity.createdAt,
  }).from(shopActivity).where(and(eq(shopActivity.ownerId, ownerId))).orderBy(desc(shopActivity.createdAt)).limit(20);
  res.json(ListActivityResponse.parse(rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))));
});

export default router;
