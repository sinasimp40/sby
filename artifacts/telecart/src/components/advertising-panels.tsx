import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useConnectAdvertisingBot, useDisconnectAdvertisingBot, useCheckAdvertisingBot, useDiscoverAdvertisingGroups,
  usePreviewAdvertisingGroups, useAddAdvertisingGroups, useCheckAdvertisingGroups, useUpdateAdvertisingGroup,
  useDeleteAdvertisingGroup, useSaveAdvertisingDraft, useStartAdvertisingCampaign, useGetAdvertisingCampaign,
  getGetAdvertisingCampaignQueryKey, getGetAdvertisingWorkspaceQueryKey, useCancelAdvertisingCampaign,
  type AdvertisingWorkspace, type AdvertisingGroup, type AdvertisingImportRow, type AdvertisingDraft,
} from "@workspace/api-client-react";
import { Loader2, PlugZap, RefreshCw, Unplug, FileUp, Search, Trash2, Pencil, ShieldCheck, Send, Ban, Megaphone, Radar, X } from "lucide-react";
import { Panel, EmptyState, ErrorState, RowsSkeleton } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ProductMediaPreview, isProductImageUrl } from "@/components/product-media-preview";
import { useToast } from "@/hooks/use-toast";
import { errMsg, dateTime, ago } from "@/lib/format";
import { cn } from "@/lib/utils";

const WS_KEY = getGetAdvertisingWorkspaceQueryKey();

function useWorkspaceSync() {
  const qc = useQueryClient();
  return (ws?: AdvertisingWorkspace) => {
    if (ws) qc.setQueryData(WS_KEY, ws);
    void qc.invalidateQueries({ queryKey: WS_KEY });
  };
}

const tone: Record<string, string> = {
  ready: "bg-ok/10 text-ok border-ok/25", sent: "bg-ok/10 text-ok border-ok/25", completed: "bg-ok/10 text-ok border-ok/25", new: "bg-ok/10 text-ok border-ok/25",
  pending: "bg-muted text-muted-foreground border-border", queued: "bg-muted text-muted-foreground border-border", sending: "bg-primary/10 text-primary border-primary/25",
  needs_setup: "bg-signal-soft text-signal border-signal/30", partial: "bg-signal-soft text-signal border-signal/30", uncertain: "bg-amber-100 text-amber-800 border-amber-300",
  duplicate: "bg-muted text-muted-foreground border-border", cancelled: "bg-muted text-muted-foreground border-border",
  error: "bg-destructive/10 text-destructive border-destructive/25", failed: "bg-destructive/10 text-destructive border-destructive/25", invalid: "bg-destructive/10 text-destructive border-destructive/25",
};
export function Tag({ s, testId }: { s: string; testId?: string }) {
  return <span data-testid={testId} className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider", tone[s] ?? tone.pending)}>{s.replace("_", " ")}</span>;
}

/* ---------------- Connection ---------------- */
export function ConnectionPanel({ ws }: { ws: AdvertisingWorkspace }) {
  const sync = useWorkspaceSync();
  const { toast } = useToast();
  const connect = useConnectAdvertisingBot({ mutation: { gcTime: 0 } });
  const disconnect = useDisconnectAdvertisingBot();
  const check = useCheckAdvertisingBot();
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const b = ws.bot;
  const verifying = connect.isPending || check.isPending;
  const busy = verifying || disconnect.isPending;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setErr("");
    if (token.trim().length < 20) { setErr("Paste the full advertising bot token from BotFather."); return; }
    try { const ws2 = await connect.mutateAsync({ data: { token: token.trim() } }); setToken(""); sync(ws2); toast({ title: "Verified and connected", description: `Advertising bot: @${ws2.bot.username}` }); }
    catch (x) { setErr(`${errMsg(x)}${b.configured ? " Your saved bot connection was not changed." : ""}`); }
    finally { connect.reset(); }
  }
  return (
    <Panel title="Advertising bot" meta={<span role="status" aria-live="polite" className={cn("inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider", b.connected && !verifying ? "text-ok" : "text-signal")} data-testid="status-ad-bot"><span className={cn("h-1.5 w-1.5 rounded-full", b.connected && !verifying ? "bg-ok" : "bg-signal")} />{verifying ? "Verifying…" : b.connected ? "Verified · Connected" : "Disconnected"}</span>}>
      {b.configured ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-primary/10 text-primary"><Megaphone className="h-5 w-5" /></div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-sm font-semibold" data-testid="text-ad-bot-username">@{b.username}</div>
              <div className="text-xs text-muted-foreground">{b.checkedAt ? `Checked ${ago(b.checkedAt)}` : "Not checked yet"} · separate from your shop bot</div>
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setErr(""); try { const result = await check.mutateAsync(); sync(result); toast({ title: result.bot.connected ? "Verified and connected" : "Connection check failed", variant: result.bot.connected ? "default" : "destructive" }); } catch (x) { setErr(errMsg(x)); } }} data-testid="button-check-ad-bot">{check.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}{check.isPending ? "Verifying…" : "Check connection"}</Button>
            <Button size="sm" variant="ghost" disabled={busy} className="text-destructive" onClick={() => setConfirmOff(true)} data-testid="button-disconnect-ad-bot"><Unplug className="mr-1 h-3.5 w-3.5" />Disconnect</Button>
          </div>
          {b.error && <p role="alert" className="text-sm text-destructive" data-testid="error-ad-bot">{b.error}</p>}
        </div>
      ) : null}
        <form onSubmit={submit} className={cn("space-y-3", b.configured && "mt-4 border-t pt-4")} data-testid="form-connect-ad-bot" autoComplete="off">
          <p className="text-sm text-muted-foreground">{b.configured ? "Paste a new token to reconnect or replace the advertising bot. Your saved token is never displayed." : "Only the BotFather token is needed. We automatically identify the bot and create its Telegram link."} Your shop bot stays separate.</p>
          <div>
            <label className="space-y-1.5 text-sm font-medium">Advertising bot token<Input type="password" autoComplete="new-password" value={token} onChange={e => { setToken(e.target.value); setErr(""); }} placeholder="Paste your BotFather token" className="font-mono" maxLength={200} disabled={busy} required data-testid="input-ad-bot-token" /></label>
          </div>
          {err && <p role="alert" className="text-sm text-destructive" data-testid="error-connect-ad-bot">{err}</p>}
          <p className="text-xs text-muted-foreground">Click Verify and connect after pasting. The status changes only after Telegram verifies the token.</p>
          <div className="flex justify-end"><Button type="submit" disabled={busy} data-testid="button-connect-ad-bot">{connect.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <PlugZap className="mr-1.5 h-4 w-4" />}{connect.isPending ? "Verifying…" : "Verify and connect"}</Button></div>
        </form>
      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Disconnect advertising bot?</AlertDialogTitle><AlertDialogDescription>The stored token is removed. Groups, draft and history stay. Your shop bot is not affected.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep</AlertDialogCancel><AlertDialogAction data-testid="button-confirm-disconnect" onClick={async () => { try { sync(await disconnect.mutateAsync()); } catch (x) { setErr(errMsg(x)); } }}>Disconnect</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

/* ---------------- Draft ---------------- */
export type DraftState = { text: string; imageUrl: string; buttonText: string; buttonUrl: string };
export const toDraft = (s: DraftState): AdvertisingDraft => ({ text: s.text, imageUrl: s.imageUrl.trim() || null, buttonText: s.buttonText.trim(), buttonUrl: s.buttonUrl.trim() || null });
export function draftProblem(d: DraftState): string {
  if (!d.text.trim()) return "Write the ad text.";
  if (d.text.length > 4096) return "Text is over 4,096 characters.";
  if (d.imageUrl.trim() && d.text.length > 1024) return "With an image, text must be 1,024 characters or less.";
  if (d.imageUrl.trim() && !isProductImageUrl(d.imageUrl.trim())) return "Image must be a public HTTPS .jpg, .png, .webp or .gif link.";
  if (d.buttonText.length > 64) return "Button text is over 64 characters.";
  if (!!d.buttonText.trim() !== !!d.buttonUrl.trim()) return "Button needs both text and a link, or neither.";
  if (d.buttonUrl.trim() && !/^https:\/\//i.test(d.buttonUrl.trim())) return "Button link must start with https://";
  return "";
}

export function MessagePreview({ d }: { d: DraftState }) {
  return (
    <div className="overflow-hidden rounded-[22px] border-[5px] border-ink bg-ink shadow-lg" data-testid="preview-ad">
      <div className="bg-[#f6f8fa] px-3 py-2 text-[12px] font-semibold text-[#1b2433]">Group chat · preview</div>
      <div className="tg-wall max-h-[420px] overflow-y-auto p-3 text-[13px] text-[#1b2433]">
        <div className="max-w-[92%] overflow-hidden rounded-2xl rounded-bl-md bg-white shadow-sm">
          {d.imageUrl.trim() && <ProductMediaPreview url={d.imageUrl.trim()} name="Ad image" className="rounded-none border-0" />}
          <div className="whitespace-pre-wrap break-words px-3 py-2">{d.text || <span className="opacity-50">Your ad text appears here</span>}</div>
        </div>
        {d.buttonText.trim() && <div className="mt-1 max-w-[92%] rounded-lg bg-white/80 px-3 py-2 text-center text-[12px] font-medium text-[#2a8bd0] shadow-sm">{d.buttonText}</div>}
      </div>
    </div>
  );
}

export function DraftPanel({ d, setD, dirty, onSave, saving, shopBotUrl }: { d: DraftState; setD: (d: DraftState) => void; dirty: boolean; onSave: () => void; saving: boolean; shopBotUrl: string | null }) {
  const problem = draftProblem(d);
  const limit = d.imageUrl.trim() ? 1024 : 4096;
  return (
    <Panel title="Advertisement" meta={dirty ? <span className="text-signal">unsaved</span> : "saved"}>
      <div className="space-y-4">
        <label className="block space-y-1.5 text-sm font-medium">Text
          <Textarea rows={7} value={d.text} onChange={e => setD({ ...d, text: e.target.value })} data-testid="input-ad-text" />
          <span className={cn("block text-right font-mono text-[11px]", d.text.length > limit ? "text-destructive" : "text-muted-foreground")} data-testid="text-ad-count">{d.text.length} / {limit}</span>
        </label>
        <label className="block space-y-1.5 text-sm font-medium">Image or GIF link <span className="font-normal text-muted-foreground">optional</span>
          <Input type="url" value={d.imageUrl} onChange={e => setD({ ...d, imageUrl: e.target.value })} placeholder="https://example.com/promo.gif" data-testid="input-ad-image-url" />
        </label>
        <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
          <label className="space-y-1.5 text-sm font-medium">Button text <span className="font-normal text-muted-foreground">optional</span><Input maxLength={64} value={d.buttonText} onChange={e => setD({ ...d, buttonText: e.target.value })} placeholder="Open shop" data-testid="input-ad-button-text" /></label>
          <label className="space-y-1.5 text-sm font-medium">Button link<Input type="url" value={d.buttonUrl} onChange={e => setD({ ...d, buttonUrl: e.target.value })} placeholder="https://t.me/yourshop_bot" data-testid="input-ad-button-url" /></label>
        </div>
        {shopBotUrl && !d.buttonUrl && <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setD({ ...d, buttonText: d.buttonText || "Open shop", buttonUrl: shopBotUrl })} data-testid="button-use-shop-link">Use shop bot link</button>}
        {problem && d.text && <p className="text-sm text-destructive" data-testid="error-ad-draft">{problem}</p>}
        <div className="flex justify-end"><Button onClick={onSave} disabled={saving || !dirty || !!problem} data-testid="button-save-ad-draft">{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save draft</Button></div>
      </div>
    </Panel>
  );
}

/* ---------------- Import ---------------- */
export function ImportPanel({ ws }: { ws: AdvertisingWorkspace }) {
  const sync = useWorkspaceSync();
  const { toast } = useToast();
  const preview = usePreviewAdvertisingGroups();
  const add = useAddAdvertisingGroups();
  const discover = useDiscoverAdvertisingGroups();
  const [text, setText] = useState("");
  const [rows, setRows] = useState<AdvertisingImportRow[] | null>(null);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; e.target.value = ""; setErr("");
    if (!f) return;
    if (!/\.txt$/i.test(f.name)) { setErr("Choose a .txt file."); return; }
    if (f.size > 65536) { setErr("File is over 64 KB. Split it into smaller files."); return; }
    setText(await f.text()); setRows(null);
  }
  async function segregate() {
    setErr(""); setOk(false);
    try { setRows((await preview.mutateAsync({ data: { text } })).rows); } catch (x) { setErr(errMsg(x)); }
  }
  const addable = (rows ?? []).filter(r => (r.status === "new" || r.status === "needs_setup") && r.target);
  async function addAll() {
    setErr("");
    try { sync(await add.mutateAsync({ data: { targets: addable.map(r => r.target!), permissionConfirmed: true } })); toast({ title: `${addable.length} groups added` }); setRows(null); setText(""); setOk(false); }
    catch (x) { setErr(errMsg(x)); }
  }
  const buckets: { key: string; label: string; rows: AdvertisingImportRow[] }[] = rows ? [
    { key: "new", label: "New, ready to check", rows: rows.filter(r => r.status === "new") },
    { key: "needs_setup", label: "Private invites, need setup", rows: rows.filter(r => r.status === "needs_setup") },
    { key: "duplicate", label: "Duplicates, skipped", rows: rows.filter(r => r.status === "duplicate") },
    { key: "invalid", label: "Invalid, skipped", rows: rows.filter(r => r.status === "invalid") },
  ] : [];
  return (
    <Panel title="Add groups" meta=".txt or paste">
      <div className="space-y-3">
        <Textarea rows={4} value={text} onChange={e => { setText(e.target.value); setRows(null); }} placeholder={"@publicgroup\nhttps://t.me/anothergroup\n-1001234567890"} className="font-mono text-xs" data-testid="input-group-paste" />
        <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={onFile} data-testid="input-group-file" />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} data-testid="button-import-txt"><FileUp className="mr-1 h-3.5 w-3.5" />Import .txt</Button>
          <Button size="sm" disabled={!text.trim() || preview.isPending || text.length > 65536} onClick={segregate} data-testid="button-segregate">{preview.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Segregate</Button>
          <Button variant="ghost" size="sm" className="ml-auto" disabled={!ws.bot.connected || discover.isPending} onClick={async () => { setErr(""); try { sync(await discover.mutateAsync()); toast({ title: "Checked recent group additions" }); } catch (x) { setErr(errMsg(x)); } }} data-testid="button-discover-groups">{discover.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Radar className="mr-1 h-3.5 w-3.5" />}Find groups</Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">Bots cannot join through invite links. Add the advertising bot to a private group yourself, then enter its negative chat ID or press Find groups to pick up recent additions. Other apps' webhooks are never removed.</p>
        {err && <p role="alert" className="text-sm text-destructive" data-testid="error-import">{err}</p>}
        {rows && (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3" data-testid="panel-import-review">
            {buckets.map(bk => bk.rows.length > 0 && (
              <div key={bk.key}>
                <div className="mb-1 flex items-center gap-2"><Tag s={bk.key} /><span className="text-xs font-medium">{bk.label}</span><span className="font-mono text-xs text-muted-foreground" data-testid={`count-import-${bk.key}`}>{bk.rows.length}</span></div>
                <ul className="max-h-36 space-y-0.5 overflow-y-auto">
                  {bk.rows.map((r, i) => <li key={i} className="flex gap-2 text-xs"><span className="truncate font-mono">{r.target ?? r.input}</span>{r.reason && <span className="truncate text-muted-foreground">{r.reason}</span>}</li>)}
                </ul>
              </div>
            ))}
            {rows.length === 0 && <p className="text-sm text-muted-foreground">No lines found.</p>}
            {addable.length > 0 && <>
              <label className="flex items-start gap-2 text-xs"><Checkbox checked={ok} onCheckedChange={v => setOk(v === true)} data-testid="checkbox-import-permission" /><span>I am allowed to post advertisements in these groups.</span></label>
              <Button size="sm" disabled={!ok || add.isPending} onClick={addAll} data-testid="button-add-groups">{add.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Add {addable.length} groups</Button>
            </>}
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ---------------- Group list ---------------- */
export function GroupsPanel({ ws, selected, setSelected }: { ws: AdvertisingWorkspace; selected: Set<string>; setSelected: (s: Set<string>) => void }) {
  const sync = useWorkspaceSync();
  const { toast } = useToast();
  const check = useCheckAdvertisingGroups();
  const update = useUpdateAdvertisingGroup();
  const del = useDeleteAdvertisingGroup();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<AdvertisingGroup | null>(null);
  const [editTarget, setEditTarget] = useState("");
  const [deleting, setDeleting] = useState<AdvertisingGroup | null>(null);
  const [progress, setProgress] = useState("");
  const list = useMemo(() => ws.groups.filter(g => (status === "all" || g.status === status) && (!q || `${g.title} ${g.target} ${g.chatId ?? ""}`.toLowerCase().includes(q.toLowerCase()))), [ws.groups, q, status]);
  const toggle = (id: string) => { const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); setSelected(n); };
  async function checkPerms() {
    const ids = [...selected].filter(id => ws.groups.some(g => g.id === id));
    try {
      for (let i = 0; i < ids.length; i += 20) {
        setProgress(`${Math.min(i + 20, ids.length)} / ${ids.length}`);
        sync(await check.mutateAsync({ data: { groupIds: ids.slice(i, i + 20) } }));
      }
      toast({ title: "Permissions checked" });
    } catch (x) { toast({ title: "Check failed", description: errMsg(x), variant: "destructive" }); }
    finally { setProgress(""); }
  }
  const statuses = ["all", "ready", "pending", "needs_setup", "error", "duplicate"];
  return (
    <Panel title="Groups" meta={<span data-testid="text-group-count">{ws.groups.length} total · {ws.groups.filter(g => g.status === "ready" && g.enabled).length} sendable</span>}>
      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search groups" className="pl-8" data-testid="input-group-search" /></div>
          <div className="flex gap-1 overflow-x-auto">{statuses.map(s => <button key={s} onClick={() => setStatus(s)} data-testid={`filter-group-${s}`} className={cn("shrink-0 rounded-md px-2.5 py-1.5 font-mono text-[11px] uppercase", status === s ? "bg-ink text-white" : "bg-muted text-muted-foreground hover:text-foreground")}>{s.replace("_", " ")}</button>)}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Checkbox checked={list.length > 0 && list.every(g => selected.has(g.id))} onCheckedChange={v => { const n = new Set(selected); list.forEach(g => v === true ? n.add(g.id) : n.delete(g.id)); setSelected(n); }} data-testid="checkbox-select-all" />
          <span>{selected.size} selected</span>
          <Button size="sm" variant="outline" className="ml-auto" disabled={!selected.size || check.isPending || !ws.bot.connected} onClick={checkPerms} data-testid="button-check-permissions">{check.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />}{progress ? `Checking ${progress}` : "Check permissions"}</Button>
        </div>
        {ws.groups.length === 0 ? <EmptyState icon={Megaphone} title="No groups yet" body="Paste links, import a .txt file, or use Find groups after adding the bot." /> :
          list.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No groups match.</p> :
          <ul className="divide-y rounded-lg border">
            {list.map(g => (
              <li key={g.id} className="flex items-start gap-3 p-3" data-testid={`row-group-${g.id}`}>
                <Checkbox className="mt-1" checked={selected.has(g.id)} onCheckedChange={() => toggle(g.id)} data-testid={`checkbox-group-${g.id}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium">{g.title || g.target}</span><Tag s={g.status} testId={`status-group-${g.id}`} /></div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{g.target}{g.chatId && g.chatId !== g.target ? ` · ${g.chatId}` : ""}</div>
                  {g.note && <div className="mt-0.5 text-xs text-muted-foreground">{g.note}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch checked={g.enabled} onCheckedChange={async v => { try { sync(await update.mutateAsync({ id: g.id, data: { enabled: v } })); } catch (x) { toast({ title: "Update failed", description: errMsg(x), variant: "destructive" }); } }} data-testid={`switch-group-${g.id}`} />
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => { setEditing(g); setEditTarget(g.target); }} data-testid={`button-edit-group-${g.id}`}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => setDeleting(g)} data-testid={`button-delete-group-${g.id}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </li>
            ))}
          </ul>}
      </div>
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit group target</DialogTitle><DialogDescription>Replace an unresolved invite link with the group's negative chat ID after adding the bot.</DialogDescription></DialogHeader>
          <Input value={editTarget} onChange={e => setEditTarget(e.target.value)} maxLength={300} className="font-mono" data-testid="input-edit-group-target" />
          <DialogFooter><Button disabled={!editTarget.trim() || update.isPending} onClick={async () => { if (!editing) return; try { sync(await update.mutateAsync({ id: editing.id, data: { target: editTarget.trim() } })); setEditing(null); } catch (x) { toast({ title: "Update failed", description: errMsg(x), variant: "destructive" }); } }} data-testid="button-save-group-target">{update.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!deleting} onOpenChange={o => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Remove this group?</AlertDialogTitle><AlertDialogDescription className="font-mono">{deleting?.target}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep</AlertDialogCancel><AlertDialogAction data-testid="button-confirm-delete-group" onClick={async () => { if (!deleting) return; try { sync(await del.mutateAsync({ id: deleting.id })); const n = new Set(selected); n.delete(deleting.id); setSelected(n); } catch (x) { toast({ title: "Delete failed", description: errMsg(x), variant: "destructive" }); } }}>Remove</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

/* ---------------- Send ---------------- */
export function SendDialog({ open, onOpenChange, ws, d, recipients, onStarted }: { open: boolean; onOpenChange: (o: boolean) => void; ws: AdvertisingWorkspace; d: DraftState; recipients: AdvertisingGroup[]; onStarted: (id: string, fp: string) => void }) {
  const sync = useWorkspaceSync();
  const save = useSaveAdvertisingDraft();
  const start = useStartAdvertisingCampaign();
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState("");
  const keyRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const sig = JSON.stringify([toDraft(d), recipients.map(r => r.id)]);
  const sigRef = useRef(sig);
  useEffect(() => { if (sigRef.current !== sig) { sigRef.current = sig; keyRef.current = null; } }, [sig]);
  useEffect(() => { if (open) { setOk(false); setErr(""); } }, [open]);
  const active = ws.campaigns.some(c => c.status === "queued" || c.status === "sending");
  const busy = save.isPending || start.isPending;
  async function go() {
    if (busyRef.current) return; busyRef.current = true; setErr("");
    try {
      const frozen = toDraft(d);
      const fp = JSON.stringify(frozen);
      sync(await save.mutateAsync({ data: frozen }));
      if (!keyRef.current) keyRef.current = crypto.randomUUID();
      const camp = await start.mutateAsync({ data: { groupIds: recipients.map(r => r.id), permissionConfirmed: true, idempotencyKey: keyRef.current, draft: frozen } });
      keyRef.current = null; sync();
      onStarted(camp.id, fp);
      onOpenChange(false);
    } catch (x) { setErr(errMsg(x)); }
    finally { busyRef.current = false; }
  }
  return (
    <Dialog open={open} onOpenChange={o => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Confirm this exact send</DialogTitle><DialogDescription>One post per group, sent once, now. Nothing is scheduled or repeated.</DialogDescription></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <MessagePreview d={d} />
          <div>
            <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground" data-testid="text-recipient-count">{recipients.length} recipients</div>
            <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">{recipients.map(r => <li key={r.id} className="truncate font-mono">{r.title || r.target}</li>)}</ul>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={ok} onCheckedChange={v => setOk(v === true)} data-testid="checkbox-send-permission" /><span>I have permission to post this advertisement in every group listed.</span></label>
        {active && <p className="text-sm text-signal">A campaign is already running. Wait for it to finish or cancel it.</p>}
        {err && <p role="alert" className="text-sm text-destructive" data-testid="error-send">{err} {keyRef.current && "Retrying reuses the same request, so nothing is sent twice."}</p>}
        <DialogFooter><Button disabled={!ok || busy || active || !recipients.length || !ws.bot.connected} onClick={go} data-testid="button-confirm-send">{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}{err ? "Retry send" : `Send to ${recipients.length}`}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- History ---------------- */
export function HistoryPanel({ ws, selectedId, setSelectedId }: { ws: AdvertisingWorkspace; selectedId: string | null; setSelectedId: (id: string | null) => void }) {
  const camps = [...ws.campaigns].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Panel title="Delivery history">
      {camps.length === 0 ? <EmptyState icon={Send} title="No sends yet" body="Confirmed sends appear here with per-group results." /> :
        <ul className="divide-y rounded-lg border">{camps.map(c => (
          <li key={c.id}><button onClick={() => setSelectedId(selectedId === c.id ? null : c.id)} className={cn("w-full p-3 text-left hover:bg-muted/40", selectedId === c.id && "bg-muted/60")} data-testid={`row-campaign-${c.id}`}>
            <div className="flex items-center gap-2"><Tag s={c.status} testId={`status-campaign-${c.id}`} /><span className="text-xs text-muted-foreground">{dateTime(c.createdAt)}</span></div>
            <div className="mt-1 truncate text-sm">{c.text}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px]"><span className="text-ok">{c.sent} sent</span><span className="text-destructive">{c.failed} failed</span><span className="text-amber-700">{c.uncertain} uncertain</span><span className="text-muted-foreground">{c.pending} pending</span><span className="text-muted-foreground">{c.cancelled} cancelled</span><span>/ {c.total}</span></div>
          </button></li>
        ))}</ul>}
      {selectedId && <CampaignDetail id={selectedId} onClose={() => setSelectedId(null)} />}
    </Panel>
  );
}

function CampaignDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useGetAdvertisingCampaign(id, { query: { enabled: !!id, queryKey: getGetAdvertisingCampaignQueryKey(id), refetchInterval: 5000 } });
  const cancel = useCancelAdvertisingCampaign();
  const [confirm, setConfirm] = useState(false);
  if (q.isLoading) return <div className="mt-4"><RowsSkeleton rows={4} /></div>;
  if (q.isError || !q.data) return <div className="mt-4"><ErrorState message={errMsg(q.error) || "Failed to load campaign"} onRetry={() => q.refetch()} /></div>;
  const { campaign: c, deliveries } = q.data;
  const canCancel = c.status === "queued" || c.status === "sending";
  const sections = (["failed", "uncertain", "sent", "pending", "sending", "cancelled"] as const).map(s => ({ s, rows: deliveries.filter(x => x.status === s) })).filter(x => x.rows.length);
  return (
    <div className="mt-4 rounded-lg border p-3" data-testid="panel-campaign-detail">
      <div className="mb-2 flex items-center gap-2"><span className="text-sm font-semibold">Campaign detail</span>
        {canCancel && <Button size="sm" variant="outline" className="ml-auto text-destructive" onClick={() => setConfirm(true)} data-testid="button-cancel-campaign"><Ban className="mr-1 h-3.5 w-3.5" />Cancel unsent</Button>}
        <Button size="icon" variant="ghost" className={cn("h-7 w-7", !canCancel && "ml-auto")} onClick={onClose} data-testid="button-close-campaign"><X className="h-4 w-4" /></Button></div>
      {sections.map(({ s, rows }) => (
        <div key={s} className="mb-3">
          <div className="mb-1 flex items-center gap-2"><Tag s={s} /><span className="font-mono text-xs">{rows.length}</span></div>
          {s === "uncertain" && <p className="mb-1 text-xs text-amber-800">Telegram may have posted these. They are not retried, to avoid double posts. Check the groups manually.</p>}
          <ul className="space-y-1">{rows.map(r => <li key={r.id} className="text-xs" data-testid={`row-delivery-${r.id}`}><span className="font-mono">{r.target}</span>{r.sentAt && <span className="text-muted-foreground"> · {dateTime(r.sentAt)}</span>}{r.note && <div className="text-muted-foreground">{r.note}</div>}</li>)}</ul>
        </div>
      ))}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Cancel unsent posts?</AlertDialogTitle><AlertDialogDescription>Only posts still waiting are stopped. Messages already dispatched to Telegram cannot be recalled.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep sending</AlertDialogCancel><AlertDialogAction data-testid="button-confirm-cancel-campaign" onClick={async () => { try { await cancel.mutateAsync({ id }); void qc.invalidateQueries({ queryKey: getGetAdvertisingCampaignQueryKey(id) }); void qc.invalidateQueries({ queryKey: WS_KEY }); } catch (x) { toast({ title: "Cancel failed", description: errMsg(x), variant: "destructive" }); } }}>Cancel unsent</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export { useWorkspaceSync };
