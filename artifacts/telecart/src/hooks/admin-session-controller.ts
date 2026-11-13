import type { AdminCredentials, AdminSession } from "@workspace/api-client-react";

export type AdminSessionState = {
  session: AdminSession | null;
  loaded: boolean;
  error: string | null;
  connectionWarning: string | null;
};
type SessionApi = {
  check: (options: { signal: AbortSignal }) => Promise<AdminSession>;
  login: (credentials: AdminCredentials) => Promise<AdminSession>;
  logout: () => Promise<unknown>;
};
const signedOut: AdminSession = { signedIn: false, ownerId: null, email: null };
const rejected = (error: unknown) => [401, 403].includes((error as { status?: number })?.status ?? 0);

/** A failed connection is not a confirmed identity change. */
export class AdminSessionController {
  private state: AdminSessionState = { session: null, loaded: false, error: null, connectionWarning: null };
  private listeners = new Set<() => void>();
  private checking: AbortController | null = null;
  private mutation = 0;
  private mutating = false;
  constructor(private api: SessionApi) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: AdminSessionState) {
    const old = this.state;
    if (old.loaded === next.loaded && old.error === next.error && old.connectionWarning === next.connectionWarning &&
      old.session?.signedIn === next.session?.signedIn && old.session?.ownerId === next.session?.ownerId &&
      old.session?.email === next.session?.email) return;
    this.state = next;
    this.listeners.forEach(listener => listener());
  }
  cancelCheck = () => { this.checking?.abort(); this.checking = null; };
  refresh = async () => {
    if (this.checking || this.mutating) return;
    const request = new AbortController();
    this.checking = request;
    const timeout = setTimeout(() => request.abort(), 10000);
    try {
      const session = await this.api.check({ signal: request.signal });
      if (this.checking === request) this.publish({ session, loaded: true, error: null, connectionWarning: null });
    } catch (error) {
      if (this.checking !== request) return;
      if (rejected(error)) this.publish({ session: signedOut, loaded: true, error: null, connectionWarning: null });
      else if (this.state.session?.signedIn) this.publish({
        ...this.state, connectionWarning: "Connection interrupted. Keeping your last verified screen while reconnecting. Server sign-in checks still protect every action.",
      });
      else this.publish({ session: null, loaded: true, error: "Unable to check your admin session. Reconnecting automatically.", connectionWarning: null });
    } finally {
      clearTimeout(timeout);
      if (this.checking === request) this.checking = null;
    }
  };
  signIn = async (credentials: AdminCredentials) => {
    this.cancelCheck();
    const operation = ++this.mutation;
    this.mutating = true;
    try {
      const session = await this.api.login(credentials);
      if (operation === this.mutation) this.publish({ session, loaded: true, error: null, connectionWarning: null });
    } finally { if (operation === this.mutation) this.mutating = false; }
  };
  signOut = async () => {
    this.cancelCheck();
    const operation = ++this.mutation;
    this.mutating = true;
    try {
      try { await this.api.logout(); } catch (error) { if (!rejected(error)) throw error; }
      if (operation === this.mutation) this.publish({ session: signedOut, loaded: true, error: null, connectionWarning: null });
    } finally { if (operation === this.mutation) this.mutating = false; }
  };
}
