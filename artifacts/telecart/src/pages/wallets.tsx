import { useMemo } from "react";
import { Link } from "wouter";
import { useListDeposits, useListCustomers } from "@workspace/api-client-react";
import { Wallet } from "lucide-react";
import { PageHeader, Panel, EmptyState, ErrorState, RowsSkeleton, StatusPill, Stat } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { money, dateTime } from "@/lib/format";

export default function WalletsPage() {
  const deposits = useListDeposits({ query: { refetchInterval: 5000, refetchOnWindowFocus: true } });
  const customers = useListCustomers({ query: { refetchInterval: 5000, refetchOnWindowFocus: true } });
  const totals = useMemo(() => {
    const d = deposits.data ?? [];
    return {
      balance: (customers.data ?? []).reduce((s, c) => s + c.walletBalance, 0),
      finished: d.filter((x) => x.status === "finished").reduce((s, x) => s + x.amount, 0),
      open: d.filter((x) => x.status === "waiting" || x.status === "confirming").length,
    };
  }, [deposits.data, customers.data]);

  return (
    <div>
      <PageHeader eyebrow="Ledger" title="Wallets & deposits" description="Refreshes every 5 seconds. Payment verification runs separately, normally about every 30 seconds." actions={<Button variant="outline" size="sm" disabled={deposits.isFetching || customers.isFetching} onClick={() => { void deposits.refetch(); void customers.refetch(); }}>Refresh now</Button>} />
      {customers.isError && <div className="mb-4"><ErrorState message="Wallet balances could not be refreshed." onRetry={() => customers.refetch()} /></div>}
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Held in wallets" value={customers.isLoading || customers.isError ? "—" : money(totals.balance)} testId="stat-wallet-balance" />
        <Stat label="Deposited (finished)" value={money(totals.finished)} testId="stat-deposited" />
        <Stat label="Open invoices" value={totals.open} testId="stat-open-invoices" />
      </div>
      <p className="mb-4 text-xs text-muted-foreground">Cancel stops the deposit flow, not an on-chain transfer. Cancelled invoices remain in history; any funds already sent are still verified and credited after final confirmation.{deposits.dataUpdatedAt ? ` Last refreshed ${new Date(deposits.dataUpdatedAt).toLocaleTimeString()}.` : ""}</p>
      <Panel title="Deposit history" meta={<Link href="/payments" className="hover:text-foreground">Payment preferences</Link>} bodyClassName="p-0">
        {deposits.isLoading ? <div className="p-4"><RowsSkeleton /></div> : deposits.isError ? <div className="p-4"><ErrorState message="Failed to load deposits" onRetry={() => deposits.refetch()} /></div> : !deposits.data?.length ? (
          <div className="p-4"><EmptyState icon={Wallet} title="No deposits yet" body="Invoices appear here when a customer creates a deposit in the bot. Only verified, completed payments add wallet balance." /></div>
        ) : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-border/70 text-left font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground"><th className="px-4 py-2.5 font-medium">Deposit</th><th className="px-3 py-2.5 font-medium">Customer</th><th className="px-3 py-2.5 font-medium">Coin</th><th className="px-3 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 text-right font-medium">Amount</th></tr></thead>
            <tbody className="divide-y divide-border/60">{deposits.data.map((d) => (
              <tr key={d.id} data-testid={`row-deposit-${d.id}`}><td className="px-4 py-3"><div className="font-mono text-xs">{d.id}</div><div className="text-xs text-muted-foreground">{dateTime(d.createdAt)}</div></td><td className="px-3 py-3">{d.customer.startsWith("@") ? d.customer : `@${d.customer}`}</td><td className="px-3 py-3 font-mono text-xs">{d.currency}</td><td className="px-3 py-3"><StatusPill status={d.status} />{d.cancelledAt && <div className="mt-1 text-xs text-muted-foreground">Cancelled by customer · payment checking continues</div>}</td><td className="tabular px-4 py-3 text-right font-mono">{money(d.amount)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </div>
  );
}
