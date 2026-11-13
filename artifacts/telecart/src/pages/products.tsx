import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useListProducts, useCreateProduct, useUpdateProduct, useDeleteProduct, getListProductsQueryKey, useListProductGroups, useDeleteProductGroup, getListProductGroupsQueryKey, getGetOverviewQueryKey, getListActivityQueryKey } from "@workspace/api-client-react";
import type { Product, ProductGroup } from "@workspace/api-client-react";
import { Plus, Pencil, Trash2, Package, Search, KeyRound, Loader2, Layers, ChevronRight } from "lucide-react";
import { ProductGroupEditor } from "@/components/product-group-editor";
import { PageHeader, Panel, EmptyState, ErrorState, RowsSkeleton, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { useAuthGate } from "@/components/auth-gate";
import { money, shortDate, errMsg } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CustomEmojiPicker, EmojiPreview } from "@/components/custom-emoji-picker";
import { ProductMediaPreview, isProductImageUrl } from "@/components/product-media-preview";

const schema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().max(2000),
  imageUrl: z.string().trim().max(2048).refine(value => !value || isProductImageUrl(value),
    "Use a public HTTPS link ending in .jpg, .jpeg, .png, .webp or .gif."),
  price: z.coerce.number({ invalid_type_error: "Enter a price" }).min(0.01, "Minimum $0.01").max(100000, "Maximum $100,000"),
  status: z.enum(["active", "draft", "archived"]),
  deliveryFormat: z.enum(["email:pass", "user:pass"]),
  buttonEmoji: z.union([z.literal(""), z.string().max(32).emoji("Enter an emoji, not text or an image URL")
    .refine(value => Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)).length === 1, "Choose just one emoji")]),
  buttonCustomEmojiId: z.string().regex(/^[0-9]{1,30}$/).nullable(),
});
type FormValues = z.infer<typeof schema>;
const blank: FormValues = { name: "", description: "", imageUrl: "", price: 0, status: "draft", deliveryFormat: "email:pass", buttonEmoji: "🛍", buttonCustomEmojiId: null };
const selectClassName = "h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
    qc.invalidateQueries({ queryKey: getListProductGroupsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetOverviewQueryKey() });
    qc.invalidateQueries({ queryKey: getListActivityQueryKey() });
  };
}

function ProductDialog({ open, onOpenChange, product }: { open: boolean; onOpenChange: (o: boolean) => void; product: Product | null }) {
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const invalidate = useInvalidate();
  const { toast } = useToast();
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: blank });
  useEffect(() => {
    if (open) form.reset(product ? { name: product.name, description: product.description, imageUrl: product.imageUrl ?? "", price: product.price, status: product.status, deliveryFormat: product.deliveryFormat, buttonEmoji: product.buttonEmoji ?? "🛍", buttonCustomEmojiId: product.buttonCustomEmojiId ?? null } : blank);
  }, [open, product, form]);
  const pending = create.isPending || update.isPending;
  const onSubmit = (v: FormValues) => {
    const opts = {
      onSuccess: () => { invalidate(); toast({ title: product ? "Product updated" : "Product created", description: v.name }); onOpenChange(false); },
      onError: (e: unknown) => toast({ variant: "destructive", title: "Could not save product", description: errMsg(e) }),
    };
    const data = { ...v, imageUrl: v.imageUrl || null };
    if (product) update.mutate({ id: product.id, data }, opts);
    else create.mutate({ data }, opts);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{product ? "Edit product" : "New product"}</DialogTitle>
          <DialogDescription>Only list accounts you are authorized to resell. Stock comes from inventory imports.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>Name</FormLabel><FormControl><Input placeholder="Streaming Premium — 1 month" {...field} data-testid="input-product-name" /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="imageUrl" render={({ field }) => (
              <FormItem>
                <FormLabel>Image or GIF link <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
                <FormControl><Input {...field} type="url" disabled={pending} placeholder="https://example.com/product.gif" data-testid="input-product-image-url" /></FormControl>
                <p className="text-xs text-muted-foreground">Direct public JPG, PNG, WebP or GIF link. Shown below the product name in stock alerts and Buy now. GIFs play as animations. Clear the link to remove it.</p>
                <FormMessage />
                <ProductMediaPreview url={field.value} name={form.watch("name")} />
              </FormItem>
            )} />
            <FormField control={form.control} name="buttonEmoji" render={({ field }) => (
              <FormItem>
                <FormLabel>Normal emoji / fallback <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested product emojis">
                  {["🛍", "🎮", "🔑", "🎬", "🎵", "📚", "💎", "⚡", "🚀", "🎨"].map(emoji => (
                    <Button key={emoji} type="button" variant={field.value === emoji ? "default" : "outline"}
                      size="icon" disabled={pending} aria-label={`Use ${emoji}`} aria-pressed={field.value === emoji}
                      onClick={() => form.setValue("buttonEmoji", field.value === emoji ? "" : emoji, { shouldDirty: true, shouldValidate: true })}>
                      {emoji}
                    </Button>
                  ))}
                </div>
                <FormControl><Input {...field} disabled={pending} maxLength={32} placeholder="Paste your own emoji" aria-label="Custom product emoji" data-testid="input-product-emoji" /></FormControl>
                <p className="text-xs text-muted-foreground">Click the selected preset again or clear the input for no normal emoji. A selected custom icon takes priority; the normal emoji is only its fallback.</p>
                <Button type="button" variant="ghost" size="sm" disabled={pending || !field.value}
                  onClick={() => form.setValue("buttonEmoji", "", { shouldDirty: true, shouldValidate: true })}
                  data-testid="button-clear-normal-emoji">Clear normal emoji</Button>
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="product-button-preview">
                  <EmojiPreview customEmojiId={form.watch("buttonCustomEmojiId")} fallback={field.value} className="mr-1 h-5 w-5" />
                  {form.watch("name") || "Product name"} · ${Number(form.watch("price") || 0).toFixed(2)}
                </div>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="buttonCustomEmojiId" render={({ field }) => (
              <CustomEmojiPicker open={open} value={field.value} disabled={pending} fallbackEmoji={form.watch("buttonEmoji")}
                onChange={id => form.setValue("buttonCustomEmojiId", id, { shouldDirty: true })} />
            )} />
            <div>
              <FormField control={form.control} name="price" render={({ field }) => (
                <FormItem><FormLabel>Price (USD)</FormLabel><FormControl><Input type="number" step="0.01" min="0.01" {...field} data-testid="input-product-price" /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea rows={3} placeholder="What the buyer receives, warranty terms, region…" {...field} data-testid="input-product-description" /></FormControl><FormMessage /></FormItem>
            )} />
            <div>
              <FormField control={form.control} name="status" render={({ field }) => (
                <FormItem><FormLabel>Status</FormLabel>
                  <FormControl>
                    <select {...field} disabled={pending} className={selectClassName} data-testid="select-product-status">
                      <option value="active">Active</option><option value="draft">Draft</option><option value="archived">Archived</option>
                    </select>
                  </FormControl>
                  <p className="text-xs text-muted-foreground">Only Active products with available stock appear in Telegram. Drafts stay hidden.</p><FormMessage /></FormItem>
              )} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={pending} data-testid="button-save-product">{pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{product ? "Save changes" : "Create product"}</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const th = "px-3 py-2.5 font-medium";
const groupMatches = (g: ProductGroup, f: string, q: string) =>
  (f === "all" || g.options.some(o => o.status === f)) &&
  (g.name.toLowerCase().includes(q) || g.options.some(o => (o.optionName ?? o.name).toLowerCase().includes(q)));

function ProductActions({ p, onEdit, onDelete, onGroup }: { p: Product; onEdit?: () => void; onDelete?: () => void; onGroup?: () => void }) {
  return <div className="flex justify-end gap-0.5">
    <Button size="icon" variant="ghost" className="h-8 w-8" asChild title="Inventory"><Link href={`/inventory?product=${p.id}`} data-testid={`link-inventory-${p.id}`}><KeyRound className="h-4 w-4" /></Link></Button>
    {onGroup && <Button size="icon" variant="ghost" className="h-8 w-8" title="Add options" onClick={onGroup} data-testid={`button-add-options-${p.id}`}><Layers className="h-4 w-4" /></Button>}
    {onEdit && <Button size="icon" variant="ghost" className="h-8 w-8" title="Edit" onClick={onEdit} data-testid={`button-edit-${p.id}`}><Pencil className="h-4 w-4" /></Button>}
    {onDelete && <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:text-destructive" title="Delete" onClick={onDelete} data-testid={`button-delete-${p.id}`}><Trash2 className="h-4 w-4" /></Button>}
  </div>;
}

export default function ProductsPage() {
  const { data, isLoading, isError, error, refetch } = useListProducts();
  const groupsQ = useListProductGroups();
  const del = useDeleteProduct();
  const delGroup = useDeleteProductGroup();
  const invalidate = useInvalidate();
  const { toast } = useToast();
  const { requireAuth, isSignedIn } = useAuthGate();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "draft" | "archived">("all");
  const [editing, setEditing] = useState<Product | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [groupEditing, setGroupEditing] = useState<ProductGroup | null>(null);
  const [converting, setConverting] = useState<Product | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState<ProductGroup | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const ql = q.toLowerCase();
  const groups = useMemo(() => (groupsQ.data ?? []).filter(g => groupMatches(g, filter, ql)), [groupsQ.data, filter, ql]);
  const rows = useMemo(() => (data ?? []).filter((p) => !p.groupId && (filter === "all" || p.status === filter) && p.name.toLowerCase().includes(ql)), [data, ql, filter]);
  const openNew = () => { if (requireAuth("create products")) { setEditing(null); setDialogOpen(true); } };
  const openEdit = (p: Product) => { if (requireAuth("edit products")) { setEditing(p); setDialogOpen(true); } };
  const askDelete = (p: Product) => { if (requireAuth("delete products")) setDeleting(p); };
  const openGroup = (g: ProductGroup | null, convert: Product | null = null) => { if (requireAuth("edit grouped products")) { setGroupEditing(g); setConverting(convert); setGroupOpen(true); } };
  const askDeleteGroup = (g: ProductGroup) => { if (requireAuth("delete products")) setDeletingGroup(g); };
  const loading = isLoading || groupsQ.isLoading;
  const failed = isError || groupsQ.isError;
  const total = (data?.length ?? 0);
  const dg = deletingGroup;
  const dgStock = dg?.options.reduce((a, o) => a + o.stock, 0) ?? 0;

  return (
    <div>
      <PageHeader eyebrow="Catalog" title="Products" description="What your bot sells. Group variants under one entry; each option keeps its own price, stock and inventory."
        actions={<div className="flex gap-2">
          <Button variant="outline" onClick={() => openGroup(null)} data-testid="button-new-group"><Layers className="mr-1.5 h-4 w-4" />Grouped product</Button>
          <Button onClick={openNew} data-testid="button-new-product"><Plus className="mr-1.5 h-4 w-4" />New product</Button></div>} />
      {!isSignedIn && <div className="mb-4 rounded-lg border border-signal/25 bg-signal-soft px-3 py-2 text-xs text-foreground/80">These are <b>labelled sample products</b> for the preview. Your own shop starts empty.</div>}
      <Panel bodyClassName="p-0">
        <div className="flex flex-col gap-2 border-b border-border/70 p-3 sm:flex-row sm:items-center">
          <div className="relative flex-1"><Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search product or option name" className="pl-8" data-testid="input-search-products" /></div>
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {(["all", "active", "draft", "archived"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} data-testid={`button-filter-${f}`} className={cn("rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors", filter === f ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{f}</button>
            ))}
          </div>
        </div>
        {loading ? <div className="p-4"><RowsSkeleton /></div> : failed ? <div className="p-4"><ErrorState message={((error ?? groupsQ.error) as Error)?.message ?? "Failed to load"} onRetry={() => { refetch(); groupsQ.refetch(); }} /></div> : !rows.length && !groups.length ? (
          <div className="p-4"><EmptyState icon={Package} title={total ? "No matches" : "No products yet"} body={total ? "Try a different search or filter." : "Create a product or a grouped product with options, then import credentials into inventory."} action={!total ? <Button size="sm" onClick={openNew}><Plus className="mr-1 h-3.5 w-3.5" />New product</Button> : undefined} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border/70 text-left font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Product</th><th className={th}>Status</th><th className={cn(th, "text-right")}>Stock</th><th className={cn(th, "text-right")}>Sold</th><th className={cn(th, "text-right")}>Price</th><th className="px-4 py-2.5" /></tr></thead>
              {groups.map(g => {
                const open = expanded[g.id] ?? false;
                const stock = g.options.reduce((a, o) => a + o.stock, 0);
                const sold = g.options.reduce((a, o) => a + o.sold, 0);
                const active = g.options.filter(o => o.status === "active").length;
                return <tbody key={g.id} className="border-b border-border/60" data-testid={`group-${g.id}`}>
                  <tr className="cursor-pointer transition-colors hover:bg-muted/40" onClick={() => setExpanded(s => ({ ...s, [g.id]: !open }))} data-testid={`row-group-${g.id}`}>
                    <td className="max-w-[320px] px-4 py-3"><div className="flex items-center gap-1.5 font-medium">
                      <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                      <EmojiPreview customEmojiId={g.buttonCustomEmojiId} fallback={g.buttonEmoji ?? ""} className="h-5 w-5" />
                      <span className="truncate">{g.name}</span>
                      <span className="ml-1 shrink-0 rounded-full bg-accent px-1.5 py-px font-mono text-[10px] text-accent-foreground">{g.options.length} options</span>
                    </div><div className="truncate pl-5 text-xs text-muted-foreground">{active} active{g.description ? ` · ${g.description}` : ""}</div></td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">Group</td>
                    <td className={cn("tabular px-3 py-3 text-right font-mono", stock === 0 && "text-signal")}>{stock}</td>
                    <td className="tabular px-3 py-3 text-right font-mono text-muted-foreground">{sold}</td>
                    <td className="px-3 py-3 text-right text-xs text-muted-foreground">Per option</td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}><div className="flex justify-end gap-0.5">
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Edit group and options" onClick={() => openGroup(g)} data-testid={`button-edit-group-${g.id}`}><Pencil className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:text-destructive" title="Delete group" onClick={() => askDeleteGroup(g)} data-testid={`button-delete-group-${g.id}`}><Trash2 className="h-4 w-4" /></Button>
                    </div></td>
                  </tr>
                  {open && g.options.map(o => (
                    <tr key={o.id} className="rise bg-muted/25 transition-colors hover:bg-muted/50" data-testid={`row-option-${o.id}`}>
                      <td className="max-w-[320px] py-2.5 pl-11 pr-4"><div className="truncate border-l-2 border-primary/40 pl-2.5 font-medium">{o.optionName ?? o.name}</div>
                        {o.description && <div className="truncate pl-3 text-xs text-muted-foreground">{o.description}</div>}</td>
                      <td className="px-3 py-2.5"><StatusPill status={o.status} /></td>
                      <td className={cn("tabular px-3 py-2.5 text-right font-mono", o.stock === 0 && "text-signal")}>{o.stock}</td>
                      <td className="tabular px-3 py-2.5 text-right font-mono text-muted-foreground">{o.sold}</td>
                      <td className="tabular px-3 py-2.5 text-right font-mono font-medium">{money(o.price)}</td>
                      <td className="px-4 py-2.5"><ProductActions p={o} onEdit={() => openGroup(g)} /></td>
                    </tr>
                  ))}
                </tbody>;
              })}
              <tbody className="divide-y divide-border/60">
                {rows.map((p) => (
                  <tr key={p.id} className="group transition-colors hover:bg-muted/40" data-testid={`row-product-${p.id}`}>
                    <td className="max-w-[320px] px-4 py-3"><div className="flex items-center gap-1.5 font-medium">
                      <EmojiPreview customEmojiId={p.buttonCustomEmojiId} fallback={p.buttonEmoji ?? "🛍"} className="h-5 w-5" />
                      <span className="truncate">{p.name}</span>
                    </div><div className="truncate text-xs text-muted-foreground">Added {shortDate(p.createdAt)}</div></td>
                    <td className="px-3 py-3"><StatusPill status={p.status} /></td>
                    <td className={cn("tabular px-3 py-3 text-right font-mono", p.stock === 0 && "text-signal")}>{p.stock}</td>
                    <td className="tabular px-3 py-3 text-right font-mono text-muted-foreground">{p.sold}</td>
                    <td className="tabular px-3 py-3 text-right font-mono font-medium">{money(p.price)}</td>
                    <td className="px-4 py-3"><ProductActions p={p} onGroup={() => openGroup(null, p)} onEdit={() => openEdit(p)} onDelete={() => askDelete(p)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <ProductDialog open={dialogOpen} onOpenChange={setDialogOpen} product={editing} />
      <ProductGroupEditor open={groupOpen} onOpenChange={setGroupOpen} group={groupEditing} convertFrom={converting} />
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>The product and its {deleting?.stock ?? 0} unsold inventory entries will be removed permanently. Consider archiving instead if you might sell it again.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-delete"
              onClick={() => deleting && del.mutate({ id: deleting.id }, {
                onSuccess: () => { invalidate(); toast({ title: "Product deleted" }); setDeleting(null); },
                onError: (e) => toast({ variant: "destructive", title: "Delete failed", description: errMsg(e) }),
              })}>Delete product</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!dg} onOpenChange={(o) => !o && setDeletingGroup(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete group “{dg?.name}”?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-delete-group-counts">This permanently removes all <b>{dg?.options.length ?? 0} products/options</b> and their <b>{dgStock} unsold inventory entries</b>. It is refused if any option has order history or reserved/delivered stock — archive those options instead.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={delGroup.isPending} data-testid="button-confirm-delete-group"
              onClick={(e) => { e.preventDefault(); if (dg) delGroup.mutate({ id: dg.id }, {
                onSuccess: () => { invalidate(); toast({ title: "Group deleted", description: dg.name }); setDeletingGroup(null); },
                onError: (err) => toast({ variant: "destructive", title: "Delete refused", description: errMsg(err) }),
              }); }}>{delGroup.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Delete group and {dg?.options.length ?? 0} options</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
