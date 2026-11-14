import { Router, type IRouter } from "express";
import { getShopAuth } from "../lib/admin-auth";
import { GetCustomerPromotionsResponse, SaveCustomerPromotionsBody, SetPromotedProductsBody } from "@workspace/api-zod";
import { customerPromotionStatus, saveCustomerPromotionSettings, setPromotedProductFlags } from "../lib/customer-promotions-store";
import { CommerceError } from "../lib/commerce-providers";
const router: IRouter = Router();
router.use("/customer-promotions", (req, res, next) => {
  if (!getShopAuth(req).userId) { res.status(401).json({ error: "Sign in as the shop owner." }); return; } next();
});
router.get("/customer-promotions", async (req, res): Promise<void> => {
  res.json(GetCustomerPromotionsResponse.parse(await customerPromotionStatus(getShopAuth(req).userId!)));
});
router.put("/customer-promotions", async (req, res): Promise<void> => {
  const input = SaveCustomerPromotionsBody.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Enter an enabled state and interval from 1 to 43,200 whole minutes." }); return; }
  await saveCustomerPromotionSettings(getShopAuth(req).userId!, input.data);
  res.json(GetCustomerPromotionsResponse.parse(await customerPromotionStatus(getShopAuth(req).userId!)));
});
router.post("/customer-promotions/products", async (req, res): Promise<void> => {
  const input = SetPromotedProductsBody.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Select valid product or option IDs and an enabled state." }); return; }
  try {
    await setPromotedProductFlags(getShopAuth(req).userId!, input.data);
    res.json(GetCustomerPromotionsResponse.parse(await customerPromotionStatus(getShopAuth(req).userId!)));
  } catch (error) { if (error instanceof CommerceError) res.status(error.status).json({ error: error.message }); else throw error; }
});
export default router;
