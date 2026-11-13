import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db, shopProducts, shopInventory, shopPayments } from "@workspace/db";
import { ListProductGroupsResponse, type ProductGroupInput } from "@workspace/api-zod";
import { productsForOwner, recordActivity } from "./shop-store";
import { CommerceError } from "./commerce-providers";
import { isProductEmoji } from "./product-emoji";
import { assertOwnedCustomEmoji } from "./custom-emoji-library";
import { validProductMediaUrl, PRODUCT_MEDIA_ERROR } from "./product-media";
import { announceProductAvailability } from "./product-announcements";
import { logger } from "./logger";

export async function productGroupsForOwner(ownerId: string | null) {
  if (!ownerId) return [];
  const products = await productsForOwner(ownerId);
  const groups = new Map<string, typeof products>();
  for (const product of products) if (product.groupId) {
    const options = groups.get(product.groupId) ?? [];
    options.push(product);
    groups.set(product.groupId, options);
  }
  return ListProductGroupsResponse.parse([...groups].map(([id, options]) => {
    options.sort((a, b) => a.id - b.id);
    const first = options[0]!;
    return {
      id, name: first.groupName, description: first.groupDescription ?? "",
      imageUrl: first.imageUrl ?? null, buttonEmoji: first.buttonEmoji ?? "🛍",
      buttonCustomEmojiId: first.buttonCustomEmojiId ?? null, options,
    };
  }));
}

export async function saveProductGroup(ownerId: string, input: ProductGroupInput, existingGroupId?: string) {
  const name = input.name.trim();
  const options = input.options.map(option => ({ ...option, name: option.name.trim() }));
  if (!name || options.some(option => !option.name)) throw new CommerceError("Enter a product name and a name for every option.");
  if (new Set(options.map(option => option.name.toLowerCase())).size !== options.length) {
    throw new CommerceError("Each option needs a different name.");
  }
  const ids = options.flatMap(option => option.id === undefined ? [] : [option.id]);
  if (new Set(ids).size !== ids.length) throw new CommerceError("The same option cannot appear twice.");
  if (input.buttonEmoji !== undefined && input.buttonEmoji !== "" && !isProductEmoji(input.buttonEmoji)) {
    throw new CommerceError("Choose one normal emoji or clear it.");
  }
  const imageUrl = input.imageUrl?.trim() || null;
  if (imageUrl && !validProductMediaUrl(imageUrl)) throw new CommerceError(PRODUCT_MEDIA_ERROR);
  await assertOwnedCustomEmoji(ownerId, input.buttonCustomEmojiId);
  const groupId = existingGroupId ?? randomUUID();
  const activated = await db.transaction(async tx => {
    const members = existingGroupId
      ? await tx.select().from(shopProducts).where(and(eq(shopProducts.ownerId, ownerId), eq(shopProducts.groupId, groupId)))
        .orderBy(asc(shopProducts.id))
      : [];
    if (existingGroupId && !members.length) throw new CommerceError("Product group not found.", 404);
    if (members.some(member => !ids.includes(member.id))) {
      throw new CommerceError("Keep all saved options in this editor. Archive unwanted options instead of dropping their stock.", 409);
    }
    const owned = ids.length ? await tx.select().from(shopProducts)
      .where(and(eq(shopProducts.ownerId, ownerId), inArray(shopProducts.id, ids)))
      .orderBy(asc(shopProducts.id)) : [];
    if (owned.length !== ids.length) throw new CommerceError("An option was not found in your shop.", 404);
    if (owned.some(option => option.groupId && option.groupId !== groupId)) {
      throw new CommerceError("An option already belongs to another product. Edit that product instead.", 409);
    }
    const previous = members[0] ?? owned[0];
    const shared = {
      groupId, groupName: name, groupDescription: input.description,
      imageUrl: input.imageUrl === undefined ? previous?.imageUrl ?? null : imageUrl,
      buttonEmoji: input.buttonEmoji ?? previous?.buttonEmoji ?? "🛍",
      buttonCustomEmojiId: input.buttonCustomEmojiId === undefined ? previous?.buttonCustomEmojiId ?? null : input.buttonCustomEmojiId,
    };
    const activated: number[] = [];
    for (const option of options) {
      const values = {
        ...shared, optionName: option.name, name: `${name} — ${option.name}`,
        description: option.description, priceCents: Math.round(option.price * 100),
        status: option.status, deliveryFormat: option.deliveryFormat,
      };
      if (option.id === undefined) await tx.insert(shopProducts).values({ ...values, ownerId, category: "" });
      else {
        await tx.update(shopProducts).set(values).where(and(eq(shopProducts.id, option.id), eq(shopProducts.ownerId, ownerId)));
        if (option.status === "active" && owned.find(row => row.id === option.id)?.status !== "active") activated.push(option.id);
      }
    }
    return activated;
  });
  await recordActivity(ownerId, existingGroupId ? "Product options updated" : "Product with options created", name, "product");
  for (const productId of activated) void announceProductAvailability(ownerId, productId, 0).catch(error => {
    logger.error({ ownerId, productId, errorType: error instanceof Error ? error.name : "Error" }, "Could not announce activated product option.");
  });
  return (await productGroupsForOwner(ownerId)).find(group => group.id === groupId)!;
}

export async function deleteProductGroup(ownerId: string, groupId: string) {
  const count = await db.transaction(async tx => {
    const members = await tx.select({ id: shopProducts.id }).from(shopProducts)
      .where(and(eq(shopProducts.ownerId, ownerId), eq(shopProducts.groupId, groupId)))
      .orderBy(asc(shopProducts.id));
    if (!members.length) throw new CommerceError("Product group not found.", 404);
    const ids = members.map(member => member.id);
    const [order] = await tx.select({ id: shopPayments.id }).from(shopPayments)
      .where(and(eq(shopPayments.ownerId, ownerId), inArray(shopPayments.productId, ids))).limit(1);
    const [used] = await tx.select({ id: shopInventory.id }).from(shopInventory)
      .where(and(eq(shopInventory.ownerId, ownerId), inArray(shopInventory.productId, ids), ne(shopInventory.status, "available"))).limit(1);
    if (order || used) throw new CommerceError("This product has order history or reserved/delivered stock. Archive its options instead.", 409);
    await tx.delete(shopProducts).where(and(eq(shopProducts.ownerId, ownerId), eq(shopProducts.groupId, groupId)));
    return ids.length;
  });
  await recordActivity(ownerId, "Product with options deleted", `${count} options removed`, "product");
}
