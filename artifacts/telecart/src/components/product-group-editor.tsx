import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateProductGroup, useUpdateProductGroup, getListProductGroupsQueryKey, getListProductsQueryKey,
  getGetOverviewQueryKey, getListActivityQueryKey,
} from "@workspace/api-client-react";
import type { Product, ProductGroup, ProductGroupInput } from "@workspace/api-client-react";
import { Plus, Trash2, Archive, ArchiveRestore, Loader2, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { errMsg, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CustomEmojiPicker, EmojiPreview } from "@/components/custom-emoji-picker";
import { ProductMediaPreview, isProductImageUrl } from "@/components/product-media-preview";

type Status = "active" | "draft" | "archived";
type Format = "email:pass" | "user:pass";
type OptionDraft = { key: string; id?: number; name: string; description: string; price: string; status: Status; deliveryFormat: Format; stock: number; sold: number };
type Draft = { name: string; description: string; imageUrl: string; buttonEmoji: string; buttonCustomEmojiId: string | null; options: OptionDraft[] };

const selectClassName = "h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50";
const PRESETS = ["🛍", "🎮", "🔑", "🎬", "🎵", "📚", "💎", "⚡", "🚀", "🎨"];
let seq = 0;
const k = () => `o${++seq}`;
const blankOption = (name = ""): OptionDraft => ({ key: k(), name, description: "", price: "", status: "draft", deliveryFormat: "email:pass", stock: 0, sold: 0 });
const fromProduct = (p: Product, name: string): OptionDraft => ({ key: k(), id: p.id, name, description: p.description, price: String(p.price), status: p.status, deliveryFormat: p.deliveryFormat, stock: p.stock, sold: p.sold });

function initial(group: ProductGroup | null, convert: Product | null): Draft {
  if (group) return {
    name: group.name, description: group.description, imageUrl: group.imageUrl ?? "", buttonEmoji: group.buttonEmoji ?? "",
    buttonCustomEmojiId: group.buttonCustomEmojiId ?? null,
    options: group.options.map(o => fromProduct(o, o.optionName ?? o.name)),
  };
  if (convert) return {
    name: convert.name.slice(0, 80), description: "", imageUrl: convert.imageUrl ?? "", buttonEmoji: convert.buttonEmoji ?? "🛍",
    buttonCustomEmojiId: convert.buttonCustomEmojiId ?? null,
    options: [fromProduct(convert, "Standard"), blankOption()],
  };
  return { name: "", description: "", imageUrl: "", buttonEmoji: "🛍", buttonCustomEmojiId: null, options: [blankOption(), blankOption(), blankOption()] };
}

function validate(d: Draft): string | null {
  if (!d.name.trim()) return "Group name is required.";
  if (d.name.trim().length > 80) return "Group name max 80 characters.";
  if (d.description.length > 2000) return "Group description max 2000 characters.";
  if (d.imageUrl.trim() && !isProductImageUrl(d.imageUrl.trim())) return "Image link must be a public HTTPS .jpg, .jpeg, .png, .webp or .gif.";
  if (d.options.length < 1 || d.options.length > 20) return "A group needs 1 to 20 options.";
  const names = new Set<string>();
  for (const [i, o] of d.options.entries()) {
    const n = o.name.trim();
    if (!n) return `Option ${i + 1} needs a name.`;
    if (n.length > 36) return `Option "${n}" name max 36 characters.`;
    if (names.has(n.toLowerCase())) return `Option name "${n}" is used twice.`;
    names.add(n.toLowerCase());
    const p = Number(o.price);
    if (!o.price || !Number.isFinite(p) || p < 0.01 || p > 100000) return `Option "${n}" needs a price between $0.01 and $100,000.`;
    if (o.description.length > 2000) return `Option "${n}" description max 2000 characters.`;
  }
  return null;
}

export function ProductGroupEditor({ open, onOpenChange, group, convertFrom }: {
  open: boolean; onOpenChange: (o: boolean) => void; group: ProductGroup | null; convertFrom: Product | null;
}) {
  const create = useCreateProductGroup();
  const update = useUpdateProductGroup();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [d, setD] = useState<Draft>(() => initial(group, convertFrom));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setD(initial(group, convertFrom)); setError(null); } }, [open, group, convertFrom]);
  const pending = create.isPending || update.isPending;
  const set = <K extends keyof Draft>(key: K, v: Draft[K]) => setD(s => ({ ...s, [key]: v }));
  const setOpt = (key: string, patch: Partial<OptionDraft>) => setD(s => ({ ...s, options: s.options.map(o => o.key === key ? { ...o, ...patch } : o) }));

  const submit = () => {
    const msg = validate(d); setError(msg); if (msg) return;
    const data: ProductGroupInput = {
      name: d.name.trim(), description: d.description, imageUrl: d.imageUrl.trim() || null,
      buttonEmoji: d.buttonEmoji, buttonCustomEmojiId: d.buttonCustomEmojiId,
      options: d.options.map(o => ({ ...(o.id ? { id: o.id } : {}), name: o.name.trim(), description: o.description, price: Number(o.price), status: o.status, deliveryFormat: o.deliveryFormat })),
    };
    const opts = {
      onSuccess: () => {
        for (const key of [getListProductGroupsQueryKey(), getListProductsQueryKey(), getGetOverviewQueryKey(), getListActivityQueryKey()]) qc.invalidateQueries({ queryKey: key });
        toast({ title: group ? "Group updated" : convertFrom ? "Options added" : "Grouped product created", description: data.name });
        onOpenChange(false);
      },
      onError: (e: unknown) => { setError(errMsg(e)); toast({ variant: "destructive", title: "Could not save group", description: errMsg(e) }); },
    };
    if (group) update.mutate({ id: group.id, data }, opts); else create.mutate({ data }, opts);
  };

  const title = group ? "Edit grouped product" : convertFrom ? "Add options" : "New grouped product";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{title}</DialogTitle>
          <DialogDescription>
            {convertFrom ? <>“{convertFrom.name}” becomes the first option and keeps its ID, inventory and order history. Label it, then add more.</>
              : "One catalog entry in Telegram; each option has its own price, stock and inventory."}
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-3">
          <p className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">Shared group</p>
          <div className="space-y-1.5"><label className="text-sm font-medium" htmlFor="group-name">Group name</label>
            <Input id="group-name" maxLength={80} value={d.name} disabled={pending} onChange={e => set("name", e.target.value)} placeholder="Replit" data-testid="input-group-name" /></div>
          <div className="space-y-1.5"><label className="text-sm font-medium" htmlFor="group-desc">Common description <span className="font-normal text-muted-foreground">(applies to every option)</span></label>
            <Textarea id="group-desc" rows={2} maxLength={2000} value={d.description} disabled={pending} onChange={e => set("description", e.target.value)} placeholder="Shared terms, warranty, region…" data-testid="input-group-description" /></div>
          <div className="space-y-1.5"><label className="text-sm font-medium" htmlFor="group-image">Image or GIF link <span className="font-normal text-muted-foreground">(optional)</span></label>
            <Input id="group-image" type="url" value={d.imageUrl} disabled={pending} onChange={e => set("imageUrl", e.target.value)} placeholder="https://example.com/product.gif" data-testid="input-group-image-url" />
            <p className="text-xs text-muted-foreground">Direct public JPG, PNG, WebP or GIF link shared by all options. Clear to remove.</p>
            <ProductMediaPreview url={d.imageUrl.trim()} name={d.name} />
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Normal emoji / fallback <span className="font-normal text-muted-foreground">(optional)</span></span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested group emojis">
              {PRESETS.map(emoji => (
                <Button key={emoji} type="button" size="icon" variant={d.buttonEmoji === emoji ? "default" : "outline"} disabled={pending}
                  aria-label={`Use ${emoji}`} aria-pressed={d.buttonEmoji === emoji} onClick={() => set("buttonEmoji", d.buttonEmoji === emoji ? "" : emoji)}>{emoji}</Button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input value={d.buttonEmoji} maxLength={32} disabled={pending} onChange={e => set("buttonEmoji", e.target.value)} placeholder="Paste your own emoji" aria-label="Custom group emoji" data-testid="input-group-emoji" />
              <Button type="button" variant="ghost" size="sm" disabled={pending || !d.buttonEmoji} onClick={() => set("buttonEmoji", "")} data-testid="button-clear-group-emoji">Clear</Button>
            </div>
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="group-button-preview">
              <EmojiPreview customEmojiId={d.buttonCustomEmojiId} fallback={d.buttonEmoji} className="mr-1 h-5 w-5" />{d.name || "Group name"}
            </div>
          </div>
          <CustomEmojiPicker open={open} value={d.buttonCustomEmojiId} disabled={pending} fallbackEmoji={d.buttonEmoji} onChange={id => set("buttonCustomEmojiId", id)} />
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">Options · {d.options.length}/20</p>
            <Button type="button" size="sm" variant="outline" disabled={pending || d.options.length >= 20} onClick={() => set("options", [...d.options, blankOption()])} data-testid="button-add-option">
              <Plus className="mr-1 h-3.5 w-3.5" />Add option</Button>
          </div>
          {d.options.map((o, i) => (
            <div key={o.key} className={cn("pop space-y-2 rounded-lg border bg-card p-3", o.status === "archived" && "bg-muted/40 opacity-75")} data-testid={`card-option-${i}`}>
              <div className="flex items-center gap-2">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-muted font-mono text-[11px]">{i + 1}</span>
                <Input value={o.name} maxLength={36} disabled={pending} onChange={e => setOpt(o.key, { name: e.target.value })} placeholder="Option name, e.g. Core 1 month" className="h-8" aria-label={`Option ${i + 1} name`} data-testid={`input-option-name-${i}`} />
                {o.id ? (
                  <Button type="button" size="sm" variant="ghost" className="h-8 shrink-0" disabled={pending}
                    title={o.status === "archived" ? "Restore as draft" : "Archive — saved options keep their inventory and cannot be removed"}
                    onClick={() => setOpt(o.key, { status: o.status === "archived" ? "draft" : "archived" })} data-testid={`button-archive-option-${i}`}>
                    {o.status === "archived" ? <><ArchiveRestore className="mr-1 h-3.5 w-3.5" />Restore</> : <><Archive className="mr-1 h-3.5 w-3.5" />Archive</>}
                  </Button>
                ) : (
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-destructive hover:text-destructive" disabled={pending || d.options.length <= 1}
                    aria-label="Remove unsaved option" onClick={() => set("options", d.options.filter(x => x.key !== o.key))} data-testid={`button-remove-option-${i}`}><Trash2 className="h-4 w-4" /></Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input type="number" step="0.01" min="0.01" value={o.price} disabled={pending} onChange={e => setOpt(o.key, { price: e.target.value })} placeholder="Price USD" className="h-8 font-mono" aria-label="Price" data-testid={`input-option-price-${i}`} />
                <select value={o.status} disabled={pending} onChange={e => setOpt(o.key, { status: e.target.value as Status })} className={cn(selectClassName, "h-8")} aria-label="Status" data-testid={`select-option-status-${i}`}>
                  <option value="active">Active</option><option value="draft">Draft</option><option value="archived">Archived</option>
                </select>
              </div>
              <Textarea rows={2} maxLength={2000} value={o.description} disabled={pending} onChange={e => setOpt(o.key, { description: e.target.value })} placeholder="What this option includes" aria-label="Option description" data-testid={`input-option-description-${i}`} />
              <p className="font-mono text-[11px] text-muted-foreground">
                {o.id ? <>#{o.id} · {o.stock} in stock · {o.sold} sold{o.price && Number(o.price) > 0 ? ` · ${money(Number(o.price))}` : ""}</> : "New option — import stock after saving"}
              </p>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Saved options can only be archived, never dropped, so inventory and IDs stay intact. Only active options with stock appear in Telegram.</p>
        </section>

        {error && <p role="alert" className="rounded-md border border-destructive/30 px-3 py-2 text-sm text-destructive" data-testid="error-group-form">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={pending} onClick={submit} data-testid="button-save-group">
            {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Layers className="mr-1.5 h-4 w-4" />}{group ? "Save group" : "Create group"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
