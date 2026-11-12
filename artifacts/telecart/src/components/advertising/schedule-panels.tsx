import { useEffect, useMemo, useRef, useState } from "react";
import {
  useStartAdvertisingAccountSchedules, useStopAdvertisingAccountSchedules, useStopAllAdvertisingAccountSchedules,
  useSaveAdvertisingDraft, type AdvertisingWorkspace, type AdvertisingGroup, type AdvertisingDraft,
} from "@workspace/api-client-react";
import { Loader2, Play, Square, OctagonX, Activity } from "lucide-react";
import { Panel, EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { errMsg, dateTime } from "@/lib/format";
import { MessagePreview, Tag, fmtInterval, useWorkspaceSync, type DraftState } from "@/components/advertising-panels";

export function ScheduleBar({ ws, selected, problem, onStart }: { ws: AdvertisingWorkspace; selected: Set<string>; problem: string; onStart: () => void }) {
  const sync = useWorkspaceSync();
  const { toast } = useToast();
  const stop = useStopAdvertisingAccountSchedules();
  const stopAll = useStopAllAdvertisingAccountSchedules();
  const [confirmAll, setConfirmAll] = useState(false);
  const sel = ws.groups.filter(g => selected.has(g.id));
  const startable = sel.filter(g => g.enabled && g.status === "ready");
  const selRunning = sel.filter(g => g.running);
  const running = ws.groups.filter(g => g.running);
  const outsideRunning = running.filter(g => !selected.has(g.id)).length;
  const reason = ws.account.login ? "Finish or cancel account sign-in before starting." : !ws.account.connected ? "Connect your Telegram account first." : !sel.length ? "Select groups below." : !startable.length ? "None of the selected groups are ready and enabled." : problem;
  return (
    <div className="mb-5 rounded-xl border bg-card p-4" data-testid="panel-schedule-bar">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-wider">
        <span data-testid="text-scope-selected"><b className="text-foreground">{sel.length}</b> <span className="text-muted-foreground">selected</span></span>
        <span data-testid="text-scope-startable"><b className="text-foreground">{startable.length}</b> <span className="text-muted-foreground">ready to start</span></span>
        <span data-testid="text-scope-selected-running"><b className="text-primary">{selRunning.length}</b> <span className="text-muted-foreground">selected running</span></span>
        <span data-testid="text-running-count"><b className="text-primary">{running.length}</b> <span className="text-muted-foreground">running in total</span></span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={!!reason} onClick={onStart} data-testid="button-open-start"><Play className="mr-1.5 h-4 w-4" />Start {startable.length} selected</Button>
        <Button variant="outline" disabled={!selRunning.length || stop.isPending} onClick={async () => { try { sync(await stop.mutateAsync({ data: { groupIds: selRunning.map(g => g.id) } })); toast({ title: `${selRunning.length} schedules stopped` }); } catch (x) { toast({ title: "Stop failed", description: errMsg(x), variant: "destructive" }); } }} data-testid="button-stop-selected">{stop.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Square className="mr-1.5 h-4 w-4" />}Stop {selRunning.length} selected</Button>
        <Button variant="ghost" className="text-destructive sm:ml-auto" disabled={!running.length || stopAll.isPending} onClick={() => setConfirmAll(true)} data-testid="button-stop-all">{stopAll.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <OctagonX className="mr-1.5 h-4 w-4" />}Stop all ({running.length})</Button>
      </div>
      {reason && sel.length > 0 && <p className="mt-2 text-xs text-signal" data-testid="text-start-blocked">{reason}</p>}
      {outsideRunning > 0 && <p className="mt-2 text-xs text-muted-foreground" data-testid="text-outside-running">{outsideRunning} unselected {outsideRunning === 1 ? "group keeps" : "groups keep"} running. Selection never starts or stops anything on its own; use Stop all to halt everything.</p>}
      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Stop all {running.length} schedules?</AlertDialogTitle><AlertDialogDescription>No further posts are sent to any group. A post already being sent may still arrive. Your account stays connected.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep running</AlertDialogCancel><AlertDialogAction data-testid="button-confirm-stop-all" onClick={async () => { try { sync(await stopAll.mutateAsync()); toast({ title: "All schedules stopped" }); } catch (x) { toast({ title: "Stop failed", description: errMsg(x), variant: "destructive" }); } }}>Stop all</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type Snapshot = { accountId: string; accountName: string; draft: AdvertisingDraft; preview: DraftState; groups: AdvertisingGroup[] };

export function StartDialog({ open, onOpenChange, ws, d, toDraft, selected, onStarted }: { open: boolean; onOpenChange: (o: boolean) => void; ws: AdvertisingWorkspace; d: DraftState; toDraft: (d: DraftState) => AdvertisingDraft; selected: Set<string>; onStarted: (fp: string) => void }) {
  const sync = useWorkspaceSync();
  const save = useSaveAdvertisingDraft();
  const start = useStartAdvertisingAccountSchedules({ mutation: { gcTime: 0 } });
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState("");
  const keyRef = useRef<{ sig: string; key: string } | null>(null);
  const busyRef = useRef(false);
  const wsRef = useRef(ws); wsRef.current = ws;
  const dRef = useRef(d); dRef.current = d;
  const selRef = useRef(selected); selRef.current = selected;
  const fnRef = useRef(toDraft); fnRef.current = toDraft;
  useEffect(() => {
    if (!open) return;
    const w = wsRef.current;
    setSnap({ accountId: w.account.accountId ?? "", accountName: w.account.username ? `@${w.account.username}` : w.account.displayName,
      draft: fnRef.current(dRef.current), preview: { ...dRef.current }, groups: w.groups.filter(g => selRef.current.has(g.id) && g.enabled && g.status === "ready" && g.chatId) });
    setOk(false); setErr("");
  }, [open]);
  const sig = useMemo(() => snap ? JSON.stringify([snap.accountId, snap.draft, snap.groups.map(g => [g.id, g.chatId, g.intervalSeconds])]) : "", [snap]);
  const busy = save.isPending || start.isPending;
  async function go() {
    if (!snap || busyRef.current) return;
    busyRef.current = true; setErr("");
    try {
      if (!keyRef.current || keyRef.current.sig !== sig) keyRef.current = { sig, key: crypto.randomUUID() };
      const fp = JSON.stringify(snap.draft);
      sync(await save.mutateAsync({ data: snap.draft }));
      sync(await start.mutateAsync({ data: { accountId: snap.accountId, groupIds: snap.groups.map(g => g.id),
        expectedGroups: snap.groups.map(g => ({ id: g.id, chatId: g.chatId!, intervalSeconds: g.intervalSeconds })),
        draft: snap.draft, permissionConfirmed: true, idempotencyKey: keyRef.current.key } }));
      keyRef.current = null;
      onStarted(fp);
      onOpenChange(false);
    } catch (x) { setErr(errMsg(x)); }
    finally { start.reset(); busyRef.current = false; }
  }
  const alreadyRunning = snap?.groups.filter(g => g.running).length ?? 0;
  return (
    <Dialog open={open} onOpenChange={o => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Start recurring posts</DialogTitle><DialogDescription>This exact message is frozen and posted from your account to each group below, repeating at that group's interval until you stop it.</DialogDescription></DialogHeader>
        {snap && <div className="grid gap-4 sm:grid-cols-2">
          <MessagePreview d={snap.preview} />
          <div className="min-w-0">
            <p className="mb-2 text-xs font-medium">Posting as {snap.accountName}</p>
            <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground" data-testid="text-start-count">{snap.groups.length} groups</div>
            <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">{snap.groups.map(g => <li key={g.id} className="flex items-center gap-2" data-testid={`row-start-group-${g.id}`}><span className="min-w-0 flex-1 truncate font-mono">{g.title || g.target}</span><span className="shrink-0 font-mono text-muted-foreground">every {fmtInterval(g.intervalSeconds)}</span></li>)}</ul>
          </div>
        </div>}
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
          <li>The first post can go out immediately.</li>
          <li>Posting continues indefinitely until you press Stop or Stop all.</li>
          <li>Missed posts during downtime are not caught up; the schedule resumes from the next slot.</li>
          <li>Later edits to the message do not change running schedules. Stop and start the selected groups to apply them.</li>
          <li>An uncertain result stops that group for your review. Nothing is retried automatically.</li>
          {alreadyRunning > 0 && <li className="text-signal">{alreadyRunning} of these are already running and will switch to this snapshot.</li>}
        </ul>
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={ok} onCheckedChange={v => setOk(v === true)} data-testid="checkbox-start-permission" /><span>I have permission to post this advertisement repeatedly in every group listed.</span></label>
        {err && <p role="alert" className="text-sm text-destructive" data-testid="error-start">{err} Retrying reuses the same request, so nothing is started twice.</p>}
        <DialogFooter><Button disabled={!ok || busy || !snap?.groups.length || !ws.account.connected} onClick={go} data-testid="button-confirm-start">{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}{err ? "Retry start" : `Start ${snap?.groups.length ?? 0} schedules`}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RunsPanel({ ws }: { ws: AdvertisingWorkspace }) {
  const runs = [...ws.accountRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 60);
  const uncertain = ws.accountRuns.filter(r => r.status === "uncertain").length;
  return (
    <Panel title="Posting activity" meta={<span data-testid="text-run-count">{ws.accountRuns.length} posts</span>}>
      {uncertain > 0 && <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="banner-uncertain">{uncertain} uncertain {uncertain === 1 ? "result" : "results"}: Telegram may have posted. Those groups are stopped until you check them and start again. No automatic retry.</p>}
      {runs.length === 0 ? <EmptyState icon={Activity} title="No posts yet" body="Each scheduled post appears here with its outcome." /> :
        <ul className="divide-y rounded-lg border">{runs.map(r => (
          <li key={r.id} className="p-3" data-testid={`row-run-${r.id}`}>
            <div className="flex flex-wrap items-center gap-2"><Tag s={r.status} testId={`status-run-${r.id}`} /><span className="min-w-0 flex-1 truncate font-mono text-xs">{r.target}</span><span className="text-[11px] text-muted-foreground">{dateTime(r.sentAt ?? r.startedAt)}</span></div>
            {r.note && <div className="mt-1 text-xs text-muted-foreground">{r.note}</div>}
          </li>
        ))}</ul>}
    </Panel>
  );
}
