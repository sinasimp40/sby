import { useMemo, useState } from "react";
import { useListOrders } from "@workspace/api-client-react";
import type { Order } from "@workspace/api-client-react";
import { Receipt, Download, Search } from "lucide-react";
import { PageHeader, Panel, EmptyState, ErrorState, RowsSkeleton, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { customerName, money, dateTime } from "@/lib/format";
import { OrderDelivery } from "@/components/order-delivery";

function exportCsv(rows: Order[]) {
  const head = ["id", "customer", "product", "amount_usd", "status", "payment_method", "created_at"];
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const body = rows.map((o) => [o.id, o.customer, o.productName, o.amount.toFixed(2), o.status, o.paymentMethod, o.createdAt].map(esc).join(","));
  const blob = new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `telecart-orders-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function OrdersPage() {
  const { data, isLoading, isError, error, refetch } = useListOrders({ query: { refetchInterval: 5000, refetchOnWindowFocus: true } });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [chosen, setSelected] = useState<Order | null>(null);
  const selected = data?.find(order => order.id === chosen?.id) ?? chosen;
  const rows = useMemo(() => (data ?? []).filter((o) => (status === "all" || o.status === status) && `${o.id} ${o.customer} ${o.productName}`.toLowerCase().includes(q.toLowerCase())), [data, q, status]);

  return (
    <div>
      <PageHeader eyebrow="Ledger" title="Orders" description="Every purchase made through your bot. Empty until the Telegram bot and NOWPayments checkout go live — nothing here is simulated."
        actions={<Button variant="outline" disabled={!rows.length} onClick={() => exportCsv(rows)} data-testid="button-export-csv"><Download className="mr-1.5 h-4 w-4" />Export CSV</Button>} />
      <Panel bodyClassName="p-0">
        <div className="flex flex-col gap-2 border-b border-border/70 p-3 sm:flex-row">
          <div className="relative flex-1"><Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order ID, customer or product" className="pl-8" data-testid="input-search-orders" /></div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="sm:w-44" data-testid="select-order-status"><SelectValue /></SelectTrigger>
            <SelectContent>{["all", "pending", "paid", "delivered", "cancelled", "refunded"].map((s) => <SelectItem key={s} value={s} className="capitalize">{s === "all" ? "All statuses" : s}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {isLoading ? <div className="p-4"><RowsSkeleton /></div> : isError ? <div className="p-4"><ErrorState message={(error as Error)?.message ?? "Failed to load orders"} onRetry={() => refetch()} /></div> : !rows.length ? (
          <div className="p-4"><EmptyState icon={Receipt} title={data?.length ? "No matching orders" : "No orders yet"} body={data?.length ? "Adjust the search or status filter." : "When buyers check out through your bot, each order lands here with its payment and delivery status."} /></div>
        ) : (
          <div className="dashboard-scroll dashboard-table-scroll" tabIndex={0} role="region" aria-label="Orders" data-testid="scroll-orders">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border/70 text-left font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground"><th className="px-4 py-2.5 font-medium">Order</th><th className="px-3 py-2.5 font-medium">Customer</th><th className="px-3 py-2.5 font-medium">Product</th><th className="px-3 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 text-right font-medium">Amount</th></tr></thead>
              <tbody className="divide-y divide-border/60">
                {rows.map((o) => (
                  <tr key={o.id} onClick={() => setSelected(o)} className="cursor-pointer hover:bg-muted/40" data-testid={`row-order-${o.id}`}>
                    <td className="px-4 py-3"><div className="font-mono text-xs">{o.id}</div><div className="text-xs text-muted-foreground">{dateTime(o.createdAt)}</div></td>
                    <td className="px-3 py-3">{customerName(o.customer)}</td><td className="px-3 py-3">{o.productName}</td>
                    <td className="px-3 py-3"><StatusPill status={o.status} /></td>
                    <td className="tabular px-4 py-3 text-right font-mono">{money(o.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {selected && (
            <>
              <SheetHeader><SheetTitle className="font-display text-xl">Order {selected.id}</SheetTitle><SheetDescription>{dateTime(selected.createdAt)}</SheetDescription></SheetHeader>
              <dl className="mt-6 divide-y divide-border rounded-lg border border-border text-sm">
                {[["Status", <StatusPill key="s" status={selected.status} />], ["Customer", customerName(selected.customer)], ["Product", selected.productName], ["Payment", selected.paymentMethod], ["Amount", <span key="a" className="font-mono">{money(selected.amount)}</span>]].map(([k, v]) => (
                  <div key={String(k)} className="flex items-center justify-between px-3 py-2.5"><dt className="text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>
                ))}
              </dl>
              <OrderDelivery key={selected.id} orderId={selected.id} delivered={selected.status === "delivered"} />
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
