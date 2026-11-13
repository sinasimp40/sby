import { useQueryClient } from "@tanstack/react-query";
import { useListPaymentAttempts, useCheckPaymentAttempt } from "@workspace/api-client-react";
import { Panel, ErrorState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { money, errMsg } from "@/lib/format";
import { CancelDepositButton } from "@/components/cancel-deposit";

export function PaymentAttemptsPanel() {
  const payments = useListPaymentAttempts({ query: { refetchInterval: 15000 } });
  const check = useCheckPaymentAttempt();
  const qc = useQueryClient();
  const { toast } = useToast();
  return (
    <Panel title="Live payment attempts" meta="latest 200 · refreshes every 15s">
      <p className="mb-3 text-xs text-muted-foreground">Recent pending invoices are checked automatically against NOWPayments about every 30 seconds while the server runs. Only a fully paid, finished payment credits a wallet or releases stock. “Review” requires investigation; uncertain invoices are never blindly recreated.</p>
      {payments.isError ? <ErrorState message="Could not load payments" onRetry={() => payments.refetch()} /> :
        payments.isLoading ? <p className="text-sm text-muted-foreground">Loading payments…</p> :
        !payments.data?.length ? <p className="py-4 text-sm text-muted-foreground">No real payment attempts yet. Invoices appear here when a customer chooses a payment method in the connected bot.</p> : (
          <div className="dashboard-scroll dashboard-table-scroll" tabIndex={0} role="region" aria-label="Payment history" data-testid="scroll-payments"><table className="w-full text-left text-xs">
            <thead><tr className="border-b"><th className="p-2">Reference / customer</th><th className="p-2">Purpose / amount</th><th className="p-2">Provider status</th><th className="p-2">Fulfillment</th><th className="p-2">Verify</th></tr></thead>
            <tbody>{payments.data.map(p => <tr key={p.id} className="border-b" data-testid={`payment-row-${p.id}`}>
              <td className="p-2"><div className="font-mono" title={p.id}>{p.id.slice(0, 8)}</div><div className="text-muted-foreground">{p.customer}</div><div className="font-mono text-muted-foreground">{p.providerPaymentId || "No provider ID"}</div></td>
              <td className="p-2"><div>{p.productName}</div><div>{money(p.amount)} · {p.currency}</div></td>
              <td className="p-2"><div>{p.status}</div>{p.cancelledAt && <div className="text-muted-foreground">Cancelled · monitoring continues</div>}<div className="text-muted-foreground">Expected: {p.payAmount ?? "—"} {p.currency}</div><div className="text-muted-foreground">Received: {p.receivedAmount ?? "Not checked"} {p.currency}</div><div className="text-muted-foreground">{p.lastCheckedAt ? `Checked ${new Date(p.lastCheckedAt).toLocaleTimeString()}` : "Awaiting first check"}</div></td><td className="p-2">{p.fulfillment}</td>
              <td className="p-2"><Button size="sm" variant="outline" disabled={check.isPending || (!p.providerPaymentId && p.kind !== "wallet")} onClick={() => check.mutate({ id: p.id }, {
                onSuccess: () => { qc.invalidateQueries(); toast({ title: "Payment checked", description: "Provider status and fulfillment have been refreshed." }); },
                onError: e => toast({ title: "Check failed", description: errMsg(e), variant: "destructive" }),
              })} data-testid={`button-check-payment-${p.id}`}>Check status</Button><div className="mt-2"><CancelDepositButton id={p.id} available={p.canCancel} /></div></td>
            </tr>)}</tbody>
          </table></div>
        )}
    </Panel>
  );
}
