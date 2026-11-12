import type { AccountFactory } from "./advertising-account-driver";
import { connectedAccountSession, closeAccountSession, loginConnectionKey } from "./advertising-account-session";

type PendingLogin = { id: string; expires: number; apiId: number; apiHash: string; session: string };

// Both QR and phone/two-step authorization keep their original connected client.
// Promotion changes the cache identity, not the TCP connection or its lease.
export const connectedLoginDriver = (owner: string, pending: PendingLogin, factory: AccountFactory) =>
  connectedAccountSession(owner, loginConnectionKey(pending.id), pending, factory, { expires: pending.expires, allowRestore: false });
export const connectedQrDriver = connectedLoginDriver;
export const closeQrDriver = (owner: string, id?: string) => closeAccountSession(owner, id ? loginConnectionKey(id) : undefined);
