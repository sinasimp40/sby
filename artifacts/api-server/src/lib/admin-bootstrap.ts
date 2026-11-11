import { createHmac, timingSafeEqual } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { logger } from "./logger";

interface BootstrapUser {
  id: string;
  publicMetadata: Record<string, unknown>;
  privateMetadata: Record<string, unknown>;
}
interface BootstrapUsers {
  find(email: string): Promise<BootstrapUser[]>;
  create(input: {
    emailAddress: string[];
    password: string;
    publicMetadata: Record<string, unknown>;
    privateMetadata: Record<string, unknown>;
  }): Promise<BootstrapUser>;
}
export interface BootstrapConfig {
  email?: string;
  password?: string;
  signingSecret?: string;
  environment: string;
}
let bootstrapOwnerId: string | null = null;

export function configuredOwnerId(): string | null {
  return process.env.TELECART_OWNER_ID || bootstrapOwnerId;
}

function matches(a: unknown, b: string) {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Trusted deployment configuration only. Never call with browser-provided identifiers.
// The password is used once to create the identity, never persisted or logged by the app.
export async function seedConfiguredAdmin(config: BootstrapConfig, users: BootstrapUsers): Promise<string | null> {
  const email = config.email?.trim().toLowerCase();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Admin bootstrap email is invalid.");
  if (!config.signingSecret) throw new Error("Admin bootstrap requires SESSION_SECRET.");
  const proof = createHmac("sha256", config.signingSecret).update(`telecart-admin-bootstrap-v1:${config.environment}:${email}`).digest("hex");
  const acceptExisting = (user: BootstrapUser): string | null => {
    // Never reset/take over an existing account or grant it access by email alone.
    if (!matches(user.privateMetadata.telecartBootstrapProof, proof)) {
      throw new Error("The configured admin email already belongs to an unbound account. Sign in and bind its owner ID explicitly; no permissions or password were changed.");
    }
    // A revoked grant must remain revoked; startup is not a role reset.
    return user.publicMetadata.role === "admin" ? user.id : null;
  };
  const existing = await users.find(email);
  if (existing.length > 1) throw new Error("Admin bootstrap found ambiguous identities.");
  if (existing[0]) return acceptExisting(existing[0]);
  if (!config.password) return null;
  try {
    const user = await users.create({
      emailAddress: [email], password: config.password,
      publicMetadata: { role: "admin" },
      privateMetadata: { telecartBootstrapProof: proof },
    });
    return user.id;
  } catch {
    // Concurrent production instances can race. Only accept an identity with
    // our signed creation marker; never fall back to granting an arbitrary user.
    const raced = await users.find(email);
    if (raced.length === 1 && raced[0]) return acceptExisting(raced[0]);
    throw new Error("Could not create the configured admin. Check Clerk password requirements and required sign-up fields. No existing password was changed.");
  }
}

export async function initializeAdminBootstrap() {
  // A fresh self-hosted install may bind a trusted local owner without Clerk.
  // Never auto-map an existing cloud account or migrate any owner's records.
  if (!process.env.CLERK_SECRET_KEY) {
    if (!process.env.TELECART_OWNER_ID || !process.env.SESSION_SECRET ||
      !process.env.TELECART_ADMIN_EMAIL || !process.env.TELECART_ADMIN_INITIAL_PASSWORD) {
      throw new Error("Local setup requires an explicit owner ID, admin email/password and SESSION_SECRET.");
    }
    logger.info("Using the explicitly configured local admin identity.");
    return;
  }
  const email = process.env.TELECART_ADMIN_EMAIL;
  if (!email) return;
  const id = await seedConfiguredAdmin({
    email, password: process.env.TELECART_ADMIN_INITIAL_PASSWORD,
    signingSecret: process.env.SESSION_SECRET,
    environment: process.env.NODE_ENV === "production" ? "production" : "development",
  }, {
    find: async emailAddress => {
      const page = await clerkClient.users.getUserList({ emailAddress: [emailAddress], limit: 2 });
      return page.data.map(user => ({ id: user.id, publicMetadata: user.publicMetadata, privateMetadata: user.privateMetadata }));
    },
    create: async input => {
      const user = await clerkClient.users.createUser(input);
      return { id: user.id, publicMetadata: user.publicMetadata, privateMetadata: user.privateMetadata };
    },
  });
  if (id && process.env.TELECART_OWNER_ID && process.env.TELECART_OWNER_ID !== id) {
    throw new Error("Admin bootstrap conflicts with the configured bot owner. Resolve the binding before starting.");
  }
  bootstrapOwnerId = id;
  if (id) logger.info("Configured admin identity resolved and bound in this environment.");
  else logger.warn("Configured admin is awaiting a secure initial password or its grant has been revoked.");
}
