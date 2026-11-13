import { useRef, useState } from "react";
import { useResumeAdvertisingCampaign, type AdvertisingResume, type AdvertisingWorkspace } from "@workspace/api-client-react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useWorkspaceSync, fmtInterval } from "@/components/advertising-panels";
import { errMsg, dateTime } from "@/lib/format";

export function ResumePanel({ ws }: { ws: AdvertisingWorkspace }) {
  const resume = useResumeAdvertisingCampaign({ mutation: { gcTime: 0 } });
  const sync = useWorkspaceSync();
  const [snapshot, setSnapshot] = useState<AdvertisingResume | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const key = useRef<{ signature: string; id: string } | null>(null);
  const inFlight = useRef(false);
  const saved = ws.resume;
  if (!ws.forwarding?.source && !saved?.planId) return null;
  const name = (id: string | null) => {
    const group = ws.groups.find(group => group.id === id);
    return group ? group.title || group.target : id ? "Unavailable group" : "None";
  };
  async function go() {
    if (!snapshot?.planId || !snapshot.accountId || !confirmed || inFlight.current) return;
    inFlight.current = true;
    setError("");
    const signature = `${snapshot.planId}:${snapshot.revision}:${snapshot.accountId}`;
    if (key.current?.signature !== signature) key.current = { signature, id: crypto.randomUUID() };
    try {
      sync(await resume.mutateAsync({ data: { accountId: snapshot.accountId, planId: snapshot.planId,
        revision: snapshot.revision, confirmed: true, idempotencyKey: key.current.id } }));
      setSnapshot(null); key.current = null;
    } catch (cause) { setError(errMsg(cause)); }
    finally { inFlight.current = false; resume.reset(); }
  }
  return <div className="mb-5 rounded-xl border bg-card p-4" data-testid="panel-campaign-resume">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h2 className="text-sm font-semibold">Saved campaign progress</h2>
        {saved?.planId && <>
          <p className="text-xs text-muted-foreground">Next: <b>{name(saved.nextGroupId)}</b> · {saved.groupsSentInInterval}/{saved.groupsPerInterval} groups reached in the saved interval.</p>
          <p className="text-xs text-muted-foreground">{saved.heldGroupIds.length} UNCERTAIN groups excluded; removal and leaving are tracked in membership activity. Resume keeps the saved order and waiting time; it does not restart from group one.</p>
        </>}
        {saved?.reason && <p className="text-xs text-muted-foreground" data-testid="text-resume-blocked">{saved.reason}</p>}
        {!saved?.planId && <p className="text-xs text-muted-foreground">No safe checkpoint exists for this older or imported campaign. Start new once; future pauses can be resumed.</p>}
      </div>
      <Button size="sm" variant="outline" disabled={!saved?.available || resume.isPending} data-testid="button-open-resume" onClick={() => {
        if (!saved) return;
        setSnapshot({ ...saved, groupIds: [...saved.groupIds], heldGroupIds: [...saved.heldGroupIds] });
        setConfirmed(false); setError("");
      }}><Play className="mr-1 h-3.5 w-3.5" />Resume campaign</Button>
    </div>
    <Dialog open={!!snapshot} onOpenChange={open => { if (!open && !inFlight.current) setSnapshot(null); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>Resume saved campaign?</DialogTitle><DialogDescription>Continue this exact campaign with the original Telegram account and unchanged Saved Message. This is not a new campaign.</DialogDescription></DialogHeader>
        {snapshot && <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-2 gap-3 rounded-md border p-3 text-xs">
            <div><dt className="text-muted-foreground">Next group</dt><dd className="break-words font-medium">{name(snapshot.nextGroupId)}</dd></div>
            <div><dt className="text-muted-foreground">Saved interval progress</dt><dd>{snapshot.groupsSentInInterval}/{snapshot.groupsPerInterval} groups</dd></div>
            <div><dt className="text-muted-foreground">Shared delay</dt><dd>{fmtInterval(snapshot.intervalSeconds)}</dd></div>
            <div><dt className="text-muted-foreground">Saved wait deadline</dt><dd>{snapshot.nextSendAt ? dateTime(snapshot.nextSendAt) : "Ready"}</dd></div>
          </dl>
          <p className="text-xs text-muted-foreground">Posting rights are checked before each send. {snapshot.heldGroupIds.length} UNCERTAIN groups are excluded; their removal and account leave are handled separately. Resume never retries their posts. Removed and disabled groups are skipped. Telegram-required waits still apply.</p>
          <p className="text-xs text-muted-foreground">Already visited groups are not sent again before the remaining groups in this cycle. The campaign then repeats normally. Nothing catches up in a burst.</p>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={confirmed} disabled={resume.isPending} onCheckedChange={value => setConfirmed(value === true)} data-testid="checkbox-confirm-resume" />
            <span>I authorize resuming this saved campaign, keeping UNCERTAIN groups excluded.</span>
          </label>
          {error && <p role="alert" className="text-sm text-destructive" data-testid="error-resume">{error}</p>}
        </div>}
        <DialogFooter><Button disabled={!confirmed || resume.isPending || !ws.account.connected || !!ws.account.login ||
          ws.account.accountId !== snapshot?.accountId} onClick={go} data-testid="button-confirm-resume">
          {resume.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{error ? "Retry resume" : "Resume saved campaign"}
        </Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
