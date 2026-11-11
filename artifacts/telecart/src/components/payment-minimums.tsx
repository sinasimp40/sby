import { useGetIntegration, useGetPaymentMinimums } from "@workspace/api-client-react";
import { Panel, ErrorState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/format";

const labels: Record<string, string> = { LTC: "LTC", BTC: "BTC", USDTERC20: "USDT · ERC20", USDTTRC20: "USDT · TRC20", BNBBSC: "BNB · BEP20", SOL: "SOL" };
export function PaymentMinimumsPanel() {
  const status = useGetIntegration();
  const query = useGetPaymentMinimums({ query: { enabled: Boolean(status.data?.isOperator), refetchInterval: 60000 } });
  if (!status.data?.isOperator) return null;
  return <Panel title="Live provider minimums" meta="USD · your merchant route">
    <p className="mb-3 text-xs text-muted-foreground">Minimums vary by coin, network, payout route and rate mode. The actual minimum is the higher of your shop setting and the provider minimum. Rechecked before each invoice.</p>
    {query.isError ? <ErrorState message="Provider minimum lookup failed" onRetry={() => query.refetch()} /> :
      query.isLoading ? <p className="text-sm">Fetching NOWPayments minimums…</p> :
        <table className="w-full text-left text-xs"><thead><tr className="border-b"><th className="py-2">Coin / network</th><th>Fixed rate</th><th>Floating rate</th></tr></thead>
          <tbody>{query.data?.map(row => <tr className="border-b" key={row.coin}><td className="py-2 font-medium">{labels[row.coin] ?? row.coin}</td><td>{row.fixedUSD === null ? "Unavailable" : money(row.fixedUSD)}</td><td>{row.floatingUSD === null ? "Unavailable" : money(row.floatingUSD)}</td></tr>)}</tbody>
        </table>}
    <div className="mt-3 flex items-center justify-between gap-3"><span className="text-[11px] text-muted-foreground">{query.data?.[0] ? `Checked ${new Date(query.data[0].checkedAt).toLocaleTimeString()}` : ""}</span><Button type="button" size="sm" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Refresh minimums</Button></div>
  </Panel>;
}
