import { useEffect, useRef, useState } from "react";
import { useLoadAdvertisingSavedMessages, type AdvertisingSavedMessage } from "@workspace/api-client-react";
import { Loader2, RefreshCw, Bookmark, FileText, Image, Film, Music, Mic, Sticker, Paperclip, Lock, ChevronDown } from "lucide-react";
import { Panel, EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { errMsg, dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const kindMeta: Record<string, { label: string; Icon: typeof FileText }> = {
  text: { label: "Text", Icon: FileText }, photo: { label: "Photo", Icon: Image }, video: { label: "Video", Icon: Film },
  animation: { label: "GIF", Icon: Film }, document: { label: "File", Icon: Paperclip }, audio: { label: "Audio", Icon: Music },
  voice: { label: "Voice", Icon: Mic }, sticker: { label: "Sticker", Icon: Sticker }, other: { label: "Media", Icon: Paperclip },
};
export function MediaKindBadge({ kind }: { kind: string }) {
  const m = kindMeta[kind] ?? kindMeta.other;
  return <span className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-muted/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"><m.Icon className="h-3 w-3" />{m.label}</span>;
}

/** Metadata-only preview: plain text as a safe excerpt, never media URLs. */
export function SavedMessageCard({ m, compact }: { m: AdvertisingSavedMessage; compact?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2"><MediaKindBadge kind={m.mediaKind} /><span className="font-mono text-[11px] text-muted-foreground">#{m.id} · {dateTime(m.date)}</span></div>
      <p className={cn("mt-1.5 whitespace-pre-wrap break-words text-sm", compact ? "line-clamp-3" : "line-clamp-4", !m.text && "italic text-muted-foreground")}>{m.text || (m.mediaKind === "text" ? "Empty message" : "No caption")}</p>
    </div>
  );
}

type Loaded = { accountId: string; messages: AdvertisingSavedMessage[]; next: number | null };

export function SavedMessagePicker({ accountId, ready, blockedReason, value, onChange }: {
  accountId: string | null; ready: boolean; blockedReason: string; value: AdvertisingSavedMessage | null; onChange: (m: AdvertisingSavedMessage | null) => void;
}) {
  const load = useLoadAdvertisingSavedMessages({ mutation: { gcTime: 0 } });
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState("");
  const reqRef = useRef(0);
  useEffect(() => () => { reqRef.current++; }, []);
  const list = data && data.accountId === accountId ? data : null;

  async function fetchPage(more: boolean) {
    if (!ready || !accountId || load.isPending) return;
    const req = ++reqRef.current; setErr("");
    try {
      const r = await load.mutateAsync({ data: more && list?.next ? { offsetId: list.next } : {} });
      if (req !== reqRef.current) return;
      if (r.accountId !== accountId) { setData(null); setErr("The connected account changed while loading. Load again."); return; }
      const refreshed = value && r.messages.find(m => m.id === value.id);
      if (refreshed && refreshed.fingerprint !== value?.fingerprint) {
        onChange(null);
        setErr("The selected message changed in Telegram. Select its updated version before starting.");
      }
      const base = more && list ? list.messages : [];
      const seen = new Set(base.map(m => m.id));
      setData({ accountId, messages: [...base, ...r.messages.filter(m => !seen.has(m.id) && m.accountId === accountId)], next: r.nextOffsetId });
    } catch (x) { if (req === reqRef.current) setErr(errMsg(x)); }
    finally { load.reset(); }
  }

  return (
    <Panel title="Source message" meta={<span className="inline-flex items-center gap-1"><Bookmark className="h-3 w-3" />Saved Messages</span>}>
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">Pick one message you already saved in Telegram. Telecart forwards that original, so its formatting, custom emoji and media stay exactly as they are in Telegram. Only a text excerpt is shown here; media and custom artwork appear in Telegram itself. Messages Telegram marks as protected cannot be forwarded.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={list ? "outline" : "default"} disabled={!ready || load.isPending} onClick={() => fetchPage(false)} data-testid="button-load-saved-messages">
            {load.isPending && !list ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : list ? <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> : <Bookmark className="mr-1.5 h-3.5 w-3.5" />}{list ? "Refresh" : "Load Saved Messages"}
          </Button>
          {list && <span className="font-mono text-[11px] text-muted-foreground" data-testid="text-saved-count">{list.messages.length} loaded</span>}
          {!ready && <span className="text-xs text-signal" data-testid="text-saved-blocked">{blockedReason}</span>}
        </div>
        {err && <p role="alert" className="text-sm text-destructive" data-testid="error-saved-messages">{err}</p>}
        {value && (!list || !list.messages.some(m => m.id === value.id)) && (
          <div className="rounded-lg border-2 border-primary/40 bg-primary/5 p-3" data-testid="card-selected-source">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-primary">Selected source</div>
            <SavedMessageCard m={value} compact />
            <button type="button" className="mt-2 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => onChange(null)} data-testid="button-clear-source">Clear selection</button>
          </div>
        )}
        {list && (list.messages.length === 0
          ? <EmptyState icon={Bookmark} title="Saved Messages is empty" body="Save or forward your advert to Saved Messages in Telegram, then press Refresh." />
          : <div role="radiogroup" aria-label="Saved messages" className="max-h-[440px] divide-y overflow-y-auto rounded-lg border">
              {list.messages.map(m => {
                const on = value?.id === m.id && value.fingerprint === m.fingerprint;
                return (
                  <button key={m.id} type="button" role="radio" aria-checked={on} disabled={!m.canForward} onClick={() => onChange(m)} data-testid={`radio-saved-${m.id}`}
                    className={cn("flex w-full items-start gap-3 p-3 text-left transition-colors", on ? "bg-primary/5" : "hover:bg-muted/40", !m.canForward && "cursor-not-allowed opacity-55 hover:bg-transparent")}>
                    <span className={cn("mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full border-2", on ? "border-primary" : "border-input")}>{on && <span className="h-2 w-2 rounded-full bg-primary" />}</span>
                    <div className="min-w-0 flex-1">
                      <SavedMessageCard m={m} compact />
                      {!m.canForward && <p className="mt-1 inline-flex items-center gap-1 text-xs text-signal"><Lock className="h-3 w-3" />{m.reason || "Telegram does not allow forwarding this message."}</p>}
                    </div>
                  </button>
                );
              })}
            </div>)}
        {list?.next && <Button size="sm" variant="ghost" className="w-full" disabled={!ready || load.isPending} onClick={() => fetchPage(true)} data-testid="button-load-more-saved">{load.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="mr-1.5 h-3.5 w-3.5" />}Load more</Button>}
      </div>
    </Panel>
  );
}
