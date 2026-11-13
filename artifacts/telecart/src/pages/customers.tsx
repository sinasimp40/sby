import { useMemo, useState } from "react";
import { useListCustomers, useListOrders } from "@workspace/api-client-react";
import type { Customer } from "@workspace/api-client-react";
import { Users, Search } from "lucide-react";
import { PageHeader, Panel, EmptyState, ErrorState, RowsSkeleton, StatusPill } from "@/components/shared";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { customerName, money, shortDate } from "@/lib/format";

export default function CustomersPage() {
  const { data, isLoading, isError, error, refetch } = useListCustomers({ query: { refetchInterval: 5000, refetchOnWindowFocus: true } });
  const orders = useListOrders();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Customer | null>(null);
  const rows = useMemo(() => (data ?? []).filter((c) => `${c.username} ${c.telegramId ?? ""}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  const selOrders = (orders.data ?? []).filter((o) => sel && o.customer === sel.username);

  return (
    <div>
      <PageHeader eyebrow="Ledger" title="Customers" description="Telegram users who started your bot or bought from it. Populates once the bot is connected." />
      <Panel bodyClassName="p-0">
        <div className="border-b border-border/70 p-3"><div className="relative"><Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, username or Telegram ID" className="pl-8" data-testid="input-search-customers" /></div></div>
        {isLoading ? <div className="p-4"><RowsSkeleton /></div> : isError ? <div className="p-4"><ErrorState message={(error as Error)?.message ?? "Failed to load customers"} onRetry={() => refetch()} /></div> : !rows.length ? (
          <div className="p-4"><EmptyState icon={Users} title={data?.length ? "No matches" : "No customers yet"} body={data?.length ? "Try another username." : "Customers appear after they interact with your connected Telegram bot."} /></div>
        ) : (
          <div className="dashboard-scroll dashboard-table-scroll" tabIndex={0} role="region" aria-label="Customers" data-testid="scroll-customers"><table className="w-full text-sm">
            <thead><tr className="border-b border-border/70 text-left font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground"><th className="px-4 py-2.5 font-medium">Customer</th><th className="px-3 py-2.5 text-right font-medium">Orders</th><th className="px-3 py-2.5 text-right font-medium">Spent</th><th className="px-4 py-2.5 text-right font-medium">Wallet</th></tr></thead>
            <tbody className="divide-y divide-border/60">{rows.map((c) => (
              <tr key={c.id} onClick={() => setSel(c)} className="cursor-pointer hover:bg-muted/40" data-testid={`row-customer-${c.id}`}>
                <td className="px-4 py-3"><div className="flex items-center gap-2.5"><span className="grid h-7 w-7 place-items-center rounded-md bg-accent font-mono text-[11px] font-semibold text-accent-foreground">{customerName(c.username).replace(/^@/, "").slice(0, 2).toUpperCase()}</span><div><div className="font-medium">{customerName(c.username)}</div>{c.telegramId && <div className="text-xs text-muted-foreground">{!c.username.startsWith("@") && "No public username · "}ID: <span className="select-all font-mono">{c.telegramId}</span></div>}<div className="text-xs text-muted-foreground">since {shortDate(c.joinedAt)}</div></div></div></td>
                <td className="tabular px-3 py-3 text-right font-mono">{c.orderCount}</td><td className="tabular px-3 py-3 text-right font-mono">{money(c.spent)}</td><td className="tabular px-4 py-3 text-right font-mono">{money(c.walletBalance)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Panel>
      <Sheet open={!!sel} onOpenChange={(o) => !o && setSel(null)}>
        <SheetContent className="w-full sm:max-w-md">
          {sel && (<>
            <SheetHeader><SheetTitle className="font-display text-xl">{customerName(sel.username)}</SheetTitle><SheetDescription>Customer since {shortDate(sel.joinedAt)}</SheetDescription></SheetHeader>
            {sel.telegramId && <p className="mt-2 text-xs text-muted-foreground">{!sel.username.startsWith("@") && "No public username · "}Telegram ID: <span className="select-all font-mono">{sel.telegramId}</span></p>}
            <div className="mt-5 grid grid-cols-3 gap-2 text-center">
              {[["Orders", sel.orderCount], ["Spent", money(sel.spent)], ["Wallet", money(sel.walletBalance)]].map(([k, v]) => (
                <div key={String(k)} className="rounded-lg border border-border p-2.5"><div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{k}</div><div className="tabular mt-0.5 font-display font-bold">{v}</div></div>
              ))}
            </div>
            <div className="mt-5 text-sm font-semibold">Orders</div>
            {!selOrders.length ? <p className="mt-1 text-sm text-muted-foreground">No orders recorded.</p> : (
              <ul className="dashboard-scroll mt-2 divide-y divide-border rounded-lg border border-border text-sm" tabIndex={0} aria-label="Customer order history" data-testid="scroll-customer-orders">{selOrders.map((o) => (
                <li key={o.id} className="flex items-center justify-between px-3 py-2"><span className="truncate">{o.productName}</span><span className="flex items-center gap-2"><StatusPill status={o.status} /><span className="font-mono">{money(o.amount)}</span></span></li>))}</ul>
            )}
          </>)}
        </SheetContent>
      </Sheet>
    </div>
  );
}
