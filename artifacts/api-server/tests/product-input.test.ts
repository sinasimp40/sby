import test from "node:test";
import assert from "node:assert/strict";
import { CreateProductBody, UpdateProductBody } from "@workspace/api-zod";

const product = {
  name: "Music account",
  description: "One month access",
  price: 12,
  status: "draft",
  deliveryFormat: "email:pass",
};

test("creating and editing a product do not require a category", () => {
  for (const schema of [CreateProductBody, UpdateProductBody]) {
    const result = schema.safeParse(product);
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.category, undefined);
  }
});

test("legacy category values remain compatible without making them mandatory", () => {
  assert.equal(CreateProductBody.safeParse({ ...product, category: "" }).success, true);
  assert.equal(UpdateProductBody.safeParse({ ...product, category: "Music" }).success, true);
  assert.equal(CreateProductBody.safeParse({ ...product, name: "" }).success, false);
});
