import { Router, type IRouter } from "express";
import {
  CreateProductGroupBody, CreateProductGroupResponse, UpdateProductGroupBody,
  UpdateProductGroupParams, UpdateProductGroupResponse, DeleteProductGroupParams,
} from "@workspace/api-zod";
import { getShopAuth } from "../lib/admin-auth";
import { productGroupsForOwner, saveProductGroup, deleteProductGroup } from "../lib/product-groups";

const router: IRouter = Router();
router.get("/product-groups", async (req, res): Promise<void> => {
  res.json(await productGroupsForOwner(getShopAuth(req).userId));
});
router.post("/product-groups", async (req, res): Promise<void> => {
  const input = CreateProductGroupBody.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Enter a product name and 1–20 valid options, each with a price and delivery format." }); return; }
  const group = await saveProductGroup(getShopAuth(req).userId!, input.data);
  res.status(201).json(CreateProductGroupResponse.parse(group));
});
router.patch("/product-groups/:id", async (req, res): Promise<void> => {
  const params = UpdateProductGroupParams.safeParse(req.params), input = UpdateProductGroupBody.safeParse(req.body);
  if (!params.success || !input.success) { res.status(400).json({ error: "Invalid product options." }); return; }
  const group = await saveProductGroup(getShopAuth(req).userId!, input.data, params.data.id);
  res.json(UpdateProductGroupResponse.parse(group));
});
router.delete("/product-groups/:id", async (req, res): Promise<void> => {
  const params = DeleteProductGroupParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid product group." }); return; }
  await deleteProductGroup(getShopAuth(req).userId!, params.data.id);
  res.sendStatus(204);
});
export default router;
