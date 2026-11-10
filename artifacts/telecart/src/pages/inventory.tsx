import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useListProducts, useListInventory, useImportInventory, useDeleteInventoryItem, getListInventoryQueryKey, getListProductsQueryKey, getGetOverviewQueryKey, getListActivityQueryKey } from "@workspace/api-client-react";
import { ShieldCheck, Eye, EyeOff, Upload, Trash2, KeyRound, Loader2, Lock } from "lucide-react";
import { PageHeader, Panel, EmptyState, ErrorState, RowsSkeleton, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuthGate } from "@/components/auth-gate";
import { countLines, dateTime, errMsg } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function InventoryPage() {
  const search = useSearch();
  const products = useListProducts();
  const [productId, setProductId] = useState<number | null>(null);
  const [entries, setEntries] = useState("");
  const [reveal, setReveal] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { requireAuth } = useAuthGate();

  useEffect(() => {
    if (productId !== null || !products.data?.length) return;
    const fromUrl = Number(new URLSearchParams(search).get("product"));
    setProductId(products.data.some((p) => p.id === fromUrl) ? fromUrl : products.data[0].id);
  }, [products.data, search, productId]);

  const inv = useListInventory(productId ?? 0, { query: { enabled: productId !== null, queryKey: getListInventoryQueryKey(productId ?? 0) } });
  const imp = useImportInventory();
  const del = useDeleteInventoryItem();
  const product = products.data?.find((p) => p.id === productId);
  const lines = countLines(entries);
  const badLines = entries.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !/^[^:\s]+:\S+/.test(l)).length;

  const invalidate = () => {
    if (productId !== null) qc.invalidateQueries({ queryKey: getListInventoryQueryKey(productId) });
    qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetOverviewQueryKey() });
    qc.invalidateQueries({ queryKey: getListActivityQueryKey() });
  };

  const submit = () => {
    setFormError(null);
    if (!requireAuth("import inventory")) return;
    if (productId === null) return setFormError("Choose a product first.");
    if (!lines) return setFormError("Paste at least one login:password line.");
    if (lines > 500) return setFormError(`Maximum 500 lines per import — you have ${lines}.`);
    imp.mutate({ id: productId, data: { entries } }, {
      onSuccess: (r) => {
        setEntries("");
        setReveal(false);
        setLastResult(r);
        invalidate();
        toast({ title: `${r.imported} accounts imported`, description: r.skipped ? `${r.skipped} lines skipped (invalid or duplicate).` : "All lines accepted and encrypted." });
      },
      onError: (e) => setFormError(errMsg(e)),
    });
  };

  return (
    <div>
      <PageHeader eyebrow="Credential vault" title="Inventory" description="Bulk-import accounts for each product. Credentials are encrypted server-side and are never shown back — you only see metadata." />
      {products.isError ? <ErrorState message="Failed to load products" onRetry={() => products.refetch()} /> : products.isLoading ? <RowsSkeleton /> : !products.data?.length ? (
        <EmptyState icon={KeyRound} title="No products to stock" body="Create a product first; inventory is always attached to one." />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
          <Panel title="Bulk import" meta={<span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" />encrypted at rest</span>}>
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium">Product</label>
                <Select value={productId?.toString() ?? ""} onValueChange={(v) => { setProductId(Number(v)); setLastResult(null); }}>
                  <SelectTrigger data-testid="select-inventory-product"><SelectValue placeholder="Choose product" /></SelectTrigger>
                  <SelectContent>{products.data.map((p) => <SelectItem key={p.id} value={p.id.toString()}>{p.name} <span className="text-muted-foreground">· {p.stock} in stock</span></SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-sm font-medium">Accounts <span className="font-mono text-xs text-muted-foreground">{product?.deliveryFormat ?? "login:password"}, one per line</span></label>
                  <button type="button" onClick={() => setReveal((r) => !r)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="button-toggle-reveal">
                    {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}{reveal ? "Hide" : "Reveal while typing"}
                  </button>
                </div>
                <Textarea value={entries} onChange={(e) => setEntries(e.target.value)} rows={9} spellCheck={false} autoComplete="off"
                  placeholder={"buyer01@mail.com:Pa55word\nbuyer02@mail.com:Pa55word"} className={cn("font-mono text-xs leading-relaxed", !reveal && "masked")} data-testid="input-inventory-entries" />
                <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-muted-foreground">
                  <span data-testid="text-line-count">{lines} / 500 lines</span>
                  {badLines > 0 && <span className="text-signal">{badLines} lines don't look like login:password</span>}
                </div>
              </div>
              {formError && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="text-import-error">{formError}</div>}
              {lastResult && <div className="pop flex items-center gap-2 rounded-md border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok" data-testid="text-import-result"><ShieldCheck className="h-4 w-4" />Imported {lastResult.imported}, skipped {lastResult.skipped}. Input cleared.</div>}
              <div className="flex gap-2">
                <Button onClick={submit} disabled={imp.isPending} className="flex-1" data-testid="button-import">{imp.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}Import {lines || ""} accounts</Button>
                <Button variant="outline" onClick={() => { setEntries(""); setFormError(null); }} disabled={!entries} data-testid="button-clear-entries">Clear</Button>
              </div>
            </div>
          </Panel>
          <Panel title={product ? product.name : "Stock"} meta={inv.data ? `${inv.data.filter((i) => i.status === "available").length} available · ${inv.data.length} total` : undefined} bodyClassName="p-0">
            {inv.isLoading ? <div className="p-4"><RowsSkeleton /></div> : inv.isError ? <div className="p-4"><ErrorState message="Failed to load inventory" onRetry={() => inv.refetch()} /></div> : !inv.data?.length ? (
              <div className="p-4"><EmptyState icon={KeyRound} title="No stock for this product" body="Import accounts on the left. Buyers receive one entry per purchase once delivery is connected." /></div>
            ) : (
              <ul className="max-h-[520px] divide-y divide-border/60 overflow-y-auto">
                {inv.data.map((it) => (
                  <li key={it.id} className="flex items-center gap-3 px-4 py-2.5 text-sm" data-testid={`row-inventory-${it.id}`}>
                    <span className="font-mono text-xs text-muted-foreground">#{String(it.id).padStart(5, "0")}</span>
                    <span className="font-mono text-xs tracking-widest text-muted-foreground/70">••••••:••••••</span>
                    <StatusPill status={it.status} />
                    <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">{dateTime(it.createdAt)}</span>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" disabled={it.status !== "available"} onClick={() => requireAuth("delete inventory") && setDeleteId(it.id)} data-testid={`button-delete-inventory-${it.id}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete entry #{deleteId}?</AlertDialogTitle><AlertDialogDescription>The encrypted credential is destroyed and stock decreases by one. This cannot be undone.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-delete-inventory"
              onClick={() => deleteId !== null && del.mutate({ id: deleteId }, { onSuccess: () => { invalidate(); toast({ title: "Entry deleted" }); setDeleteId(null); }, onError: (e) => toast({ variant: "destructive", title: "Delete failed", description: errMsg(e) }) })}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
