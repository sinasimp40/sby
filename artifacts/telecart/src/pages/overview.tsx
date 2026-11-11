import { Link } from "wouter";
import { useGetOverview, useListActivity } from "@workspace/api-client-react";
import { CheckCircle2, Circle, ArrowUpRight, Receipt, Package, Activity as ActivityIcon, Bot, CreditCard } from "lucide-react";
import { PageHeader, Panel, Stat, EmptyState, ErrorState, RowsSkeleton, StatusPill, SetupRequired } from "@/components/shared";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { money, ago } from "@/lib/format";
import { useAuthGate } from "@/components/auth-gate";

export default function OverviewPage() {
  const { data, isLoading, isError, error, refetch } = useGetOverview({ query: { refetchInterval: 5000, refetchOnWindowFocus: true } });
  const activity = useListActivity();
  const { isSignedIn } = useAuthGate();
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  return (
    <div>
      <PageHeader eyebrow={today} title={isSignedIn ? "Your shop, today" : "Shop overview — preview"}
        description="Sales, stock and setup at a glance. Figures are real: until Telegram and NOWPayments are connected, revenue stays at zero."
        actions={<Button asChild data-testid="button-add-product"><Link href="/products">Manage products</Link></Button>} />

      {isError ? <ErrorState message={(error as Error)?.message ?? "Failed to load overview"} onRetry={() => refetch()} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {isLoading || !data ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-xl" />) : (
              <>
                <Stat label="Revenue" value={money(data.revenue)} hint={`${data.orderCount} orders`} testId="stat-revenue" />
                <Stat label="Customers" value={data.customerCount} hint={`${money(data.walletBalance)} in wallets`} testId="stat-customers" />
                <Stat label="Products" value={data.productCount} hint={`${data.stockCount} accounts in stock`} testId="stat-products" />
                <Stat label="Pending payments" value={data.pendingPayments} hint="Awaiting provider" testId="stat-pending" />
              </>
            )}
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <div className="space-y-5">
              <Panel title="Recent orders" meta={<Link href="/orders" className="inline-flex items-center gap-1 hover:text-foreground">All orders <ArrowUpRight className="h-3 w-3" /></Link>} bodyClassName="p-0">
                {isLoading ? <div className="p-4"><RowsSkeleton rows={3} /></div> : !data?.recentOrders.length ? (
                  <div className="p-4"><EmptyState icon={Receipt} title="No orders yet" body="Orders appear here once the Telegram bot and NOWPayments checkout are connected. Nothing is faked in the meantime." /></div>
                ) : (
                  <ul className="divide-y divide-border/70">
                    {data.recentOrders.map((o) => (
                      <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm" data-testid={`row-recent-order-${o.id}`}>
                        <div className="min-w-0"><div className="truncate font-medium">{o.productName}</div><div className="text-xs text-muted-foreground">@{o.customer} · {ago(o.createdAt)}</div></div>
                        <div className="flex items-center gap-3"><StatusPill status={o.status} /><span className="tabular font-mono text-sm">{money(o.amount)}</span></div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title="Top products" meta="by units sold" bodyClassName="p-0">
                {isLoading ? <div className="p-4"><RowsSkeleton rows={3} /></div> : !data?.topProducts.length ? (
                  <div className="p-4"><EmptyState icon={Package} title="No products" body="Add your first product to start building a catalog." action={<Button size="sm" asChild><Link href="/products">Add product</Link></Button>} /></div>
                ) : (
                  <ul className="divide-y divide-border/70">
                    {data.topProducts.map((p, i) => (
                      <li key={p.id} className="flex items-center gap-3 px-4 py-3 text-sm" data-testid={`row-top-product-${p.id}`}>
                        <span className="w-5 font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                        <div className="min-w-0 flex-1"><div className="truncate font-medium">{p.name}</div><div className="text-xs text-muted-foreground">{p.category} · {p.stock} in stock</div></div>
                        <span className="tabular font-mono text-xs text-muted-foreground">{p.sold} sold</span>
                        <span className="tabular w-20 text-right font-mono">{money(p.price)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>

            <div className="space-y-5">
              <Panel title="Connections">
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2.5">
                    <div className="flex items-center gap-2.5 text-sm font-medium"><Bot className="h-4 w-4 text-primary" />Telegram bot</div>
                    <SetupRequired label={data?.botConnected ? "Connected" : "Not connected"} />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2.5">
                    <div className="flex items-center gap-2.5 text-sm font-medium"><CreditCard className="h-4 w-4 text-primary" />NOWPayments</div>
                    <SetupRequired label={data?.paymentsConnected ? "Connected" : "Not connected"} />
                  </div>
                  <p className="text-xs text-muted-foreground">Live connections are not part of this build. Configure messages and preferences now; activation comes later through a secure setup.</p>
                </div>
              </Panel>
              <Panel title="Launch checklist" meta={data ? `${data.checklist.filter((c) => c.complete).length}/${data.checklist.length}` : undefined}>
                {isLoading ? <RowsSkeleton rows={4} /> : (
                  <ul className="space-y-1">
                    {data?.checklist.map((c, i) => (
                      <li key={i}>
                        <Link href={c.href} className="flex items-center gap-2.5 rounded-md px-2 py-2 text-sm hover:bg-muted" data-testid={`link-checklist-${i}`}>
                          {c.complete ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <Circle className="h-4 w-4 text-muted-foreground/60" />}
                          <span className={c.complete ? "text-muted-foreground line-through" : ""}>{c.label}</span>
                          <ArrowUpRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title="Activity">
                {activity.isLoading ? <RowsSkeleton rows={3} /> : activity.isError ? <ErrorState message="Activity unavailable" onRetry={() => activity.refetch()} /> : !activity.data?.length ? (
                  <EmptyState icon={ActivityIcon} title="Quiet so far" body="Product edits, imports and setting changes are logged here." />
                ) : (
                  <ol className="relative space-y-3 border-l border-border pl-4">
                    {activity.data.slice(0, 8).map((a) => (
                      <li key={a.id} className="relative" data-testid={`row-activity-${a.id}`}>
                        <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary ring-4 ring-card" />
                        <div className="text-sm font-medium">{a.title}</div>
                        <div className="text-xs text-muted-foreground">{a.description} · {ago(a.createdAt)}</div>
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
