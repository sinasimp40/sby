import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { getAdminSession, loginAdmin, logoutAdmin, type AdminCredentials } from "@workspace/api-client-react";
import { AdminSessionController } from "./admin-session-controller";

type AdminAuth = {
  user: { id: string; email: string } | null;
  isSignedIn: boolean;
  isLoaded: boolean;
  error: string | null;
  connectionWarning: string | null;
  signIn: (credentials: AdminCredentials) => Promise<void>;
  signOut: () => Promise<void>;
};
const Context = createContext<AdminAuth | null>(null);
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new AdminSessionController({
    check: getAdminSession, login: loginAdmin, logout: logoutAdmin,
  }));
  const { session, loaded, error, connectionWarning } = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  useEffect(() => {
    void controller.refresh();
    const interval = setInterval(() => void controller.refresh(), 60000);
    const focus = () => void controller.refresh();
    window.addEventListener("focus", focus);
    window.addEventListener("online", focus);
    return () => { controller.cancelCheck(); clearInterval(interval); window.removeEventListener("focus", focus); window.removeEventListener("online", focus); };
  }, [controller]);
  useEffect(() => {
    if (!connectionWarning && !error) return;
    const retry = setInterval(() => void controller.refresh(), 5000);
    return () => clearInterval(retry);
  }, [controller, connectionWarning, error]);
  return <Context.Provider value={{
    user: session?.signedIn && session.ownerId ? { id: session.ownerId, email: session.email ?? "Admin" } : null,
    isSignedIn: Boolean(session?.signedIn), isLoaded: loaded, error, connectionWarning,
    signIn: controller.signIn, signOut: controller.signOut,
  }}>{children}</Context.Provider>;
}
export function useAdminAuth() {
  const context = useContext(Context);
  if (!context) throw new Error("Admin auth provider is missing.");
  return context;
}
