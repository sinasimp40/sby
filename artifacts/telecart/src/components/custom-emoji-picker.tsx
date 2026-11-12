import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCustomEmojis, getListCustomEmojisQueryKey, useImportCustomEmojiPack, useStartEmojiImport,
  useStopEmojiImport, useDeleteCustomEmoji, getListProductsQueryKey,
  getPreviewCustomEmojiUrl,
} from "@workspace/api-client-react";
import type { CustomEmoji } from "@workspace/api-client-react";
import { Search, RefreshCw, Link2, Send, X, Trash2, Loader2, ExternalLink, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/format";
import { cn } from "@/lib/utils";

const PAGE = 48;

export function EmojiPreview({ item, customEmojiId, fallback, className }: { item?: CustomEmoji | null; customEmojiId?: string | null; fallback: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const previewUrl = item?.previewUrl || (customEmojiId ? getPreviewCustomEmojiUrl(customEmojiId) : null);
  useEffect(() => setFailed(false), [previewUrl]);
  if (!previewUrl || failed) {
    const emoji = item?.emoji || fallback;
    return emoji ? <span className={cn("inline-grid place-items-center", className)} aria-hidden>{emoji}</span> : null;
  }
  return <img src={previewUrl} alt="Selected custom product icon" loading="lazy" decoding="async" onError={() => setFailed(true)} className={cn("inline-block shrink-0 object-contain align-middle", className)} />;
}

export function CustomEmojiPicker({ open, value, onChange, fallbackEmoji, disabled }: {
  open: boolean; value: string | null; onChange: (id: string | null) => void; fallbackEmoji: string; disabled?: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [session, setSession] = useState<{ url: string; expiresAt: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const sessionAlive = !!session && new Date(session.expiresAt).getTime() > now;
  const lib = useListCustomEmojis({ query: { queryKey: getListCustomEmojisQueryKey(), enabled: open, refetchInterval: open && sessionAlive ? 3000 : false } });
  const importPack = useImportCustomEmojiPack();
  const start = useStartEmojiImport();
  const stop = useStopEmojiImport();
  const del = useDeleteCustomEmoji();
  const [pack, setPack] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [deleting, setDeleting] = useState<CustomEmoji | null>(null);

  useEffect(() => { if (!session) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [session]);
  useEffect(() => { if (!open) setSession(null); }, [open]);
  useEffect(() => setPage(0), [q]);

  const items = lib.data?.items ?? [];
  const selected = items.find(i => i.id === value) ?? null;
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter(i => (i.setName ?? "").toLowerCase().includes(s) || i.id.includes(s) || i.emoji.includes(q.trim())) : items;
  }, [items, q]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  useEffect(() => setPage(current => Math.min(current, pages - 1)), [pages]);
  const visible = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const refreshLib = () => qc.invalidateQueries({ queryKey: getListCustomEmojisQueryKey() });
  const secsLeft = session ? Math.max(0, Math.round((new Date(session.expiresAt).getTime() - now) / 1000)) : 0;

  const doImport = () => {
    const p = pack.trim(); if (!p) return;
    importPack.mutate({ data: { pack: p } }, {
      onSuccess: r => { refreshLib(); setPack(""); toast({ title: "Pack imported", description: `${r.imported} new, ${r.updated} updated · ${r.total} in library` }); },
      onError: e => toast({ variant: "destructive", title: "Pack import failed", description: errMsg(e) }),
    });
  };
  const doStart = () => start.mutate(undefined, {
    onSuccess: s => setSession(s),
    onError: e => toast({ variant: "destructive", title: "Could not start import", description: errMsg(e) }),
  });
  const doStop = () => stop.mutate(undefined, {
    onSuccess: () => { setSession(null); refreshLib(); toast({ title: "Import link revoked" }); },
    onError: e => toast({ variant: "destructive", title: "Could not revoke link", description: errMsg(e) }),
  });
  const doDelete = (item: CustomEmoji) => del.mutate({ id: item.id }, {
    onSuccess: () => {
      if (value === item.id) onChange(null);
      refreshLib(); qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
      setDeleting(null); toast({ title: "Icon removed from library" });
    },
    onError: e => toast({ variant: "destructive", title: "Delete failed", description: errMsg(e) }),
  });

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3" data-testid="custom-emoji-picker">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Custom Telegram icon <span className="font-normal text-muted-foreground">(optional)</span></p>
          <p className="mt-0.5 text-xs text-muted-foreground">Needs the bot owner to have Telegram Premium or a Fragment username. Customers don't need Premium. Sticker packs and photos can't be button icons. If unavailable, the bot uses your normal fallback or no icon if cleared.</p>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => lib.refetch()} disabled={lib.isFetching} data-testid="button-refresh-emojis" aria-label="Refresh library">
          <RefreshCw className={cn("h-3.5 w-3.5", lib.isFetching && "animate-spin")} />
        </Button>
      </div>

      <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-2 text-sm" data-testid="text-custom-selection">
        {value ? <>
          <EmojiPreview item={selected} customEmojiId={value} fallback={fallbackEmoji} className="h-6 w-6 text-lg" />
          <span className="min-w-0 flex-1 truncate">{selected ? (selected.setName ?? "Imported icon") : "Saved icon (not in loaded library)"} <span className="font-mono text-[11px] text-muted-foreground">#{value}</span></span>
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange(null)} data-testid="button-clear-custom-emoji">Remove custom icon</Button>
        </> : <span className="text-muted-foreground">{fallbackEmoji ? "None selected — button uses the normal emoji." : "None selected — button has no icon."}</span>}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor="emoji-pack">Import by pack link</label>
          <div className="flex gap-1.5">
            <Input id="emoji-pack" value={pack} onChange={e => setPack(e.target.value)} maxLength={250} placeholder="t.me/addemoji/PackName" className="h-8 text-xs"
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); doImport(); } }} data-testid="input-emoji-pack" />
            <Button type="button" size="sm" className="h-8" disabled={disabled || !pack.trim() || importPack.isPending} onClick={doImport} data-testid="button-import-pack" aria-label="Import emoji pack">
              {importPack.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Full link or bare PackName of a custom emoji pack.</p>
        </div>
        <div className="space-y-1.5">
          <span className="text-xs font-medium">Import by sending to the bot</span>
          {sessionAlive && session ? (
            <div className="flex gap-1.5">
              <Button type="button" size="sm" className="h-8 flex-1" asChild>
                <a href={session.url} target="_blank" rel="noopener noreferrer" data-testid="link-emoji-import"><ExternalLink className="mr-1 h-3.5 w-3.5" />Open Telegram</a>
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-8" disabled={stop.isPending} onClick={doStop} data-testid="button-stop-import">
                {stop.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}Stop
              </Button>
            </div>
          ) : (
            <Button type="button" size="sm" variant="outline" className="h-8 w-full" disabled={disabled || start.isPending} onClick={doStart} data-testid="button-start-import">
              {start.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />}{session ? "Link expired — start again" : "Start import"}
            </Button>
          )}
          <p className="text-[11px] text-muted-foreground" data-testid="text-import-status">
            {sessionAlive ? <>Link expires in <span className="font-mono">{Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, "0")}</span>. Send custom emoji or custom emoji stickers, then /done. Library refreshes every 3s.</>
              : "Start, open the private link, send custom emojis, /done, then pick one and save."}
          </p>
        </div>
      </div>

      <div className="relative"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === "Enter") e.preventDefault(); }} placeholder="Search pack name, ID or emoji" className="h-8 pl-8 text-xs" data-testid="input-search-emojis" aria-label="Search custom emojis" /></div>

      {lib.isLoading ? (
        <div className="grid grid-cols-8 gap-1.5">{Array.from({ length: 16 }).map((_, i) => <div key={i} className="aspect-square animate-pulse rounded-md bg-muted" />)}</div>
      ) : lib.isError ? (
        <div className="flex items-center justify-between rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">Could not load your icon library. {errMsg(lib.error)}
          <Button type="button" size="sm" variant="outline" onClick={() => lib.refetch()}>Retry</Button></div>
      ) : !items.length ? (
        <div className="rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground" data-testid="empty-emoji-library">
          <p className="font-medium text-foreground">Your icon library is empty</p>
          <p className="mt-1">Import a custom emoji pack by link, or start an import and send emojis to your bot. Only icons you import appear here.</p>
        </div>
      ) : !filtered.length ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No icons match “{q}”.</p>
      ) : (
        <>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8" role="listbox" aria-label="Custom icons">
            {visible.map(item => (
              <div key={item.id} className="group relative">
                <button type="button" role="option" aria-selected={value === item.id} disabled={disabled}
                  title={`${item.setName ?? "Imported"} · ${item.format} · #${item.id}`}
                  onClick={() => onChange(value === item.id ? null : item.id)} data-testid={`button-custom-emoji-${item.id}`}
                  className={cn("grid aspect-square w-full place-items-center rounded-md border bg-background p-1 text-xl transition-colors hover:border-primary/60",
                    value === item.id && "border-primary ring-2 ring-primary/30")}>
                  <EmojiPreview item={item} fallback={item.emoji} className="h-8 w-8" />
                </button>
                <button type="button" aria-label="Delete icon" disabled={disabled || del.isPending} onClick={() => setDeleting(item)} data-testid={`button-delete-custom-emoji-${item.id}`}
                  className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full border bg-card text-destructive shadow-sm sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground">
            <span>{filtered.length} of {items.length} / {lib.data?.maxItems ?? 2000} max</span>
            <div className="flex items-center gap-1">
              <Button type="button" size="icon" variant="ghost" className="h-6 w-6" disabled={page === 0} onClick={() => setPage(p => p - 1)} aria-label="Previous page"><ChevronLeft className="h-3.5 w-3.5" /></Button>
              <span>{page + 1}/{pages}</span>
              <Button type="button" size="icon" variant="ghost" className="h-6 w-6" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)} aria-label="Next page"><ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        </>
      )}

      <AlertDialog open={!!deleting} onOpenChange={o => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Remove this icon from your library?</AlertDialogTitle>
            <AlertDialogDescription>Any products using it will revert to their normal emoji.{deleting && value === deleting.id ? " It is selected in this form and will be cleared." : ""}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={del.isPending} data-testid="button-confirm-delete-emoji"
              onClick={e => { e.preventDefault(); if (deleting) doDelete(deleting); }}>{del.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Remove icon</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
