import { useState, type FormEvent, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch, useLocation, Router as WouterRouter, Link } from "wouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminAuthProvider, useAdminAuth } from "@/hooks/use-admin-auth";
import { errMsg } from "@/lib/format";
import NotFound from "@/pages/not-found";
import { AppShell } from "@/components/layout";
import { AuthGateProvider } from "@/components/auth-gate";
import OverviewPage from "@/pages/overview";
import ProductsPage from "@/pages/products";
import InventoryPage from "@/pages/inventory";
import OrdersPage from "@/pages/orders";
import CustomersPage from "@/pages/customers";
import WalletsPage from "@/pages/wallets";
import BotPage from "@/pages/bot";
import PaymentsPage from "@/pages/payments";
import SettingsPage from "@/pages/settings";
import DataTransferPage from "@/pages/data-transfer";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
function SessionQueries({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function AuthScopedQueries({ children }: { children: ReactNode }) {
  const { user, isLoaded, error } = useAdminAuth();
  if (!isLoaded) return <div className="grid min-h-screen place-items-center text-sm">Loading your shop…</div>;
  if (error) return <div className="grid min-h-screen place-items-center p-6 text-sm" role="alert">{error}</div>;
  // Remount all queries and forms on login/logout so private data never survives
  // an identity transition in mounted observers.
  return <SessionQueries key={user?.id ?? "public-preview"}>{children}</SessionQueries>;
}
function SignInPage() {
  const { signIn, isSignedIn } = useAdminAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await signIn({ email, password });
      setPassword("");
      navigate("/");
    } catch (e) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }
  return <div className="dotgrid flex min-h-[100dvh] flex-col items-center justify-center gap-6 bg-background px-4 py-10">
    <Link href="/" className="font-mono text-xs text-muted-foreground" data-testid="link-admin-home">Telecart admin</Link>
    <section className="w-full max-w-md rounded-2xl border bg-card p-7 shadow-xl">
      <img src={`${basePath}/logo.svg`} alt="" className="mb-5 h-11 w-11" />
      <h1 className="font-display text-2xl font-bold">Admin sign-in</h1>
      <p className="mb-6 mt-2 text-sm text-muted-foreground">Enter your admin email and password. No email code or OTP is required.</p>
      {isSignedIn ? <Button asChild className="w-full"><Link href="/">Open dashboard</Link></Button> :
        <form onSubmit={submit} className="space-y-4" data-testid="form-admin-login">
          <div className="space-y-2"><label htmlFor="admin-email" className="text-sm font-medium">Admin email</label>
            <Input id="admin-email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} data-testid="input-admin-email" /></div>
          <div className="space-y-2"><label htmlFor="admin-password" className="text-sm font-medium">Password</label>
            <Input id="admin-password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={e => setPassword(e.target.value)} data-testid="input-admin-password" /></div>
          {error && <p role="alert" className="text-sm text-destructive" data-testid="error-admin-login">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full" data-testid="button-admin-login">{busy ? "Signing in…" : "Sign in"}</Button>
        </form>}
    </section>
    <p className="max-w-sm text-center text-xs text-muted-foreground">Admin-only access. Sessions expire after eight hours. Keep your password private.</p>
  </div>;
}
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
function AdminRoutes() {
  return <AppShell><RoutedErrorBoundary><Switch>
    <Route path="/" component={OverviewPage} />
    <Route path="/products" component={ProductsPage} />
    <Route path="/inventory" component={InventoryPage} />
    <Route path="/orders" component={OrdersPage} />
    <Route path="/customers" component={CustomersPage} />
    <Route path="/wallets" component={WalletsPage} />
    <Route path="/bot" component={BotPage} />
    <Route path="/payments" component={PaymentsPage} />
    <Route path="/settings" component={SettingsPage} />
    <Route path="/data-transfer" component={DataTransferPage} />
    <Route component={NotFound} />
  </Switch></RoutedErrorBoundary></AppShell>;
}
function ProtectedRoutes() {
  const { isSignedIn, isLoaded } = useAdminAuth();
  if (!isLoaded) return <div className="grid min-h-screen place-items-center text-sm">Loading your shop…</div>;
  return isSignedIn ? <AdminRoutes /> : <SignInPage />;
}
export default function App() {
  return <WouterRouter base={basePath}><AdminAuthProvider><AuthScopedQueries><TooltipProvider><AuthGateProvider>
    <Switch>
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignInPage} />
      <Route component={ProtectedRoutes} />
    </Switch>
    <Toaster />
  </AuthGateProvider></TooltipProvider></AuthScopedQueries></AdminAuthProvider></WouterRouter>;
}
