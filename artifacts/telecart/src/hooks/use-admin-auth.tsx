import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getAdminSession, loginAdmin, logoutAdmin, type AdminCredentials, type AdminSession } from "@workspace/api-client-react";

type AdminAuth = {
  user: { id: string; email: string } | null;
  isSignedIn: boolean;
  isLoaded: boolean;
  error: string | null;
  signIn: (credentials: AdminCredentials) => Promise<void>;
  signOut: () => Promise<void>;
};
const Context = createContext<AdminAuth | null>(null);
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setSession(await getAdminSession()); setError(null); }
    catch { setSession(null); setError("Unable to check your admin session. Reload to try again."); }
    finally { setLoaded(true); }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 60000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => { clearInterval(interval); window.removeEventListener("focus", focus); };
  }, [refresh]);
  const signIn = useCallback(async (credentials: AdminCredentials) => {
    setSession(await loginAdmin(credentials));
    setError(null);
  }, []);
  const signOut = useCallback(async () => {
    await logoutAdmin();
    setSession({ signedIn: false, ownerId: null, email: null });
  }, []);
  return <Context.Provider value={{
    user: session?.signedIn && session.ownerId ? { id: session.ownerId, email: session.email ?? "Admin" } : null,
    isSignedIn: Boolean(session?.signedIn), isLoaded: loaded, error, signIn, signOut,
  }}>{children}</Context.Provider>;
}
export function useAdminAuth() {
  const context = useContext(Context);
  if (!context) throw new Error("Admin auth provider is missing.");
  return context;
}
