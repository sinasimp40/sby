import { Router, type IRouter } from "express";
import {
  AddCustomerWalletCreditParams, AddCustomerWalletCreditBody, AddCustomerWalletCreditResponse,
  ListCustomerWalletCreditsParams, ListCustomerWalletCreditsQueryParams, ListCustomerWalletCreditsResponse,
} from "@workspace/api-zod";
import { getShopAuth } from "../lib/admin-auth";
import { CommerceError } from "../lib/commerce-providers";
import { addManualWalletCredit, manualWalletCreditHistory } from "../lib/manual-wallet-credit";

const router: IRouter = Router();
router.use("/customers/:id/credits", (req, res, next) => {
  if (!getShopAuth(req).userId) { res.status(401).json({ error: "Sign in to manage customer credit." }); return; }
  next();
});
router.get("/customers/:id/credits", async (req, res): Promise<void> => {
  const params = ListCustomerWalletCreditsParams.safeParse(req.params);
  const query = ListCustomerWalletCreditsQueryParams.safeParse(req.query);
  if (!params.success || !query.success) { res.status(400).json({ error: "Invalid customer or history reference." }); return; }
  try {
    res.json(ListCustomerWalletCreditsResponse.parse(await manualWalletCreditHistory(getShopAuth(req).userId!, params.data.id, query.data.cursor)));
  } catch (error) {
    if (!(error instanceof CommerceError)) throw error;
    res.status(error.status).json({ error: error.message });
  }
});
router.post("/customers/:id/credits", async (req, res): Promise<void> => {
  const params = AddCustomerWalletCreditParams.safeParse(req.params);
  const body = AddCustomerWalletCreditBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Enter a valid credit amount in cents, reason and retry reference." }); return; }
  try {
    res.json(AddCustomerWalletCreditResponse.parse(await addManualWalletCredit(getShopAuth(req).userId!, params.data.id, body.data)));
  } catch (error) {
    if (!(error instanceof CommerceError)) throw error;
    res.status(error.status).json({ error: error.message });
  }
});
export default router;
