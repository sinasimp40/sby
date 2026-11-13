import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDiscoverAdvertisingGroups,
  usePreviewAdvertisingGroups, useAddAdvertisingGroups, useCheckAdvertisingGroups, useUpdateAdvertisingGroup,
  useDeleteAdvertisingGroup, useGetAdvertisingCampaign,
  getGetAdvertisingCampaignQueryKey, getGetAdvertisingWorkspaceQueryKey, useCancelAdvertisingCampaign,
  type AdvertisingWorkspace, type AdvertisingGroup, type AdvertisingImportRow, type AdvertisingDraft,
} from "@workspace/api-client-react";
import { Loader2, FileUp, Search, Trash2, Pencil, ShieldCheck, Send, Ban, Megaphone, Radar, X, Timer, Link2, Bold, Italic, Unlink, Sparkles, RefreshCw } from "lucide-react";
import { adjustForEdit, covered, entitiesProblem, insertEmoji, linkAt, normalize, safeHttps, segments, setLink, snapSelection, toggleStyle, type Entity } from "@/lib/ad-entities";
import { EmojiSetPicker } from "@/components/advertising/emoji-set-picker";
import { alphabeticalGroups, retainedGroupSelection, ScrollableGroupList } from "@/components/advertising/group-list";
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
import { errMsg, dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const WS_KEY = getGetAdvertisingWorkspaceQueryKey();

function useWorkspaceSync() {
  const qc = useQueryClient();
  return (ws?: AdvertisingWorkspace) => {
    if (ws) qc.setQueryData(WS_KEY, ws);
    void qc.invalidateQueries({ queryKey: WS_KEY });
  };
}

export const tone: Record<string, string> = {
  ready: "bg-ok/10 text-ok border-ok/25", sent: "bg-ok/10 text-ok border-ok/25", completed: "bg-ok/10 text-ok border-ok/25", new: "bg-ok/10 text-ok border-ok/25",
  pending: "bg-muted text-muted-foreground border-border", queued: "bg-muted text-muted-foreground border-border", sending: "bg-primary/10 text-primary border-primary/25",
  needs_setup: "bg-signal-soft text-signal border-signal/30", partial: "bg-signal-soft text-signal border-signal/30", uncertain: "bg-amber-100 text-amber-800 border-amber-300", rate_limited: "bg-amber-100 text-amber-800 border-amber-300", running: "bg-primary/10 text-primary border-primary/25", stopped: "bg-muted text-muted-foreground border-border",
  duplicate: "bg-muted text-muted-foreground border-border", cancelled: "bg-muted text-muted-foreground border-border",
  error: "bg-destructive/10 text-destructive border-destructive/25", failed: "bg-destructive/10 text-destructive border-destructive/25", invalid: "bg-destructive/10 text-destructive border-destructive/25",
};
export function Tag({ s, testId }: { s: string; testId?: string }) {
  return <span data-testid={testId} className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider", tone[s] ?? tone.pending)}>{s.replace("_", " ")}</span>;
}

export function fmtInterval(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}


/* ---------------- Draft ---------------- */
export type DraftState = { text: string; imageUrl: string; buttonText: string; buttonUrl: string; entities?: Entity[] };
export const toDraft = (s: DraftState): AdvertisingDraft => {
  const entities = normalize(s.text, s.entities ?? []);
  const base: AdvertisingDraft = { text: s.text, imageUrl: s.imageUrl.trim() || null, buttonText: s.buttonText.trim(), buttonUrl: s.buttonUrl.trim() || null };
  return entities.length ? { ...base, entities } : base;
};
/** Account messages cannot carry inline bot buttons; the optional link is appended to the text. */
export function composeText(d: DraftState): string {
  const url = d.buttonUrl.trim();
  if (!url) return d.text;
  const label = d.buttonText.trim();
  return `${d.text}\n\n${label ? `${label}: ` : ""}${url}`;
}
export function draftProblem(d: DraftState): string {
  const full = composeText(d).length;
  const media = !!d.imageUrl.trim();
  if (!d.text.trim()) return "Write the ad text.";
  if (!media && full > 4096) return `Text plus link is ${full} characters; the limit is 4,096.`;
  if (media && full > 1024) return `With an image, text plus link must be 1,024 characters or less (now ${full}).`;
  if (media && !isProductImageUrl(d.imageUrl.trim())) return "Image must be a public HTTPS .jpg, .png, .webp or .gif link.";
  if (d.buttonUrl.trim()) {
    if (!d.buttonText.trim()) return "Give the shop link a label.";
    if (d.buttonText.trim().length > 64) return "Link label is over 64 characters.";
    if (!safeHttps(d.buttonUrl)) return "Shop link must be a valid public HTTPS link.";
  }
  return entitiesProblem(d.text, d.entities ?? []);
}

function linkify(text: string) {
  return text.split(/(https:\/\/[^\s]+)/g).map((part, i) => /^https:\/\//.test(part) ? <span key={i} className="text-[#2a8bd0] underline underline-offset-2">{part}</span> : part);
}

function FormattedText({ text, entities }: { text: string; entities: Entity[] }) {
  return <>{segments(text, normalize(text, entities)).map((g, i) => {
    let node: ReactNode = g.emojiId ? <span className="rounded-sm bg-primary/10 outline-dashed outline-1 outline-primary/40" title={`Custom emoji ${g.emojiId}; fallback shown`} data-testid={`preview-custom-emoji-${i}`}>{g.text}</span> : g.text;
    if (g.bold) node = <strong className="font-semibold">{node}</strong>;
    if (g.italic) node = <em>{node}</em>;
    if (g.url) node = <a href={g.url} target="_blank" rel="noopener noreferrer nofollow" className="text-[#2a8bd0] underline underline-offset-2">{node}</a>;
    return <span key={i}>{node}</span>;
  })}</>;
}

export function MessagePreview({ d }: { d: DraftState }) {
  const tail = composeText(d).slice(d.text.length);
  const hasEmoji = (d.entities ?? []).some(e => e.type === "custom_emoji");
  return (
    <div>
      <div className="overflow-hidden rounded-[22px] border-[5px] border-ink bg-ink shadow-lg" data-testid="preview-ad">
        <div className="bg-[#f6f8fa] px-3 py-2 text-[12px] font-semibold text-[#1b2433]">Group chat · posted from your account</div>
        <div className="tg-wall max-h-[420px] overflow-y-auto p-3 text-[13px] text-[#1b2433]">
          <div className="max-w-[92%] overflow-hidden rounded-2xl rounded-bl-md bg-white shadow-sm">
            {d.imageUrl.trim() && <ProductMediaPreview url={d.imageUrl.trim()} name="Ad image" className="rounded-none border-0" />}
            <div className="whitespace-pre-wrap break-words px-3 py-2">{d.text ? <><FormattedText text={d.text} entities={d.entities ?? []} />{linkify(tail)}</> : <span className="opacity-50">Your ad text appears here</span>}</div>
          </div>
        </div>
      </div>
      {hasEmoji && <p className="mt-2 text-center text-[11px] text-muted-foreground" data-testid="text-preview-emoji-note">Outlined characters are ordinary fallbacks. Telegram renders the custom emoji you chose.</p>}
    </div>
  );
}

function ToolBtn({ on, disabled, onClick, label, testId, children }: { on?: boolean; disabled?: boolean; onClick: () => void; label: string; testId: string; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} aria-pressed={on} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={onClick} data-testid={testId}
    className={cn("inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors disabled:opacity-40", on ? "bg-ink text-white" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>{children}</button>;
}

export function DraftPanel({ d, setD, dirty, onSave, saving, shopBotUrl, connected = false }: { d: DraftState; setD: (d: DraftState) => void; dirty: boolean; onSave: () => void; saving: boolean; shopBotUrl: string | null; connected?: boolean }) {
  const problem = draftProblem(d);
  const limit = d.imageUrl.trim() ? 1024 : 4096;
  const total = composeText(d).length;
  const ents = d.entities ?? [];
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [sel, setSel] = useState<[number, number]>([0, 0]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [s0, e0] = snapSelection(d.text, sel[0], sel[1]);
  const hasSel = e0 > s0;
  const curLink = hasSel ? linkAt(ents, s0, e0) : undefined;
  const readSel = () => { const t = taRef.current; if (t) setSel([t.selectionStart, t.selectionEnd]); };
  const restore = (a: number, b: number) => requestAnimationFrame(() => { const t = taRef.current; if (t) { t.focus(); t.setSelectionRange(a, b); setSel([a, b]); } });
  const setEnts = (entities: Entity[]) => setD({ ...d, entities });
  const style = (t: "bold" | "italic") => { setEnts(toggleStyle(d.text, ents, t, s0, e0)); restore(s0, e0); };
  const linkValid = safeHttps(linkUrl);
  const applyLink = () => { if (!linkValid) return; setEnts(setLink(d.text, ents, s0, e0, linkUrl.trim())); setLinkOpen(false); restore(s0, e0); };
  useEffect(() => { if (!hasSel) setLinkOpen(false); }, [hasSel]);
  return (
    <Panel title="Advertisement" meta={dirty ? <span className="text-signal">unsaved</span> : "saved"}>
      <div className="space-y-4">
        <div className="space-y-1.5 text-sm font-medium">
          <label htmlFor="ad-text">Text</label>
          <div className="overflow-hidden rounded-md border border-input focus-within:ring-1 focus-within:ring-ring">
            <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-1.5 py-1" role="toolbar" aria-label="Formatting">
              <ToolBtn label="Bold selection" testId="button-format-bold" disabled={!hasSel} on={hasSel && covered(ents, "bold", s0, e0)} onClick={() => style("bold")}><Bold className="h-3.5 w-3.5" /></ToolBtn>
              <ToolBtn label="Italic selection" testId="button-format-italic" disabled={!hasSel} on={hasSel && covered(ents, "italic", s0, e0)} onClick={() => style("italic")}><Italic className="h-3.5 w-3.5" /></ToolBtn>
              <ToolBtn label="Link selection" testId="button-format-link" disabled={!hasSel} on={linkOpen || !!curLink} onClick={() => { setLinkUrl(curLink?.url ?? "https://"); setLinkOpen(o => !o); }}><Link2 className="h-3.5 w-3.5" />Link</ToolBtn>
              {curLink && <ToolBtn label="Remove link" testId="button-format-unlink" onClick={() => { setEnts(setLink(d.text, ents, s0, e0, null)); restore(s0, e0); }}><Unlink className="h-3.5 w-3.5" /></ToolBtn>}
              <span className="mx-1 h-4 w-px bg-border" />
              <ToolBtn label="Custom emoji" testId="button-toggle-emoji" on={emojiOpen} onClick={() => setEmojiOpen(o => !o)}><Sparkles className="h-3.5 w-3.5" />Custom emoji</ToolBtn>
              {ents.length > 0 && <ToolBtn label="Clear all formatting" testId="button-format-clear" onClick={() => setEnts([])}>Clear</ToolBtn>}
              <span className="ml-auto pr-1 font-mono text-[10px] font-normal text-muted-foreground">{hasSel ? `${e0 - s0} selected` : "select text to format"}</span>
            </div>
            {linkOpen && hasSel && <div className="flex gap-2 border-b bg-accent/40 p-2">
              <Input autoFocus value={linkUrl} onChange={e => setLinkUrl(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") setLinkOpen(false); }} className="h-8 font-mono text-xs" placeholder="https://" data-testid="input-format-link-url" />
              <Button size="sm" className="h-8" disabled={!linkValid} onClick={applyLink} data-testid="button-apply-link">Apply</Button>
            </div>}
            {linkOpen && hasSel && linkUrl.trim() && linkUrl.trim() !== "https://" && !linkValid && <p className="border-b px-2 py-1 text-xs font-normal text-destructive" data-testid="error-format-link">Use a public HTTPS link without a username or password.</p>}
            <Textarea id="ad-text" ref={taRef} rows={7} value={d.text} className="rounded-none border-0 focus-visible:ring-0"
              onSelect={readSel} onKeyUp={readSel} onMouseUp={readSel}
              onChange={e => { const t = e.target.value; setD({ ...d, text: t, entities: adjustForEdit(d.text, t, ents) }); setSel([e.target.selectionStart, e.target.selectionEnd]); }} data-testid="input-ad-text" />
          </div>
          <span className="flex justify-between font-mono text-[11px] font-normal text-muted-foreground"><span data-testid="text-ad-entity-count">{ents.length ? `${ents.length} formatted span${ents.length === 1 ? "" : "s"}` : "plain text"}</span><span className={cn(total > limit && "text-destructive")} data-testid="text-ad-count">{total} / {limit}{d.buttonUrl.trim() ? " incl. link" : ""}</span></span>
          {emojiOpen && <EmojiSetPicker connected={connected} onPick={em => { const r = insertEmoji(d.text, ents, s0, e0, em.emoji, em.documentId); setD({ ...d, ...r }); const at = s0 + em.emoji.length; restore(at, at); }} />}
          <p className="text-[11px] font-normal text-muted-foreground">Bold, italic, text links and custom emoji are sent as Telegram formatting. The text itself stays plain; no HTML or Markdown is interpreted.</p>
        </div>
        <label className="block space-y-1.5 text-sm font-medium">Image or GIF link <span className="font-normal text-muted-foreground">optional, caption limit 1,024</span>
          <Input type="url" value={d.imageUrl} onChange={e => setD({ ...d, imageUrl: e.target.value })} placeholder="https://example.com/promo.gif" data-testid="input-ad-image-url" />
        </label>
        <div className="rounded-lg border border-dashed p-3">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium"><Link2 className="h-4 w-4 text-primary" />Shop link <span className="font-normal text-muted-foreground">optional</span></div>
          <p className="mb-3 text-xs text-muted-foreground">Personal accounts cannot attach bot buttons. The link is added at the end of the message as a normal clickable link and counts toward the length limit.</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
            <label className="space-y-1.5 text-sm font-medium">Label <span className="font-normal text-muted-foreground">optional</span><Input maxLength={64} value={d.buttonText} onChange={e => setD({ ...d, buttonText: e.target.value })} placeholder="Open shop" data-testid="input-ad-button-text" /></label>
            <label className="space-y-1.5 text-sm font-medium">Link<Input type="url" value={d.buttonUrl} onChange={e => setD({ ...d, buttonUrl: e.target.value })} placeholder="https://t.me/yourshop_bot" data-testid="input-ad-button-url" /></label>
          </div>
          {shopBotUrl && !d.buttonUrl && <button type="button" className="mt-2 text-xs font-medium text-primary hover:underline" onClick={() => setD({ ...d, buttonText: d.buttonText || "Open shop", buttonUrl: shopBotUrl })} data-testid="button-use-shop-link">Use shop bot link</button>}
        </div>
        {problem && d.text && <p className="text-sm text-destructive" data-testid="error-ad-draft">{problem}</p>}
        <p className="text-xs text-muted-foreground">Running schedules keep the snapshot they were started with. To apply edits, stop and restart the selected groups.</p>
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
  const [discoveryResult, setDiscoveryResult] = useState("");
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
  async function discoverJoined() {
    setErr(""); setDiscoveryResult("");
    try {
      const next = await discover.mutateAsync();
      const previousIds = new Set(ws.groups.map(group => group.id));
      const added = next.groups.filter(group => !previousIds.has(group.id)).length;
      sync(next);
      const result = added > 0
        ? `${added} joined group${added === 1 ? "" : "s"}/channel${added === 1 ? "" : "s"} added. Check posting permissions before starting.`
        : next.groups.length > 0
          ? `No new destinations found. ${next.groups.length} already saved. No groups were joined or messages sent.`
          : "No joined groups or channels found in the first 1,000 chats. Make sure the connected Telegram account is the one that joined them. You can also add a public @username manually.";
      setDiscoveryResult(result);
      toast({ title: added > 0 ? "Joined destinations added" : "Discovery completed", description: result });
    } catch (x) { setErr(errMsg(x)); }
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
          <Button variant="ghost" size="sm" className="ml-auto" disabled={!ws.account.connected || discover.isPending} onClick={discoverJoined} data-testid="button-discover-groups">{discover.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Radar className="mr-1 h-3.5 w-3.5" />}Discover joined groups</Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">Discover scans up to 1,000 chats and lists groups and channels your connected account already belongs to—never personal chats. Nothing is joined or posted automatically. Channel posting may require administrator rights. Private invite links stay in needs setup until you join them yourself in Telegram, then Discover or enter the negative chat ID.</p>
        {discoveryResult && <p role="status" className="text-sm text-muted-foreground" data-testid="text-discovery-result">{discoveryResult}</p>}
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
export function GroupsPanel({ ws, selected: savedSelected, setSelected, sequential = false, onRefresh, refreshing = false }: { ws: AdvertisingWorkspace; selected: Set<string>; setSelected: (s: Set<string>) => void; sequential?: boolean; onRefresh?: () => void; refreshing?: boolean }) {
  const selected = useMemo(() => retainedGroupSelection(ws.groups, savedSelected), [ws.groups, savedSelected]);
  const orderedGroups = useMemo(() => alphabeticalGroups(ws.groups), [ws.groups]);
  const queuePos = useMemo(() => { const m = new Map<string, number>(); let i = 0; for (const g of orderedGroups) if (selected.has(g.id) && g.enabled && g.status === "ready" && g.chatId) m.set(g.id, ++i); return m; }, [orderedGroups, selected]);
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
  const [intervalFor, setIntervalFor] = useState<AdvertisingGroup | null>(null);
  const [ivValue, setIvValue] = useState("");
  const [ivUnit, setIvUnit] = useState<"m" | "h" | "d">("m");
  const ivSec = Math.round(Number(ivValue) * (ivUnit === "m" ? 60 : ivUnit === "h" ? 3600 : 86400));
  const ivBad = !Number.isFinite(ivSec) || ivSec < 60 || ivSec > 2592000;
  const list = useMemo(() => orderedGroups.filter(g => (status === "all" || g.status === status) && (!q || `${g.title} ${g.target} ${g.chatId ?? ""}`.toLowerCase().includes(q.toLowerCase()))), [orderedGroups, q, status]);
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
          <span data-testid="text-selected-count">{selected.size} selected</span>
          {onRefresh && <Button size="sm" variant="outline" className="ml-auto" disabled={refreshing} onClick={onRefresh}
            title="Refresh saved groups and membership results; this does not rediscover or rejoin groups." data-testid="button-refresh-groups">
            <RefreshCw className={cn("mr-1 h-3.5 w-3.5", refreshing && "animate-spin")} />Refresh list
          </Button>}
          <Button size="sm" variant="outline" className={onRefresh ? "" : "ml-auto"} disabled={!selected.size || check.isPending || !ws.account.connected} onClick={checkPerms} data-testid="button-check-permissions">{check.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />}{progress ? `Checking ${progress}` : "Check permissions"}</Button>
        </div>
        {sequential && <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground" data-testid="text-sequential-explainer">New queues follow this alphabetical list from top to bottom. Numbers show each selected ready group's place in the next queue. The shared delay applies after each batch; running campaigns keep their confirmed order.</p>}
        {ws.groups.length === 0 ? <EmptyState icon={Megaphone} title="No groups yet" body="Paste links, import a .txt file, or discover groups your account has already joined." /> :
          list.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No groups match.</p> :
          <ScrollableGroupList count={list.length}>
            {list.map(g => (
              <li key={g.id} className="flex items-start gap-3 p-3" data-testid={`row-group-${g.id}`}>
                {sequential && <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-[10px] font-semibold", queuePos.has(g.id) ? "bg-ink text-white" : "border border-dashed text-muted-foreground")} data-testid={`text-queue-pos-${g.id}`}>{queuePos.get(g.id) ?? "-"}</span>}
                <Checkbox className="mt-1" checked={selected.has(g.id)} onCheckedChange={() => toggle(g.id)} data-testid={`checkbox-group-${g.id}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium">{g.title || g.target}</span><Tag s={g.status} testId={`status-group-${g.id}`} /></div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{g.target}{g.chatId && g.chatId !== g.target ? ` · ${g.chatId}` : ""}</div>
                  {g.note && <div className="mt-0.5 text-xs text-muted-foreground">{g.note}</div>}
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px]">
                    {!sequential && <Tag s={g.running ? "running" : "stopped"} testId={`status-schedule-${g.id}`} />}
                    {sequential && g.running && <Tag s="running" testId={`status-schedule-${g.id}`} />}
                    {!sequential && <button type="button" onClick={() => { setIntervalFor(g); setIvValue(String(g.intervalSeconds % 3600 === 0 ? g.intervalSeconds / 3600 : Math.round(g.intervalSeconds / 60))); setIvUnit(g.intervalSeconds % 3600 === 0 ? "h" : "m"); }} className="inline-flex items-center gap-1 text-primary hover:underline" data-testid={`button-interval-group-${g.id}`}><Timer className="h-3 w-3" />every {fmtInterval(g.intervalSeconds)}</button>}
                    {!sequential && g.running && g.nextSendAt && <span className="text-muted-foreground" data-testid={`text-next-send-${g.id}`}>next {dateTime(g.nextSendAt)}</span>}
                    {g.lastStatus && <span className="text-muted-foreground">last: {g.lastStatus.replace("_", " ")}</span>}
                  </div>
                  {g.scheduleNote && <div className={cn("mt-0.5 text-xs", g.lastStatus === "uncertain" ? "text-amber-800" : "text-muted-foreground")} data-testid={`text-schedule-note-${g.id}`}>{g.scheduleNote}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch checked={g.enabled} onCheckedChange={async v => { try { sync(await update.mutateAsync({ id: g.id, data: { enabled: v } })); } catch (x) { toast({ title: "Update failed", description: errMsg(x), variant: "destructive" }); } }} data-testid={`switch-group-${g.id}`} />
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => { setEditing(g); setEditTarget(g.target); }} data-testid={`button-edit-group-${g.id}`}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => setDeleting(g)} data-testid={`button-delete-group-${g.id}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </li>
            ))}
          </ScrollableGroupList>}
      </div>
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit group target</DialogTitle><DialogDescription>Replace an unresolved invite link with the group's negative chat ID after joining it with your account.</DialogDescription></DialogHeader>
          <Input value={editTarget} onChange={e => setEditTarget(e.target.value)} maxLength={300} className="font-mono" data-testid="input-edit-group-target" />
          <DialogFooter><Button disabled={!editTarget.trim() || update.isPending} onClick={async () => { if (!editing) return; try { sync(await update.mutateAsync({ id: editing.id, data: { target: editTarget.trim() } })); setEditing(null); } catch (x) { toast({ title: "Update failed", description: errMsg(x), variant: "destructive" }); } }} data-testid="button-save-group-target">{update.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!intervalFor} onOpenChange={o => !o && setIntervalFor(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Posting interval</DialogTitle><DialogDescription>{intervalFor?.title || intervalFor?.target}. Between 1 minute and 30 days.{intervalFor?.running ? " Saving stops this group's schedule. Start it again when ready." : ""}</DialogDescription></DialogHeader>
          <div className="flex gap-2">
            <Input type="number" min={1} step={1} value={ivValue} onChange={e => setIvValue(e.target.value)} className="font-mono" data-testid="input-group-interval" />
            <div className="flex shrink-0 gap-1">{(["m", "h", "d"] as const).map(u => <button key={u} type="button" onClick={() => setIvUnit(u)} className={cn("rounded-md px-3 font-mono text-xs uppercase", ivUnit === u ? "bg-ink text-white" : "bg-muted text-muted-foreground")} data-testid={`button-interval-unit-${u}`}>{u === "m" ? "min" : u === "h" ? "hours" : "days"}</button>)}</div>
          </div>
          {ivValue && ivBad && <p className="text-sm text-destructive" data-testid="error-group-interval">Choose between 1 minute and 30 days.</p>}
          <DialogFooter><Button disabled={!ivValue || ivBad || !Number.isInteger(ivSec) || update.isPending} onClick={async () => { if (!intervalFor) return; try { sync(await update.mutateAsync({ id: intervalFor.id, data: { intervalSeconds: ivSec } })); toast({ title: intervalFor.running ? "Interval saved, schedule stopped" : "Interval saved" }); setIntervalFor(null); } catch (x) { toast({ title: "Update failed", description: errMsg(x), variant: "destructive" }); } }} data-testid="button-save-group-interval">{update.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Save interval</Button></DialogFooter>
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


/* ---------------- History ---------------- */
export function HistoryPanel({ ws, selectedId, setSelectedId }: { ws: AdvertisingWorkspace; selectedId: string | null; setSelectedId: (id: string | null) => void }) {
  const camps = [...ws.campaigns].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Panel title="Earlier bot campaigns" meta="read only">
      {camps.length === 0 ? <EmptyState icon={Send} title="No earlier campaigns" body="One-time bot campaigns from before account posting appear here." /> :
        <ul className="dashboard-scroll divide-y rounded-lg border" tabIndex={0} aria-label="Earlier advertising campaigns" data-testid="scroll-campaign-history">{camps.map(c => (
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
          <ul className="dashboard-scroll space-y-1" tabIndex={0} aria-label={`${s} campaign results`}>{rows.map(r => <li key={r.id} className="text-xs" data-testid={`row-delivery-${r.id}`}><span className="font-mono">{r.target}</span>{r.sentAt && <span className="text-muted-foreground"> · {dateTime(r.sentAt)}</span>}{r.note && <div className="text-muted-foreground">{r.note}</div>}</li>)}</ul>
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
