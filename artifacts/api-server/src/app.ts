import express, { type Express, type ErrorRequestHandler } from "express";
import cors from "cors";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import { CommerceError } from "./lib/commerce-providers";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(cors({ credentials: true, origin: false }));
app.use(express.json({ limit: "150kb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Do not log errors with request bodies or credentials.
  req.log.error({ errorType: err?.name ?? "Error" }, "Request failed");
  const malformed = err?.type === "entity.parse.failed";
  res.status(err instanceof CommerceError ? err.status : err?.code === "23503" ? 409 : err?.type === "entity.too.large" ? 413 : malformed ? 400 : 500).json({
    error: err instanceof CommerceError ? err.message : err?.code === "23503" ? "This item is linked to payment history or reserved stock. Archive the product instead of deleting it." : err?.type === "entity.too.large" ? "Request is too large" : malformed ? "Invalid JSON request" : "Unable to complete this request. Please try again.",
  });
};
app.use(errorHandler);

export default app;
