import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useListProducts, useCreateProduct, useUpdateProduct, useDeleteProduct, getListProductsQueryKey, getGetOverviewQueryKey, getListActivityQueryKey } from "@workspace/api-client-react";
import type { Product } from "@workspace/api-client-react";
import { Plus, Pencil, Trash2, Package, Search, KeyRound, Loader2 } from "lucide-react";
import { PageHeader, Panel, EmptyState, ErrorState, RowsSkeleton, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuthGate } from "@/components/auth-gate";
import { money, shortDate, errMsg } from "@/lib/format";
import { cn } from "@/lib/utils";

const schema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().max(2000),
  category: z.string().trim().min(1, "Category is required").max(80),
  price: z.coerce.number({ invalid_type_error: "Enter a price" }).min(0.01, "Minimum $0.01").max(100000, "Maximum $100,000"),
  status: z.enum(["active", "draft", "archived"]),
  deliveryFormat: z.enum(["email:pass", "user:pass"]),
});
type FormValues = z.infer<typeof schema>;
const blank: FormValues = { name: "", description: "", category: "", price: 0, status: "draft", deliveryFormat: "email:pass" };

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
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
    if (open) form.reset(product ? { name: product.name, description: product.description, category: product.category, price: product.price, status: product.status, deliveryFormat: product.deliveryFormat } : blank);
  }, [open, product, form]);
  const pending = create.isPending || update.isPending;
  const onSubmit = (v: FormValues) => {
    const opts = {
      onSuccess: () => { invalidate(); toast({ title: product ? "Product updated" : "Product created", description: v.name }); onOpenChange(false); },
      onError: (e: unknown) => toast({ variant: "destructive", title: "Could not save product", description: errMsg(e) }),
    };
    if (product) update.mutate({ id: product.id, data: v }, opts);
    else create.mutate({ data: v }, opts);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{product ? "Edit product" : "New product"}</DialogTitle>
          <DialogDescription>Only list accounts you are authorized to resell. Stock comes from inventory imports.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>Name</FormLabel><FormControl><Input placeholder="Streaming Premium — 1 month" {...field} data-testid="input-product-name" /></FormControl><FormMessage /></FormItem>
            )} />
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="category" render={({ field }) => (
                <FormItem><FormLabel>Category</FormLabel><FormControl><Input placeholder="Streaming" {...field} data-testid="input-product-category" /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="price" render={({ field }) => (
                <FormItem><FormLabel>Price (USD)</FormLabel><FormControl><Input type="number" step="0.01" min="0.01" {...field} data-testid="input-product-price" /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea rows={3} placeholder="What the buyer receives, warranty terms, region…" {...field} data-testid="input-product-description" /></FormControl><FormMessage /></FormItem>
            )} />
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="status" render={({ field }) => (
                <FormItem><FormLabel>Status</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger data-testid="select-product-status"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="draft">Draft</SelectItem><SelectItem value="archived">Archived</SelectItem></SelectContent></Select>
                  <p className="text-xs text-muted-foreground">Only Active products with available stock appear in Telegram. Drafts stay hidden.</p><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="deliveryFormat" render={({ field }) => (
                <FormItem><FormLabel>Delivery format</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger className="font-mono" data-testid="select-product-format"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent><SelectItem value="email:pass" className="font-mono">email:pass</SelectItem><SelectItem value="user:pass" className="font-mono">user:pass</SelectItem></SelectContent></Select>
                  <FormMessage /></FormItem>
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

export default function ProductsPage() {
  const { data, isLoading, isError, error, refetch } = useListProducts();
  const del = useDeleteProduct();
  const invalidate = useInvalidate();
  const { toast } = useToast();
  const { requireAuth, isSignedIn } = useAuthGate();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "draft" | "archived">("all");
  const [editing, setEditing] = useState<Product | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<Product | null>(null);

  const rows = useMemo(() => (data ?? []).filter((p) => (filter === "all" || p.status === filter) && (p.name + p.category).toLowerCase().includes(q.toLowerCase())), [data, q, filter]);
  const openNew = () => { if (requireAuth("create products")) { setEditing(null); setDialogOpen(true); } };
  const openEdit = (p: Product) => { if (requireAuth("edit products")) { setEditing(p); setDialogOpen(true); } };
  const askDelete = (p: Product) => { if (requireAuth("delete products")) setDeleting(p); };

  return (
    <div>
      <PageHeader eyebrow="Catalog" title="Products" description="What your bot sells. Price, delivery format and status live here; stock is counted from imported inventory."
        actions={<Button onClick={openNew} data-testid="button-new-product"><Plus className="mr-1.5 h-4 w-4" />New product</Button>} />
      {!isSignedIn && <div className="mb-4 rounded-lg border border-signal/25 bg-signal-soft px-3 py-2 text-xs text-foreground/80">These are <b>labelled sample products</b> for the preview. Your own shop starts empty.</div>}
      <Panel bodyClassName="p-0">
        <div className="flex flex-col gap-2 border-b border-border/70 p-3 sm:flex-row sm:items-center">
          <div className="relative flex-1"><Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or category" className="pl-8" data-testid="input-search-products" /></div>
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {(["all", "active", "draft", "archived"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} data-testid={`button-filter-${f}`} className={cn("rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors", filter === f ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{f}</button>
            ))}
          </div>
        </div>
        {isLoading ? <div className="p-4"><RowsSkeleton /></div> : isError ? <div className="p-4"><ErrorState message={(error as Error)?.message ?? "Failed to load"} onRetry={() => refetch()} /></div> : !rows.length ? (
          <div className="p-4"><EmptyState icon={Package} title={data?.length ? "No matches" : "No products yet"} body={data?.length ? "Try a different search or filter." : "Create your first product, then import credentials into inventory."} action={!data?.length ? <Button size="sm" onClick={openNew}><Plus className="mr-1 h-3.5 w-3.5" />New product</Button> : undefined} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border/70 text-left font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Product</th><th className="px-3 py-2.5 font-medium">Status</th><th className="px-3 py-2.5 font-medium">Format</th><th className="px-3 py-2.5 text-right font-medium">Stock</th><th className="px-3 py-2.5 text-right font-medium">Sold</th><th className="px-3 py-2.5 text-right font-medium">Price</th><th className="px-4 py-2.5" /></tr></thead>
              <tbody className="divide-y divide-border/60">
                {rows.map((p) => (
                  <tr key={p.id} className="group transition-colors hover:bg-muted/40" data-testid={`row-product-${p.id}`}>
                    <td className="max-w-[320px] px-4 py-3"><div className="truncate font-medium">{p.name}</div><div className="truncate text-xs text-muted-foreground">{p.category} · added {shortDate(p.createdAt)}</div></td>
                    <td className="px-3 py-3"><StatusPill status={p.status} /></td>
                    <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{p.deliveryFormat}</td>
                    <td className={cn("tabular px-3 py-3 text-right font-mono", p.stock === 0 && "text-signal")}>{p.stock}</td>
                    <td className="tabular px-3 py-3 text-right font-mono text-muted-foreground">{p.sold}</td>
                    <td className="tabular px-3 py-3 text-right font-mono font-medium">{money(p.price)}</td>
                    <td className="px-4 py-3"><div className="flex justify-end gap-0.5">
                      <Button size="icon" variant="ghost" className="h-8 w-8" asChild title="Inventory"><Link href={`/inventory?product=${p.id}`} data-testid={`link-inventory-${p.id}`}><KeyRound className="h-4 w-4" /></Link></Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(p)} data-testid={`button-edit-${p.id}`}><Pencil className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => askDelete(p)} data-testid={`button-delete-${p.id}`}><Trash2 className="h-4 w-4" /></Button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <ProductDialog open={dialogOpen} onOpenChange={setDialogOpen} product={editing} />
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
    </div>
  );
}
