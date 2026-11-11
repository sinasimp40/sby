import app from "./app";
import { logger } from "./lib/logger";
import { initializeAdminBootstrap } from "./lib/admin-bootstrap";
import { runWorkspacePolling } from "./lib/workspace-polling";

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
} catch {
  logger.error("Admin bootstrap failed. No existing user was granted access or had its password changed. Check the configured admin email, binding and Clerk requirements.");
  process.exit(1);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void runWorkspacePolling().catch(() => logger.error("Workspace Telegram poller stopped."));
});
