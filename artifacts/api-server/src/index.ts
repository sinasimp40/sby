import app from "./app";
import { logger } from "./lib/logger";
import { initializeAdminBootstrap } from "./lib/admin-bootstrap";
import { runWorkspacePolling } from "./lib/workspace-polling";
import { runPaymentReconciliation } from "./lib/payment-reconciliation";
import { runAccountAdvertisingWorker } from "./lib/advertising-account-schedules";
import { initializeAccountAdvertising } from "./lib/advertising-account-auth";
import { configuredOwnerId } from "./lib/admin-bootstrap";
import { shutdownAccountSessions } from "./lib/advertising-account-session";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Resolve privileged identities in the environment where the server runs.
// Production Clerk credentials never need to be copied into the workspace.
try {
  await initializeAdminBootstrap();
  const owner = configuredOwnerId();
  if (owner) await initializeAccountAdvertising(owner);
} catch {
  logger.error("Admin bootstrap failed. No existing user was granted access or had its password changed. Check the configured admin email, binding and Clerk requirements.");
  process.exit(1);
}

const server = app.listen(port, process.env.TELECART_LOCAL_ONLY === "true" ? "127.0.0.1" : "0.0.0.0", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void runWorkspacePolling().catch(() => logger.error("Workspace Telegram poller stopped."));
  void runPaymentReconciliation().catch(() => logger.error("Payment reconciliation stopped."));
  void runAccountAdvertisingWorker().catch(() => logger.error("Account advertising sender stopped."));
});
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  const deadline = setTimeout(() => process.exit(1), 8000);
  deadline.unref();
  void shutdownAccountSessions().finally(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
