import { Router, type IRouter } from "express";
import healthRouter from "./health";
import shopRouter from "./shop";
import commerceWebhooks from "./commerce-webhooks";
import adminAuthRouter from "./admin-auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(adminAuthRouter);
router.use(commerceWebhooks);
router.use("/shop", shopRouter);

export default router;
