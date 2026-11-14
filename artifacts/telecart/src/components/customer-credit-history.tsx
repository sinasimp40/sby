import { useState } from "react";
import { useListCustomerWalletCredits } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { dateTime, errMsg, money } from "@/lib/format";

export function CustomerCreditHistory({ customerId, revision }: { customerId: string; revision: number }) {
  // Remount after a successful credit so a prior "older" page returns to the latest.
  return <CreditHistoryPage key={revision} customerId={customerId} />;
}
function CreditHistoryPage({ customerId }: { customerId: string }) {
  const [cursor, setCursor] = useState<string>();
  const history = useListCustomerWalletCredits(customerId, cursor ? { cursor } : undefined, {
    query: { retry: false, refetchOnWindowFocus: true },
  });
  return <section className="mt-6" aria-label="Manual credit history">
    <h3 className="text-sm font-semibold">Manual credit history</h3>
    <p className="mt-1 text-xs text-muted-foreground">Owner-added funds only. Deposits and purchase payments are recorded separately.</p>
    {history.isLoading ? <p className="mt-3 text-sm text-muted-foreground">Loading credits…</p> :
      history.isError ? <div role="alert" className="mt-3 space-y-2 text-sm">
        <p className="text-destructive">{errMsg(history.error)}</p>
        <Button size="sm" variant="outline" onClick={() => cursor ? setCursor(undefined) : void history.refetch()}>Reload credits</Button>
      </div> :
      !history.data?.entries.length ? <p className="mt-3 text-sm text-muted-foreground">No manual credits recorded.</p> :
      <ul className="mt-3 max-h-80 space-y-3 overflow-y-auto rounded-lg border p-3" tabIndex={0} aria-label="Recorded manual credits" data-testid="list-manual-credits">
        {history.data.entries.map(entry => <li key={entry.id} className="border-b pb-3 text-xs last:border-0 last:pb-0">
          <div className="flex flex-wrap justify-between gap-1">
            <span className="font-semibold text-ok">+{money(entry.amountCents / 100)}</span>
            <time dateTime={entry.createdAt} className="text-muted-foreground">{dateTime(entry.createdAt)}</time>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{entry.reason}</p>
          <p className="mt-1 text-muted-foreground">Balance: {money(entry.balanceBeforeCents / 100)} → {money(entry.balanceAfterCents / 100)}</p>
          <details className="mt-1 text-muted-foreground">
            <summary className="cursor-pointer">Credit reference and actor</summary>
            <p className="mt-1 break-all font-mono">Credit: {entry.id}</p>
            <p className="break-all font-mono">Actor: {entry.actorId}</p>
          </details>
        </li>)}
      </ul>}
    <div className="mt-2 flex flex-wrap gap-2">
      {cursor && <Button size="sm" variant="outline" onClick={() => setCursor(undefined)}>Latest credits</Button>}
      {history.data?.nextCursor && <Button size="sm" variant="outline" disabled={history.isFetching} onClick={() => setCursor(history.data!.nextCursor!)}>Older credits</Button>}
    </div>
  </section>;
}
