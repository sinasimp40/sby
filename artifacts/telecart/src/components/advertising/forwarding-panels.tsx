import { useEffect, useMemo, useRef, useState } from "react";
import { useStartAdvertisingForwardLoop, useStopAllAdvertisingAccountSchedules, type AdvertisingWorkspace, type AdvertisingGroup, type AdvertisingSavedMessage } from "@workspace/api-client-react";
import { Loader2, Play, OctagonX, Repeat, ArrowDown, AlertTriangle } from "lucide-react";
import { Panel } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { errMsg, dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fmtInterval, useWorkspaceSync } from "@/components/advertising-panels";
import { SavedMessageCard } from "./saved-message-picker";

export type IntervalUnit = "m" | "h";
export const unitSec = (u: IntervalUnit) => (u === "m" ? 60 : 3600);
export const toSeconds = (v: string, u: IntervalUnit) => Math.round(Number(v) * unitSec(u));
export const intervalOk = (s: number) => Number.isInteger(s) && s >= 60 && s <= 2592000;
export const splitInterval = (s: number): [string, IntervalUnit] => (s % 3600 === 0 ? [String(s / 3600), "h"] : [String(Math.max(1, Math.round(s / 60))), "m"]);

/** Groups eligible for the queue, in displayed (workspace) order. */
export const queueGroups = (ws: AdvertisingWorkspace, selected: Set<string>) => ws.groups.filter(g => selected.has(g.id) && g.enabled && g.status === "ready" && !!g.chatId);
export const legacyRunning = (ws: AdvertisingWorkspace) => ws.forwarding?.running ? ws.groups.filter(g => g.running && !ws.forwarding!.groupIds.includes(g.id)) : ws.groups.filter(g => g.running);

export function IntervalPanel({ value, unit, onChange }: { value: string; unit: IntervalUnit; onChange: (v: string, u: IntervalUnit) => void }) {
  const sec = toSeconds(value, unit);
  const bad = !!value && !intervalOk(sec);
  return (
    <Panel title="Shared delay" meta="one timer for the whole queue">
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input type="number" min={1} step={1} value={value} onChange={e => onChange(e.target.value, unit)} className="max-w-[140px] font-mono" aria-label="Delay between groups" data-testid="input-shared-interval" />
          <div className="flex gap-1 rounded-md bg-muted p-1">{(["m", "h"] as const).map(u => <button key={u} type="button" onClick={() => onChange(value, u)} className={cn("rounded px-3 font-mono text-xs", unit === u ? "bg-ink text-white" : "text-muted-foreground hover:text-foreground")} data-testid={`button-shared-unit-${u}`}>{u === "m" ? "minutes" : "hours"}</button>)}</div>
        </div>
        {bad ? <p className="text-sm text-destructive" data-testid="error-shared-interval">Choose between 1 minute and 720 hours (30 days), in whole seconds.</p>
          : <p className="text-xs text-muted-foreground">Group 1, wait {value && intervalOk(sec) ? fmtInterval(sec) : "..."}, group 2, wait, and so on. After the last group the queue starts again from the top.</p>}
      </div>
    </Panel>
  );
}

export function ForwardingStatus({ ws }: { ws: AdvertisingWorkspace }) {
  const sync = useWorkspaceSync();
  const { toast } = useToast();
  const stopAll = useStopAllAdvertisingAccountSchedules();
  const [confirm, setConfirm] = useState(false);
  const f = ws.forwarding;
  const legacy = legacyRunning(ws);
  const active = !!f?.running || legacy.length > 0;
  const waiting = !!f?.running && (!ws.account.connected || !!ws.account.login);
  const next = f?.nextGroupId ? ws.groups.find(g => g.id === f.nextGroupId) : null;
  const pos = f?.nextGroupId ? f.groupIds.indexOf(f.nextGroupId) + 1 : 0;
  return (
    <div className="mb-5 overflow-hidden rounded-xl border bg-card" data-testid="panel-forwarding-status">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
        <span className={cn("inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-wider", f?.running ? "text-primary" : "text-muted-foreground")} data-testid="status-forwarding">
          <span className={cn("h-2 w-2 rounded-full", f?.running ? "animate-pulse bg-primary" : "bg-muted-foreground/40")} />{waiting ? "Waiting for connection" : f?.running ? "Forwarding" : "Stopped"}
        </span>
        {f?.running && <>
          <span className="text-xs"><span className="text-muted-foreground">Next </span><b data-testid="text-forward-next-group">{next ? next.title || next.target : "-"}</b>{pos > 0 && <span className="font-mono text-muted-foreground"> ({pos}/{f.groupIds.length})</span>}</span>
          <span className="text-xs"><span className="text-muted-foreground">at </span><b className="font-mono" data-testid="text-forward-next-at">{f.nextSendAt ? dateTime(f.nextSendAt) : "now"}</b></span>
          <span className="text-xs"><span className="text-muted-foreground">delay </span><b className="font-mono">{fmtInterval(f.intervalSeconds)}</b></span>
        </>}
        <Button variant="ghost" className="ml-auto text-destructive" disabled={!active || stopAll.isPending} onClick={() => setConfirm(true)} data-testid="button-stop-all">{stopAll.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <OctagonX className="mr-1.5 h-4 w-4" />}Stop all</Button>
      </div>
      {f?.running && f.source && <div className="border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground" data-testid="text-forward-source">Forwarding Saved Message #{f.source.id}{f.source.text ? `: ${f.source.text.slice(0, 80)}${f.source.text.length > 80 ? "..." : ""}` : ""}</div>}
      {legacy.length > 0 && <p className="flex items-start gap-2 border-t border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900" data-testid="banner-legacy-running"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{legacy.length} older editor-based {legacy.length === 1 ? "schedule is" : "schedules are"} still running from the previous workflow. Stop all halts them; starting a new forward replaces them. This page never starts them again.</p>}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Stop all advertising?</AlertDialogTitle><AlertDialogDescription>Stops the forwarding queue{legacy.length ? ` and ${legacy.length} older schedule${legacy.length === 1 ? "" : "s"}` : ""}. A forward already in flight may still arrive. Nothing resumes on its own; your account stays connected.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep running</AlertDialogCancel><AlertDialogAction data-testid="button-confirm-stop-all" onClick={async () => { try { sync(await stopAll.mutateAsync()); toast({ title: "All advertising stopped" }); } catch (x) { toast({ title: "Stop failed", description: errMsg(x), variant: "destructive" }); } }}>Stop all</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type Frozen = { accountId: string; accountName: string; source: AdvertisingSavedMessage; groups: AdvertisingGroup[]; intervalSeconds: number };

export function ForwardStartDialog({ open, onOpenChange, ws, source, selected, intervalSeconds }: { open: boolean; onOpenChange: (o: boolean) => void; ws: AdvertisingWorkspace; source: AdvertisingSavedMessage | null; selected: Set<string>; intervalSeconds: number }) {
  const sync = useWorkspaceSync();
  const { toast } = useToast();
  const start = useStartAdvertisingForwardLoop({ mutation: { gcTime: 0 } });
  const [snap, setSnap] = useState<Frozen | null>(null);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState("");
  const keyRef = useRef<{ sig: string; key: string } | null>(null);
  const busyRef = useRef(false);
  const live = useRef({ ws, source, selected, intervalSeconds }); live.current = { ws, source, selected, intervalSeconds };
  useEffect(() => {
    if (!open) return;
    const { ws: w, source: s, selected: sel, intervalSeconds: iv } = live.current;
    setSnap(s && w.account.accountId ? { accountId: w.account.accountId, accountName: w.account.username ? `@${w.account.username}` : w.account.displayName, source: s, groups: queueGroups(w, sel), intervalSeconds: iv } : null);
    setOk(false); setErr("");
  }, [open]);
  const sig = useMemo(() => snap ? JSON.stringify([snap.accountId, snap.source.id, snap.source.fingerprint, snap.groups.map(g => [g.id, g.chatId]), snap.intervalSeconds]) : "", [snap]);
  const legacy = legacyRunning(ws).length;
  const sourceOk = !!snap && snap.source.accountId === snap.accountId && snap.source.canForward && ws.account.accountId === snap.accountId;
  async function go() {
    if (!snap || busyRef.current || !sourceOk) return;
    busyRef.current = true; setErr("");
    try {
      if (!keyRef.current || keyRef.current.sig !== sig) keyRef.current = { sig, key: crypto.randomUUID() };
      sync(await start.mutateAsync({ data: { accountId: snap.accountId, messageId: snap.source.id, sourceFingerprint: snap.source.fingerprint, groupIds: snap.groups.map(g => g.id),
        expectedGroups: snap.groups.map(g => ({ id: g.id, chatId: g.chatId! })), intervalSeconds: snap.intervalSeconds, permissionConfirmed: true, idempotencyKey: keyRef.current.key } }));
      keyRef.current = null;
      toast({ title: "Forwarding started", description: `${snap.groups.length} groups, ${fmtInterval(snap.intervalSeconds)} apart.` });
      onOpenChange(false);
    } catch (x) { setErr(errMsg(x)); }
    finally { start.reset(); busyRef.current = false; }
  }
  const busy = start.isPending;
  return (
    <Dialog open={open} onOpenChange={o => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Start forwarding queue</DialogTitle><DialogDescription>This exact Saved Message, group order and delay are frozen now. Edits on the page after this point do not change this request.</DialogDescription></DialogHeader>
        {snap && <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <div className="rounded-lg border bg-muted/30 p-3"><div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Original message, forwarded as is</div><SavedMessageCard m={snap.source} /></div>
            <p className="text-xs text-muted-foreground">Forwarded as {snap.accountName}. Media, formatting and custom emoji come from the original in Telegram.</p>
          </div>
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground" data-testid="text-start-count"><Repeat className="h-3 w-3" />{snap.groups.length} groups · {fmtInterval(snap.intervalSeconds)} apart</div>
            <ol className="max-h-72 overflow-y-auto rounded-md border p-2 text-xs">{snap.groups.map((g, i) => <li key={g.id} data-testid={`row-start-group-${g.id}`}>
              <div className="flex items-center gap-2 py-1"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink font-mono text-[10px] text-white">{i + 1}</span><span className="min-w-0 flex-1 truncate font-mono">{g.title || g.target}</span></div>
              {i < snap.groups.length - 1 && <div className="flex items-center gap-1 pl-1.5 text-[10px] text-muted-foreground"><ArrowDown className="h-3 w-3" />wait {fmtInterval(snap.intervalSeconds)}</div>}
            </li>)}
              <li className="mt-1 flex items-center gap-1 border-t pt-1 text-[10px] text-muted-foreground"><Repeat className="h-3 w-3" />wait {fmtInterval(snap.intervalSeconds)}, then back to 1</li></ol>
          </div>
        </div>}
        {!snap && <p className="text-sm text-destructive">Select a source message and connect the account first.</p>}
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
          <li>The first forward may happen immediately.</li>
          <li>The queue repeats until you press Stop all. Stopped or imported queues never restart automatically.</li>
          <li>Starting replaces any existing schedules on this account{legacy > 0 ? `, including ${legacy} older editor-based schedule${legacy === 1 ? "" : "s"}` : ""}.</li>
          <li>Telegram forwarding restrictions still apply. Groups that block forwards or links may reject it.</li>
        </ul>
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={ok} onCheckedChange={v => setOk(v === true)} data-testid="checkbox-start-permission" /><span>I have permission to repeatedly forward this message in every group listed.</span></label>
        {err && <p role="alert" className="text-sm text-destructive" data-testid="error-start">{err} Retrying reuses the same request, so nothing starts twice.</p>}
        <DialogFooter><Button disabled={!ok || busy || !snap?.groups.length || !sourceOk || !ws.account.connected || !!ws.account.login || !intervalOk(snap?.intervalSeconds ?? 0)} onClick={go} data-testid="button-confirm-start">{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}{err ? "Retry start" : `Start queue of ${snap?.groups.length ?? 0}`}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
