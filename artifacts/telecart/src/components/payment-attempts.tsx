import { useQueryClient } from "@tanstack/react-query";
import { useListPaymentAttempts, useCheckPaymentAttempt } from "@workspace/api-client-react";
import { Panel, ErrorState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { money, errMsg } from "@/lib/format";

export function PaymentAttemptsPanel() {
  const payments = useListPaymentAttempts({ query: { refetchInterval: 15000 } });
  const check = useCheckPaymentAttempt();
  const qc = useQueryClient();
  const { toast } = useToast();
  return (
    <Panel title="Live payment attempts" meta="latest 200 · refreshes every 15s">
      <p className="mb-3 text-xs text-muted-foreground">Checks query NOWPayments directly. No admin action can mark an invoice paid. “Review” requires investigation before retrying; stock stays reserved if invoice creation was uncertain.</p>
      {payments.isError ? <ErrorState message="Could not load payments" onRetry={() => payments.refetch()} /> :
        payments.isLoading ? <p className="text-sm text-muted-foreground">Loading payments…</p> :
        !payments.data?.length ? <p className="py-4 text-sm text-muted-foreground">No real payment attempts yet. Invoices appear here when a customer chooses a payment method in the connected bot.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-left text-xs">
            <thead><tr className="border-b"><th className="p-2">Reference / customer</th><th className="p-2">Purpose / amount</th><th className="p-2">Provider status</th><th className="p-2">Fulfillment</th><th className="p-2">Verify</th></tr></thead>
            <tbody>{payments.data.map(p => <tr key={p.id} className="border-b" data-testid={`payment-row-${p.id}`}>
              <td className="p-2"><div className="font-mono" title={p.id}>{p.id.slice(0, 8)}</div><div className="text-muted-foreground">{p.customer}</div><div className="font-mono text-muted-foreground">{p.providerPaymentId || "No provider ID"}</div></td>
              <td className="p-2"><div>{p.productName}</div><div>{money(p.amount)} · {p.currency}</div></td>
              <td className="p-2">{p.status}</td><td className="p-2">{p.fulfillment}</td>
              <td className="p-2"><Button size="sm" variant="outline" disabled={check.isPending || (!p.providerPaymentId && p.kind !== "wallet")} onClick={() => check.mutate({ id: p.id }, {
                onSuccess: () => { qc.invalidateQueries(); toast({ title: "Payment checked", description: "Provider status and fulfillment have been refreshed." }); },
                onError: e => toast({ title: "Check failed", description: errMsg(e), variant: "destructive" }),
              })} data-testid={`button-check-payment-${p.id}`}>Check status</Button></td>
            </tr>)}</tbody>
          </table></div>
        )}
    </Panel>
  );
}
