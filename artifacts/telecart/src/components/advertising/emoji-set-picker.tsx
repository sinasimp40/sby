import { useState } from "react";
import { useLoadAdvertisingEmojiSet, type AdvertisingEmojiSet, type AdvertisingEmoji } from "@workspace/api-client-react";
import { Loader2, Lock, PackageOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errMsg } from "@/lib/format";
import { cn } from "@/lib/utils";

export function EmojiSetPicker({ connected, onPick }: { connected: boolean; onPick: (e: AdvertisingEmoji) => void }) {
  const load = useLoadAdvertisingEmojiSet();
  const [link, setLink] = useState("");
  const [set, setSet] = useState<AdvertisingEmojiSet | null>(null);
  const [err, setErr] = useState("");
  async function go() {
    if (!connected || !link.trim() || load.isPending) return;
    setErr("");
    setSet(null);
    try { setSet(await load.mutateAsync({ data: { link: link.trim() } })); } catch (x) { setErr(errMsg(x)); setSet(null); }
  }
  const usable = set?.emojis.filter(e => e.available) ?? [];
  const locked = set?.emojis.filter(e => !e.available) ?? [];
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3" data-testid="panel-emoji-set">
      <div className="flex gap-2">
        <Input value={link} maxLength={512} onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && link.trim() && connected) { e.preventDefault(); void go(); } }} placeholder="t.me/addemoji/PackName or PackName" className="font-mono text-xs" data-testid="input-emoji-set-link" />
        <Button size="sm" variant="outline" disabled={!connected || !link.trim() || load.isPending} onClick={go} data-testid="button-load-emoji-set">{load.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <PackageOpen className="mr-1 h-3.5 w-3.5" />}Load pack</Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{connected ? "Read-only lookup through your connected account. Nothing is installed or posted." : "Connect your Telegram account to look up emoji packs."}</p>
      {err && <p role="alert" className="text-xs text-destructive" data-testid="error-emoji-set">{err}</p>}
      {set && <div className="space-y-2">
        <div className="flex items-baseline gap-2"><span className="text-sm font-medium" data-testid="text-emoji-set-title">{set.title}</span><span className="font-mono text-[11px] text-muted-foreground">{usable.length} usable · {locked.length} locked</span></div>
        {set.emojis.length === 0 && <p className="text-xs text-muted-foreground">This pack has no emoji.</p>}
        <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
          {set.emojis.map(e => (
            <button key={e.documentId} type="button" disabled={!connected || load.isPending || !e.available} onClick={() => onPick(e)} title={e.available ? `Insert (ID ${e.documentId})` : "Needs account eligibility, usually Telegram Premium"}
              className={cn("relative grid h-9 w-9 place-items-center rounded-md border bg-card text-lg transition-transform", e.available ? "hover:-translate-y-0.5 hover:border-primary" : "cursor-not-allowed opacity-40")} data-testid={`button-emoji-${e.documentId}`}>
              {e.emoji}{!e.available && <Lock className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5" />}
            </button>
          ))}
        </div>
        {locked.length > 0 && <p className="text-[11px] text-signal">Locked emoji need your account to be eligible to send them, usually Telegram Premium. They cannot be inserted.</p>}
        <p className="text-[11px] text-muted-foreground">The buttons show the ordinary fallback character. Telegram shows the chosen custom emoji in the posted message.</p>
      </div>}
    </div>
  );
}
