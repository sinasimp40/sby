import { useRef, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  usePreviewAdvertisingMembership, useStartAdvertisingMembership, useStopAdvertisingMembership,
  getGetAdvertisingWorkspaceQueryKey, type AdvertisingMembershipPreview, type AdvertisingWorkspace,
} from "@workspace/api-client-react";
import { FileUp, Loader2, Users, Square } from "lucide-react";
import { Panel } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { errMsg } from "@/lib/format";

export function MembershipPanel({ ws }: { ws: AdvertisingWorkspace }) {
  // Parent keys this by account identity; no preview can survive account changes.
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<AdvertisingMembershipPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const confirmation = useRef<{ signature: string; key: string } | null>(null);
  const read = usePreviewAdvertisingMembership();
  const start = useStartAdvertisingMembership();
  const stop = useStopAdvertisingMembership();
  const qc = useQueryClient();
  const busy = read.isPending || start.isPending || stop.isPending;
  const ready = ws.account.connected && !ws.account.login && !!ws.account.accountId;
  const jobs = ws.membershipJobs ?? [];
  const pendingJoins = jobs.filter(job => job.action === "join" && job.status === "pending").length;
  const chosen = (preview?.rows ?? []).filter(row => row.canJoin && selected.has(row.target));
  const sync = async (next: AdvertisingWorkspace) => {
    qc.setQueryData(getGetAdvertisingWorkspaceQueryKey(), next);
    await qc.invalidateQueries({ queryKey: getGetAdvertisingWorkspaceQueryKey() });
  };
  const resetPreview = () => { setPreview(null); setConfirmed(false); setSelected(new Set()); confirmation.current = null; };
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const uploadFile = event.target.files?.[0]; event.target.value = "";
    if (!uploadFile) return;
    setError(""); resetPreview();
    if (!/\.txt$/i.test(uploadFile.name) || uploadFile.size > 65536) { setError("Choose a UTF-8 .txt file up to 64 KB, with at most 50 links per join batch."); return; }
    try { setText(await uploadFile.text()); } catch { setError("The file could not be read."); }
  }
  async function inspect() {
    setError(""); resetPreview();
    try {
      const result = await read.mutateAsync({ data: { text } });
      if (result.accountId !== ws.account.accountId) throw new Error("Account changed. Preview again.");
      setPreview(result);
      setSelected(new Set(result.rows.filter(row => row.canJoin && !["removed", "already_joined"].includes(row.state)).map(row => row.target)));
    } catch (cause) { setError(errMsg(cause)); }
  }
  async function join() {
    if (!preview || !confirmed || !chosen.length) return;
    setError("");
    const data = { accountId: preview.accountId, targets: chosen.map(row => ({ target: row.target, chatId: row.chatId })),
      restoreTargets: chosen.filter(row => row.state === "removed").map(row => row.target), confirmed: true };
    const signature = JSON.stringify(data);
    if (confirmation.current?.signature !== signature) confirmation.current = { signature, key: crypto.randomUUID() };
    try {
      await sync(await start.mutateAsync({ data: { ...data, idempotencyKey: confirmation.current.key } }));
      setText(""); resetPreview();
    } catch (cause) { setError(errMsg(cause)); }
  }
  return <Panel title="Join groups from .txt" meta="personal account only">
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">Preview up to 50 public usernames or invite links per batch. Joining changes your Telegram memberships and may submit approval requests. It never sends an advertisement or starts a campaign. Telegram waits are respected.</p>
      <Textarea rows={3} value={text} disabled={busy} maxLength={65536}
        onChange={event => { setText(event.target.value); resetPreview(); }}
        placeholder={"@publicgroup\nhttps://t.me/+inviteLink"} data-testid="input-membership-links" />
      <input ref={file} type="file" accept=".txt,text/plain" disabled={busy} onChange={upload} className="hidden" data-testid="input-membership-file" />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => file.current?.click()} data-testid="button-membership-file"><FileUp className="mr-1 h-3.5 w-3.5" />Upload .txt to join</Button>
        <Button size="sm" disabled={!ready || !text.trim() || busy} onClick={inspect} data-testid="button-membership-preview">
          {read.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Preview membership
        </Button>
        <Button size="sm" variant="outline" disabled={!pendingJoins || busy} onClick={async () => {
          setError(""); try { await sync(await stop.mutateAsync()); } catch (cause) { setError(errMsg(cause)); }
        }} data-testid="button-membership-stop"><Square className="mr-1 h-3.5 w-3.5" />Stop pending joins</Button>
      </div>
      {!ready && <p className="text-xs text-muted-foreground">Connect and verify your advertising account to preview or join.</p>}
      {error && <p role="alert" className="text-sm text-destructive" data-testid="error-membership">{error}</p>}
      {preview && <div className="space-y-3 rounded-lg border p-3" data-testid="panel-membership-preview">
        <ul className="dashboard-scroll divide-y" tabIndex={0} aria-label="Group join preview" data-testid="scroll-membership-preview">
          {[...preview.rows].sort((a, b) => (a.title || a.target).localeCompare(b.title || b.target, undefined, { sensitivity: "base", numeric: true })).map((row, i) =>
            <li key={`${row.target}-${i}`} className="flex gap-2 py-2">
              <Checkbox checked={selected.has(row.target) && row.canJoin} disabled={!row.canJoin || busy}
                aria-label={`${row.state === "removed" ? "Restore and join" : "Select"} ${row.title || row.target}`}
                data-testid={`checkbox-membership-${i}`} onCheckedChange={value => {
                  setConfirmed(false);
                  setSelected(previous => { const next = new Set(previous); if (value === true) next.add(row.target); else next.delete(row.target); return next; });
                }} />
              <div className="min-w-0 flex-1 text-xs">
                <div className="break-all font-medium">{row.title || row.target} · {row.state.replaceAll("_", " ")}</div>
                <div className="break-all text-muted-foreground">{row.target}</div>
                <div className={row.state === "removed" ? "text-destructive" : "text-muted-foreground"}>{row.note}</div>
              </div>
            </li>)}
        </ul>
        <label className="flex items-start gap-2 text-xs">
          <Checkbox checked={confirmed} disabled={busy} onCheckedChange={value => setConfirmed(value === true)} data-testid="checkbox-confirm-membership" />
          <span>I authorize this account to join the {chosen.length} selected destinations, including restoring any removed groups I explicitly selected. No advertisements will be sent.</span>
        </label>
        <Button size="sm" disabled={!confirmed || !chosen.length || busy || preview.accountId !== ws.account.accountId || !ready}
          onClick={join} data-testid="button-membership-start">{start.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Users className="mr-1 h-3.5 w-3.5" />}Join selected groups</Button>
      </div>}
      <div className="rounded-md border bg-muted/25 p-3 text-xs text-muted-foreground">Confirmed destination or permission failures and UNCERTAIN posts remove that destination and queue leaving. Successful groups are untouched. UNCERTAIN posts are never retried. Account, network or source-message errors without an uncertain post do not trigger leaving. Leaving waits for the verified account and Telegram-required delays; check the result below. Leaving a private group can require a new invitation to return.</div>
      {!!jobs.length && <div data-testid="panel-membership-activity">
        <h3 className="mb-2 text-sm font-medium">Membership activity · {pendingJoins} joins waiting</h3>
        <p className="mb-2 text-xs text-muted-foreground">Stop affects joins not yet started. One in-flight action may finish. Awaiting approval only checks membership; it never submits the request again.</p>
        <ul className="dashboard-scroll divide-y rounded-md border" tabIndex={0} aria-label="Group leave and join results" data-testid="scroll-membership-results">
          {jobs.map(job => <li key={job.id} className="px-3 py-2 text-xs" data-testid={`membership-job-${job.id}`}>
            <div className="break-all font-medium">{job.title || job.target} · {job.action} · {job.status.replaceAll("_", " ")}</div>
            <div className="break-all text-muted-foreground">{job.note}</div>
          </li>)}
        </ul>
      </div>}
    </div>
  </Panel>;
}
