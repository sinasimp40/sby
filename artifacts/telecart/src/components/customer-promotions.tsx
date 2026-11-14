import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSaveCustomerPromotions, useSetPromotedProducts, getGetCustomerPromotionsQueryKey } from "@workspace/api-client-react";
import type { CustomerPromotions } from "@workspace/api-client-react";
import { Megaphone, Loader2, AlertTriangle, Clock, PauseCircle, History, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuthGate } from "@/components/auth-gate";
import { errMsg } from "@/lib/format";
import { cn } from "@/lib/utils";

const MIN = 1, MAX = 43200;
const when = (s: string | null | undefined) => s ? new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
function human(m: number) {
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${+(m / 60).toFixed(1)} h`;
  return `${+(m / 1440).toFixed(1)} days`;
}

/** Promotion flags default to false when the server has no entry. */
export function promotedMap(data: CustomerPromotions | undefined) {
  const m = new Map<number, boolean>();
  for (const p of data?.products ?? []) m.set(p.productId, p.enabled);
  return m;
}

export function usePromotionToggle() {
  const set = useSetPromotedProducts();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { requireAuth } = useAuthGate();
  const [busyIds, setBusyIds] = useState<number[]>([]);
  const toggle = (productIds: number[], enabled: boolean, label: string) => {
    if (!productIds.length || !requireAuth("change promotions")) return;
    setBusyIds(b => [...b, ...productIds]);
    set.mutate({ data: { productIds, enabled } }, {
      onSuccess: (res) => {
        qc.setQueryData(getGetCustomerPromotionsQueryKey(), res);
        qc.invalidateQueries({ queryKey: getGetCustomerPromotionsQueryKey() });
        toast({ title: enabled ? "Added to promotions" : "Removed from promotions", description: label });
      },
      onError: (e) => toast({ variant: "destructive", title: "Promotion change failed", description: errMsg(e) }),
      onSettled: () => setBusyIds(b => b.filter(id => !productIds.includes(id))),
    });
  };
  return { toggle, busy: (ids: number[]) => ids.some(id => busyIds.includes(id)) };
}

export function PromoToggle({ on, mixed, count, busy, onClick, testId, disabled }: {
  on: boolean; mixed?: boolean; count?: string; busy: boolean; onClick: () => void; testId: string; disabled?: boolean;
}) {
  const label = mixed ? `Promo ${count}` : on ? "Promoted" : "Promote";
  return (
    <button type="button" onClick={e => { e.stopPropagation(); onClick(); }} disabled={busy || disabled} aria-pressed={mixed ? "mixed" : on}
      title={mixed ? "Some options promoted. Click to promote all options." : on ? "Promoted to customers. Click to stop promoting." : "Not promoted. Click to include in customer promotions."}
      data-testid={testId}
      className={cn("inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 font-mono text-[10.5px] font-medium uppercase tracking-wide transition-all active:scale-95 disabled:opacity-60",
        on && !mixed ? "border-primary/40 bg-accent text-accent-foreground" : mixed ? "border-signal/40 bg-signal-soft text-signal" : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground")}>
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : on && !mixed ? <Check className="h-3 w-3" /> : <Megaphone className="h-3 w-3" />}{label}
    </button>
  );
}

function statusLine(d: CustomerPromotions) {
  if (!d.enabled) return { icon: PauseCircle, tone: "text-muted-foreground", text: "Paused. No promotions will be sent until you enable the schedule." };
  if (/^(Paused:|Connect and enable)/.test(d.info)) return { icon: PauseCircle, tone: "text-signal", text: d.info };
  if (/cooldown|Paused before submission/.test(d.info)) return { icon: Clock, tone: "text-signal", text: d.info };
  if (d.eligibleCount === 0) return { icon: AlertTriangle, tone: "text-signal", text: "Enabled, but nothing is eligible. Promote an Active product or option that has stock." };
  if (d.recipientCount === 0) return { icon: AlertTriangle, tone: "text-signal", text: "Enabled, but no customers can receive promotions yet." };
  if (d.rounds.some(r => r.status === "running")) return { icon: Loader2, tone: "text-primary", text: "A round is sending now. The next one is scheduled after it completes." };
  return { icon: Clock, tone: "text-ok", text: d.nextAt ? `Next send around ${when(d.nextAt)}.` : "Waiting for the scheduler to pick the next send." };
}

const roundTone: Record<string, string> = { running: "bg-accent text-accent-foreground", completed: "bg-ok/10 text-ok", stopped: "bg-muted text-muted-foreground" };

export function CustomerPromotionsPanel({ data, isLoading, isError, onRetry }: { data: CustomerPromotions | undefined; isLoading: boolean; isError: boolean; onRetry: () => void }) {
  const save = useSaveCustomerPromotions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { requireAuth } = useAuthGate();
  const [interval, setInterval_] = useState("");
  const dirty = useRef(false);
  const [confirm, setConfirm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Sync from server only while the owner is not editing.
  useEffect(() => { if (data && !dirty.current) setInterval_(String(data.intervalMinutes)); }, [data]);

  const n = Number(interval);
  const valid = /^\d+$/.test(interval.trim()) && n >= MIN && n <= MAX;

  const submit = (enabled: boolean) => {
    if (!data || !requireAuth("change promotion schedule")) return;
    const minutes = valid ? n : data.intervalMinutes;
    save.mutate({ data: { enabled, intervalMinutes: minutes } }, {
      onSuccess: (res) => {
        dirty.current = false;
        setInterval_(String(res.intervalMinutes));
        qc.setQueryData(getGetCustomerPromotionsQueryKey(), res);
        qc.invalidateQueries({ queryKey: getGetCustomerPromotionsQueryKey() });
        setConfirm(false);
        toast({ title: enabled === data.enabled ? "Interval saved" : enabled ? "Promotions enabled" : "Promotions paused", description: `Every ${human(res.intervalMinutes)} after each completed round.` });
      },
      onError: (e) => toast({ variant: "destructive", title: "Could not save schedule", description: errMsg(e) }),
    });
  };

  if (isLoading) return <div className="mb-4 h-28 animate-pulse rounded-xl border bg-card" data-testid="promotions-loading" />;
  if (isError || !data) return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-card px-4 py-3 text-sm" data-testid="promotions-error">
      <span>Customer promotions could not be loaded.</span><Button size="sm" variant="outline" onClick={onRetry} data-testid="button-retry-promotions">Retry</Button>
    </div>
  );

  const s = statusLine(data);
  const SIcon = s.icon;
  const intervalChanged = valid && n !== data.intervalMinutes;
  const deliveriesByRound = new Map<string, typeof data.deliveries>();
  for (const dl of data.deliveries) deliveriesByRound.set(dl.roundId, [...(deliveriesByRound.get(dl.roundId) ?? []), dl]);

  return (
    <section className="rise mb-4 overflow-hidden rounded-xl border bg-card shadow-sm" data-testid="panel-customer-promotions">
      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <span className={cn("grid h-8 w-8 place-items-center rounded-lg", data.enabled ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}><Megaphone className="h-4 w-4" /></span>
            <div>
              <h2 className="font-display text-base font-semibold leading-tight">Customer promotions</h2>
              <p className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground" data-testid="text-promotions-state">{data.enabled ? "Schedule on" : "Schedule off"} · shop bot only</p>
            </div>
          </div>
          <p className={cn("flex items-start gap-1.5 text-sm", s.tone)} data-testid="text-promotions-status"><SIcon className={cn("mt-0.5 h-4 w-4 shrink-0", SIcon === Loader2 && "animate-spin")} />{s.text}</p>
          {data.info && <p className="text-xs text-muted-foreground" data-testid="text-promotions-info">{data.info}</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
            <span data-testid="text-eligible-count"><b className="tabular">{data.eligibleCount}</b> <span className="text-muted-foreground">eligible items</span></span>
            <span data-testid="text-recipient-count"><b className="tabular">{data.recipientCount}</b> <span className="text-muted-foreground">reachable customers</span></span>
          </div>
          <p className="text-xs text-muted-foreground">Each round, the shop bot sends one random promoted item (Active, in stock) to its existing customers. This is separate from the Advertising page and your personal account. Customers can unsubscribe from the promotion card or with <code className="font-mono">/promotions_off</code>, and resubscribe with <code className="font-mono">/promotions_on</code>. Existing new-product and restock alerts are unchanged.</p>
        </div>

        <div className="w-full space-y-2 rounded-lg border bg-muted/30 p-3 lg:w-72">
          <label htmlFor="promo-interval" className="text-xs font-medium">Interval (whole minutes)</label>
          <div className="flex gap-2">
            <Input id="promo-interval" inputMode="numeric" type="number" min={MIN} max={MAX} step={1} value={interval} disabled={save.isPending}
              onChange={e => { dirty.current = true; setInterval_(e.target.value); }} className="h-9 font-mono" aria-invalid={!valid} data-testid="input-promotion-interval" />
            <Button size="sm" variant="outline" className="h-9" disabled={!intervalChanged || save.isPending} onClick={() => submit(data.enabled)} data-testid="button-save-interval">Save</Button>
          </div>
          <p className={cn("text-[11px]", valid ? "text-muted-foreground" : "text-destructive")} data-testid="text-interval-hint">
            {valid ? `${human(n)} after each completed round. Changes apply to the next scheduled send.` : `Enter a whole number from ${MIN} to ${MAX} (30 days).`}
          </p>
          {data.enabled ? (
            <Button variant="outline" className="w-full" disabled={save.isPending} onClick={() => submit(false)} data-testid="button-disable-promotions">
              {save.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <PauseCircle className="mr-1.5 h-4 w-4" />}Pause promotions</Button>
          ) : (
            <Button className="w-full" disabled={save.isPending || !valid} onClick={() => requireAuth("enable promotions") && setConfirm(true)} data-testid="button-enable-promotions">
              <Megaphone className="mr-1.5 h-4 w-4" />Enable promotions</Button>
          )}
          {data.enabled && <p className="text-[11px] text-muted-foreground">A message already submitted to Telegram can still finish after you pause.</p>}
        </div>
      </div>

      <div className="border-t border-border/70">
        <button type="button" onClick={() => setShowHistory(v => !v)} className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground" data-testid="button-toggle-promotion-history">
          <History className="h-3.5 w-3.5" />Round history · {data.rounds.length}<span className="ml-auto">{showHistory ? "Hide" : "Show"}</span>
        </button>
        {showHistory && (
          <div className="dashboard-scroll max-h-72 border-t border-border/60 px-4 py-3" tabIndex={0} role="region" aria-label="Promotion round history" data-testid="scroll-promotion-history">
            <p className="mb-2 text-[11px] text-muted-foreground">Uncertain means Telegram may or may not have delivered it. Uncertain sends are not retried automatically, to avoid duplicates. History keeps 10 recent rounds and up to 2,000 closed-round delivery details; round totals are preserved. Backups include recent promotion history as space allows, never at the expense of shop data.</p>
            {!data.rounds.length ? <p className="py-4 text-center text-sm text-muted-foreground" data-testid="text-no-rounds">No rounds yet.</p> : (
              <ul className="space-y-2">
                {data.rounds.map(r => {
                  const dls = deliveriesByRound.get(r.id) ?? [];
                  return <li key={r.id} className="rounded-lg border bg-background/60 p-2.5 text-xs" data-testid={`row-round-${r.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("rounded-full px-2 py-px font-mono text-[10px] uppercase", roundTone[r.status])}>{r.status}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{r.productName || "No product"}</span>
                      <span className="font-mono text-muted-foreground">{when(r.createdAt)}{r.completedAt ? ` → ${when(r.completedAt)}` : ""}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 font-mono tabular">
                      <span className="text-ok">{r.sent} sent</span><span className={r.failed ? "text-destructive" : "text-muted-foreground"}>{r.failed} failed</span>
                      <span className={r.uncertain ? "text-signal" : "text-muted-foreground"}>{r.uncertain} uncertain</span><span className="text-muted-foreground">{r.skipped} skipped</span>
                    </div>
                    {r.info && <p className="mt-1 text-muted-foreground">{r.info}</p>}
                    {dls.length > 0 && <details className="mt-1"><summary className="cursor-pointer text-muted-foreground" data-testid={`button-deliveries-${r.id}`}>{dls.length} delivery issues/attempts</summary>
                      <ul className="mt-1 space-y-0.5 font-mono text-[11px]">{dls.map(dl => <li key={dl.id} data-testid={`row-delivery-${dl.id}`}>{dl.status} · {dl.attempts} attempt{dl.attempts === 1 ? "" : "s"} · {when(dl.updatedAt)}{dl.error ? ` · ${dl.error}` : ""}</li>)}</ul></details>}
                  </li>;
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start sending promotions to customers?</AlertDialogTitle>
            <AlertDialogDescription asChild><div className="space-y-2 text-sm text-muted-foreground">
              <p>The shop bot will message its <b>{data.recipientCount}</b> reachable customers about one random promoted item, then repeat {human(valid ? n : data.intervalMinutes)} after each completed round.</p>
              <p>Sent Telegram messages cannot be recalled. Pausing stops new sends, but a message already submitted to Telegram can still finish afterwards.</p>
              <p>Customers can opt out from the card or with /promotions_off.</p>
            </div></AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel data-testid="button-cancel-enable-promotions">Not now</AlertDialogCancel>
            <AlertDialogAction disabled={save.isPending} onClick={e => { e.preventDefault(); submit(true); }} data-testid="button-confirm-enable-promotions">
              {save.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Yes, enable sending</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
