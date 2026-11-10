import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { LayoutDashboard, Package, KeyRound, Receipt, Users, Wallet, Bot, CreditCard, Settings2, Menu, LogOut, Eye, LogIn } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useGetSettings } from "@workspace/api-client-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const groups = [
  { label: "Shop", items: [
    { href: "/", label: "Overview", icon: LayoutDashboard },
    { href: "/products", label: "Products", icon: Package },
    { href: "/inventory", label: "Inventory", icon: KeyRound },
  ] },
  { label: "Ledger", items: [
    { href: "/orders", label: "Orders", icon: Receipt },
    { href: "/customers", label: "Customers", icon: Users },
    { href: "/wallets", label: "Wallets", icon: Wallet },
  ] },
  { label: "Setup", items: [
    { href: "/bot", label: "Bot messages", icon: Bot },
    { href: "/payments", label: "NOWPayments", icon: CreditCard },
    { href: "/settings", label: "Settings", icon: Settings2 },
  ] },
];

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5" data-testid="link-brand">
      <img src={`${basePath}/logo.svg`} alt="" className="h-8 w-8 rounded-lg ring-1 ring-white/10" />
      <div className="leading-none">
        <div className="font-display text-[17px] font-bold tracking-tight text-sidebar-accent-foreground">Telecart</div>
        <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.2em] text-sidebar-foreground/50">control room</div>
      </div>
    </Link>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const [loc] = useLocation();
  return (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="mb-1.5 px-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-sidebar-foreground/40">{g.label}</div>
          <div className="space-y-0.5">
            {g.items.map((it) => {
              const active = it.href === "/" ? loc === "/" : loc.startsWith(it.href);
              return (
                <Link key={it.href} href={it.href} onClick={onNavigate} data-testid={`link-nav-${it.label.toLowerCase().replace(/\s/g, "-")}`}
                  className={cn("group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors",
                    active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground")}>
                  <span className={cn("absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-sidebar-primary transition-opacity", active ? "opacity-100" : "opacity-0")} />
                  <it.icon className={cn("h-4 w-4", active ? "text-sidebar-primary" : "")} />
                  {it.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function Account() {
  const { user, isSignedIn, isLoaded } = useUser();
  const { signOut } = useClerk();
  if (!isLoaded) return <div className="m-3 h-14 animate-pulse rounded-lg bg-sidebar-accent/50" />;
  if (!isSignedIn) {
    return (
      <div className="m-3 rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-3">
        <div className="text-xs text-sidebar-foreground/70">You are viewing the public preview.</div>
        <div className="mt-2.5 grid grid-cols-2 gap-1.5">
          <Button size="sm" asChild className="bg-sidebar-primary text-sidebar-primary-foreground"><Link href="/sign-in" data-testid="link-sign-in"><LogIn className="mr-1 h-3.5 w-3.5" />Sign in</Link></Button>
          <Button size="sm" variant="outline" asChild className="border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent"><Link href="/sign-up" data-testid="link-sign-up">Create</Link></Button>
        </div>
      </div>
    );
  }
  const name = user?.firstName || user?.username || user?.primaryEmailAddress?.emailAddress || "Owner";
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div className="m-3 flex items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-2.5">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-sidebar-primary font-mono text-xs font-semibold text-sidebar-primary-foreground">{initials}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-sidebar-accent-foreground" data-testid="text-user-name">{name}</div>
        <div className="truncate text-[11px] text-sidebar-foreground/50">{user?.primaryEmailAddress?.emailAddress}</div>
      </div>
      <button onClick={() => signOut({ redirectUrl: basePath || "/" })} className="rounded-md p-1.5 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" title="Sign out" data-testid="button-sign-out">
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}

function ModeBanner() {
  const { isSignedIn, isLoaded } = useUser();
  const settings = useGetSettings({ query: { enabled: Boolean(isSignedIn), refetchInterval: 30000 } });
  if (!isLoaded) return null;
  if (isSignedIn) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-card/70 px-4 py-2 text-xs text-muted-foreground backdrop-blur md:px-8">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" />
        <span>Private workspace</span>
        <span className="text-border">/</span>
        <span>{settings.data?.botConnected && settings.data?.paymentsConnected ? <>Bot webhook configured · NOWPayments fulfillment waits for <b>finished</b>.</> : <>Telegram bot and NOWPayments need <b className="font-semibold text-signal">activation</b> before live orders can arrive.</>}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-signal/25 bg-signal-soft px-4 py-2 text-xs md:px-8" data-testid="banner-preview">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-signal px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-white"><Eye className="h-3 w-3" />Preview mode</span>
      <span className="text-foreground/80">Sample products only. Zero real sales, zero payments. Saving requires sign-in.</span>
      <Link href="/sign-in" className="font-semibold text-signal underline-offset-2 hover:underline">Sign in to your shop</Link>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-[100dvh] bg-background">
      <aside className="sticky top-0 hidden h-[100dvh] w-[244px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="px-5 pb-2 pt-5"><Brand /></div>
        <NavList />
        <Account />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-30 flex items-center justify-between bg-sidebar px-4 py-3 lg:hidden">
          <Brand />
          <button onClick={() => setOpen(true)} className="rounded-md p-2 text-sidebar-foreground hover:bg-sidebar-accent" data-testid="button-mobile-menu" aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
        </div>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="flex w-[270px] flex-col border-sidebar-border bg-sidebar p-0 text-sidebar-foreground">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <div className="px-5 pb-2 pt-5"><Brand /></div>
            <NavList onNavigate={() => setOpen(false)} />
            <Account />
          </SheetContent>
        </Sheet>
        <ModeBanner />
        <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
