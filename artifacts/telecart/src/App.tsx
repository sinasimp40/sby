import { useEffect, useRef, type ReactNode } from "react";
import { ClerkProvider, SignIn, SignUp, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Route, Switch, useLocation, Router as WouterRouter, Link } from "wouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
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

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(203 89% 41%)",
    colorForeground: "hsl(224 38% 13%)",
    colorMutedForeground: "hsl(224 12% 40%)",
    colorDanger: "hsl(356 70% 48%)",
    colorBackground: "hsl(44 40% 99%)",
    colorInput: "hsl(42 33% 97%)",
    colorInputForeground: "hsl(224 38% 13%)",
    colorNeutral: "hsl(224 38% 13%)",
    fontFamily: "'Instrument Sans', system-ui, sans-serif",
    borderRadius: "0.625rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[hsl(44_40%_99%)] rounded-2xl w-[420px] max-w-full overflow-hidden border border-[hsl(36_18%_86%)] shadow-xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "font-['Bricolage_Grotesque'] text-2xl font-bold text-[hsl(224_38%_13%)]",
    headerSubtitle: "text-[hsl(224_12%_40%)]",
    socialButtonsBlockButtonText: "text-[hsl(224_38%_13%)] font-medium",
    formFieldLabel: "text-[hsl(224_38%_13%)] font-medium",
    footerActionLink: "text-[hsl(203_89%_38%)] font-semibold",
    footerActionText: "text-[hsl(224_12%_40%)]",
    dividerText: "text-[hsl(224_12%_45%)]",
    identityPreviewEditButton: "text-[hsl(203_89%_38%)]",
    formFieldSuccessText: "text-[hsl(158_58%_30%)]",
    alertText: "text-[hsl(224_38%_13%)]",
    logoBox: "justify-center",
    logoImage: "h-11 w-11",
    socialButtonsBlockButton: "border border-[hsl(36_16%_80%)] bg-[hsl(42_33%_97%)]",
    formButtonPrimary: "bg-[hsl(203_89%_41%)] text-[hsl(44_50%_98%)] font-semibold",
    formFieldInput: "border border-[hsl(36_16%_80%)] bg-[hsl(42_33%_97%)] text-[hsl(224_38%_13%)]",
    footerAction: "justify-center",
    dividerLine: "bg-[hsl(36_18%_85%)]",
    alert: "border border-[hsl(22_90%_50%/0.3)] bg-[hsl(28_95%_93%)]",
    otpCodeFieldInput: "border border-[hsl(36_16%_80%)] text-[hsl(224_38%_13%)]",
    formFieldRow: "gap-3",
    main: "gap-5",
  },
};

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="dotgrid relative flex min-h-[100dvh] flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <Link href="/" className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground" data-testid="link-back-preview">Back to shop preview</Link>
      {children}
      <p className="max-w-sm text-center text-xs text-muted-foreground">Each owner gets a private, isolated shop. New shops start empty — no sample data, no fake sales.</p>
    </div>
  );
}

function SignInPage() {
  return (
    <AuthFrame>
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </AuthFrame>
  );
}

function SignUpPage() {
  return (
    <AuthFrame>
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </AuthFrame>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function AdminRoutes() {
  return (
    <AppShell>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={OverviewPage} />
          <Route path="/products" component={ProductsPage} />
          <Route path="/inventory" component={InventoryPage} />
          <Route path="/orders" component={OrdersPage} />
          <Route path="/customers" component={CustomersPage} />
          <Route path="/wallets" component={WalletsPage} />
          <Route path="/bot" component={BotPage} />
          <Route path="/payments" component={PaymentsPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </AppShell>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: "Open your control room", subtitle: "Sign in to manage your Telecart shop" } },
        signUp: { start: { title: "Create your shop", subtitle: "A private workspace that starts empty" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <AuthGateProvider>
            <Switch>
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route component={AdminRoutes} />
            </Switch>
          </AuthGateProvider>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
