import { useState } from "react";
import type { CoinButtonIcon } from "@workspace/api-client-react";
import { RotateCcw, Sparkles, ChevronDown, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomEmojiPicker, EmojiPreview } from "@/components/custom-emoji-picker";
import { cn } from "@/lib/utils";

export const COIN_META = [
  { id: "BTC", symbol: "₿", label: "Bitcoin · BTC" },
  { id: "ETH", symbol: "Ξ", label: "Ethereum · ETH" },
  { id: "LTC", symbol: "Ł", label: "Litecoin · LTC" },
  { id: "USDTTRC20", symbol: "₮", label: "USDT · TRON (TRC20)" },
  { id: "USDTERC20", symbol: "₮", label: "USDT · Ethereum (ERC20)" },
  { id: "BNBBSC", symbol: "◆", label: "BNB · Smart Chain (BSC)" },
  { id: "SOL", symbol: "◎", label: "Solana · SOL" },
] as const;

const QUICK = ["₿", "Ξ", "Ł", "◎", "₮", "◆"];
export type CoinIconMap = Record<string, CoinButtonIcon>;

function CoinRow({ coin, entry, accepted, open, onToggle, onChange }: {
  coin: (typeof COIN_META)[number]; entry?: CoinButtonIcon; accepted: boolean; open: boolean;
  onToggle: () => void; onChange: (v: CoinButtonIcon | undefined) => void;
}) {
  const isDefault = !entry;
  const emoji = entry?.emoji ?? coin.symbol;
  const custom = entry?.customEmojiId ?? null;
  const set = (patch: CoinButtonIcon) => onChange({ emoji, customEmojiId: custom, ...patch });
  const textPreview = !custom && emoji ? `${emoji} ${coin.label}` : coin.label;

  return (
    <div className={cn("rounded-lg border transition-colors", open ? "border-primary/50 bg-accent/30" : "border-border bg-background")} data-testid={`row-coin-icon-${coin.id}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-3 py-2.5 text-left" data-testid={`button-expand-coin-icon-${coin.id}`} aria-expanded={open}>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border bg-card text-lg">
          {custom ? <EmojiPreview customEmojiId={custom} fallback={emoji} className="h-6 w-6" /> : emoji ? <span aria-hidden>{emoji}</span> : <span className="text-[10px] text-muted-foreground">none</span>}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" data-testid={`text-coin-preview-${coin.id}`}>{textPreview}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>{coin.id}</span>
            <span className={cn("rounded px-1", isDefault ? "bg-muted" : "bg-primary/15 text-primary")}>{isDefault ? "default" : custom ? "custom" : emoji ? "normal" : "no icon"}</span>
            {!accepted && <span className="rounded bg-muted px-1">not accepted</span>}
          </span>
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/70 px-3 pb-3 pt-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`coin-emoji-${coin.id}`}>Normal emoji / fallback</label>
            <div className="flex flex-wrap gap-1.5">
              <Input id={`coin-emoji-${coin.id}`} value={emoji} maxLength={32} onChange={e => set({ emoji: e.target.value })}
                placeholder="Empty = no normal icon" className="h-8 w-40 text-sm" data-testid={`input-coin-emoji-${coin.id}`} />
              {QUICK.map(s => (
                <button key={s} type="button" onClick={() => set({ emoji: s })} data-testid={`button-coin-symbol-${coin.id}-${s}`}
                  className={cn("grid h-8 w-8 place-items-center rounded-md border text-sm hover:border-primary/60", emoji === s && "border-primary bg-accent")}>{s}</button>
              ))}
              <Button type="button" size="sm" variant="ghost" className="h-8" disabled={!emoji} onClick={() => set({ emoji: "" })} data-testid={`button-clear-coin-emoji-${coin.id}`}>Clear</Button>
            </div>
          </div>
          <CustomEmojiPicker open={open} value={custom} fallbackEmoji={emoji} onChange={id => set({ customEmojiId: id })} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Default is {coin.symbol} with no custom icon.</span>
            <Button type="button" size="sm" variant="outline" disabled={isDefault} onClick={() => onChange(undefined)} data-testid={`button-reset-coin-icon-${coin.id}`}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" />Reset to default
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CoinIconEditor({ value, onChange, accepted }: { value: CoinIconMap; onChange: (v: CoinIconMap) => void; accepted: readonly string[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const customised = Object.keys(value).length;
  return (
    <div className="space-y-3" data-testid="coin-icon-editor">
      <div className="flex gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <p>Custom icons require Telegram Premium on the <span className="font-medium text-foreground">bot owner</span> account, or an additional bot username purchased on Fragment — buyers need no Premium. A custom icon wins over the normal icon. If Telegram rejects it, your normal fallback is used; clearing it leaves text only. Icons for coins you don't accept are kept for later.</p>
      </div>
      <div className="space-y-2">
        {COIN_META.map(c => (
          <CoinRow key={c.id} coin={c} entry={value[c.id]} accepted={accepted.includes(c.id)} open={openId === c.id}
            onToggle={() => setOpenId(o => (o === c.id ? null : c.id))}
            onChange={v => { const next = { ...value }; if (v) next[c.id] = v; else delete next[c.id]; onChange(next); }} />
        ))}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Sparkles className="h-3.5 w-3.5" /><span data-testid="text-coin-icons-count">{customised} of {COIN_META.length} customised</span></span>
        <Button type="button" size="sm" variant="ghost" disabled={!customised} onClick={() => onChange({})} data-testid="button-reset-all-coin-icons">Reset all</Button>
      </div>
    </div>
  );
}
