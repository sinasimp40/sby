import { useState } from "react";
import { Download, FileArchive, ShieldCheck, Upload, AlertTriangle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetShopTransferStatus, useExportShopData, usePreviewShopData, useImportShopData, useReviewShopData,
} from "@workspace/api-client-react";
import { PageHeader, Panel, ErrorState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { errMsg, dateTime } from "@/lib/format";

const tableLabels: Record<string, string> = {
  products: "Products", inventory: "Stock credentials", customers: "Customers & balances",
  payments: "Orders & deposits", walletEntries: "Wallet ledger", manualCredits: "Manual credit audit", records: "Legacy records",
  promotionSettings: "Customer promotion schedule", promotionProducts: "Promoted products/options",
  promotionPreferences: "Customer promotion preferences", promotionRounds: "Promotion rounds", promotionDeliveries: "Promotion deliveries",
  settings: "Shop settings", activity: "Activity history", providerCredentials: "Saved provider credentials",
  runtime: "Bot runtime settings", connection: "Bot connection", updates: "Telegram update deduplication",
  customEmojis: "Custom emoji library",
};
function Counts({ counts }: { counts: Record<string, number> }) {
  return <dl className="grid gap-x-8 rounded-lg border bg-background/60 px-3 sm:grid-cols-2">{Object.entries(counts).map(([key, count]) => (
    <div key={key} className="flex justify-between gap-4 border-b border-dashed py-2 text-sm last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
      <dt className="text-muted-foreground">{tableLabels[key] ?? key}</dt><dd className="font-mono tabular-nums">{count.toLocaleString()}</dd>
    </div>
  ))}</dl>;
}
export default function DataTransferPage() {
  const status = useGetShopTransferStatus({ query: { refetchInterval: 5000 } });
  const download = useExportShopData({ request: { responseType: "blob" }, mutation: { gcTime: 0, retry: false } });
  const preview = usePreviewShopData({ mutation: { gcTime: 0, retry: false } });
  const [file, setFile] = useState<File | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [sourceStopped, setSourceStopped] = useState(false);
  const [recordsReviewed, setRecordsReviewed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [exportAcknowledged, setExportAcknowledged] = useState(false);
  const qc = useQueryClient();
  const apply = useImportShopData({
    request: { headers: {
      "X-Transfer-Token": preview.data?.confirmationToken ?? "",
      "X-Transfer-Confirm": "IMPORT EMPTY SHOP",
    } }, mutation: { gcTime: 0, retry: false },
  });
  const review = useReviewShopData({ mutation: { retry: false } });
  const busy = download.isPending || preview.isPending || apply.isPending || review.isPending;
  return <div className="mx-auto max-w-4xl space-y-5">
    <PageHeader eyebrow="Data management" title="Database transfer" description="Download a portable ZIP of this shop’s records, or safely import one into an empty shop. This is not a PostgreSQL disaster-recovery backup." />
    <div className="rise rounded-xl border border-signal/30 border-l-4 border-l-signal bg-signal-soft/60 p-4 text-sm">
      <div className="mb-2 flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4 text-signal" aria-hidden="true" /> ZIP-only transfer · SQLite database inside</div>
      <p className="text-muted-foreground">New exports contain a real <code className="rounded bg-muted px-1 font-mono text-[0.85em]">shop.db</code> SQLite database, not JSON files. Import needs only the ZIP—no matching secret key or transfer password. Stock and saved credentials are encrypted with the destination’s own key when imported. The live app still uses PostgreSQL.</p>
      <p className="mt-2 font-medium text-signal">Anyone with this ZIP can read its stock credentials and saved bot/payment keys. It is not password-protected. Keep it private and import only a trusted file.</p>
      <p className="mt-2 text-muted-foreground">Your installation secret, admin password, login sessions and database connection credentials are never exported. Old JSON exports still need the original SESSION_SECRET; this update cannot recover an old archive’s encrypted values without that key.</p>
      <p className="mt-2 text-muted-foreground">The ZIP contains private customer and financial information. Keep it secure. For a final move, stop the source processing before the final export, and do not restart that copy.</p>
    </div>
    {status.isError && <ErrorState message={errMsg(status.error)} onRetry={() => status.refetch()} />}
    {status.data?.reviewRequired && <Panel className="border-signal/40 ring-1 ring-signal/20" title="Imported shop is paused for review" meta={<span className="rounded-full bg-signal-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-signal">Required before resuming</span>}>
      <p className="mb-4 text-sm text-muted-foreground">All imported records are saved, but Telegram activation, payment verification and delivery are held. Review orders, balances and pending invoices, stop the original server, then acknowledge below. Telegram stays disabled after acknowledgement; enable it separately in Bot messages.</p>
      <div className="space-y-3">
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50"><Checkbox className="mt-0.5" checked={sourceStopped} onCheckedChange={value => setSourceStopped(value === true)} data-testid="checkbox-source-stopped" />The source server is stopped, and this was its final export.</label>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50"><Checkbox className="mt-0.5" checked={recordsReviewed} onCheckedChange={value => setRecordsReviewed(value === true)} data-testid="checkbox-records-reviewed" />I reviewed the imported orders, inventory, balances and pending payments. Payment checks may now resume.</label>
        <Button disabled={busy || !sourceStopped || !recordsReviewed} data-testid="button-review-import" onClick={() => review.mutate({ data: { sourceStopped: true, recordsReviewed: true } }, { onSuccess: () => { void qc.invalidateQueries(); } })}>{review.isPending ? "Saving review…" : "Acknowledge review & resume payment checks"}</Button>
        {review.isError && <p role="alert" className="text-sm text-destructive">{errMsg(review.error)}</p>}
      </div>
    </Panel>}
    <Panel title="Export shop data" meta={<Download className="h-4 w-4" aria-hidden="true" />}>
      <p className="mb-3 text-sm text-muted-foreground">One read-only snapshot includes every row for your shop in separate SQLite tables: products, inventory, customers, orders and deposits, wallet credits and purchase debits, legacy records, settings, activity, saved provider credentials, bot configuration, Telegram deduplication history and your custom emoji library. Temporary emoji import links are excluded. Temporary transfer files are deleted after processing.</p>
      <p className="mb-4 text-xs text-muted-foreground">The ZIP contains <code className="rounded bg-muted px-1 font-mono text-[0.85em]">shop.db</code> and <code className="rounded bg-muted px-1 font-mono text-[0.85em]">README.txt</code>. SQLite tables let database viewers browse logs without opening one large JSON file. Checksums and schema checks detect corruption, but do not prove who created the file. Limit: 50,000 total rows, 30 MB expanded data, 20 MB ZIP. An oversized shop fails explicitly—never a partial export.</p>
      <label className="mb-4 flex cursor-pointer items-start gap-3 rounded-lg border border-signal/30 p-3 text-sm"><Checkbox className="mt-0.5" checked={exportAcknowledged} disabled={busy} onCheckedChange={value => setExportAcknowledged(value === true)} data-testid="checkbox-confirm-export" />I understand this ZIP contains readable stock and saved provider credentials. I will keep it private.</label>
      <Button disabled={busy || status.isLoading || status.isError || !exportAcknowledged} data-testid="button-export-shop" onClick={() => {
        setDownloaded(false);
        download.mutate(undefined, { onSuccess: blob => {
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url; anchor.download = `telecart-shop-${new Date().toISOString().slice(0, 10)}.zip`;
          document.body.appendChild(anchor); anchor.click(); anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          setDownloaded(true); download.reset();
        } });
      }}><Download className="mr-2 h-4 w-4" aria-hidden="true" />{download.isPending ? "Preparing ZIP…" : "Download shop-data ZIP"}</Button>
      {downloaded && <p role="status" className="pop mt-3 text-sm text-ok">SQLite ZIP download started. Only this ZIP is needed to import into another installation. Keep it private.</p>}
      {download.isError && <p role="alert" className="pop mt-3 text-sm text-destructive">{errMsg(download.error)}</p>}
    </Panel>
    <Panel title="Import shop data" meta={<Upload className="h-4 w-4" aria-hidden="true" />}>
      <div className="mb-4 flex gap-3 rounded-lg border border-signal/25 bg-signal-soft/40 p-3 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal" aria-hidden="true" /><p>Imports are all-or-nothing and only allowed in an empty shop with Telegram disabled. They do not merge or overwrite wallet balances and orders. Empty-shop settings and saved provider configuration are replaced; the destination’s administrator login remains unchanged. Numeric product and inventory IDs may be remapped without changing their links.</p></div>
      {status.data?.blockers.map(blocker => <p key={blocker} className="pop mb-2 rounded-md border-l-2 border-signal bg-signal-soft/50 px-3 py-1.5 text-sm text-signal">{blocker}</p>)}
      <label htmlFor="shop-transfer-file" className="mb-2 block text-sm font-medium">Original Telecart ZIP</label>
      <Input id="shop-transfer-file" type="file" accept=".zip,application/zip" disabled={busy} data-testid="input-import-shop" className="cursor-pointer file:mr-3 file:font-medium file:text-primary" onChange={event => {
        setFile(event.target.files?.[0] ?? null); setAcknowledged(false); preview.reset(); apply.reset();
      }} />
      <Button variant="outline" className="mt-3" disabled={busy || !file || file.size > 20 * 1024 * 1024} data-testid="button-preview-import" onClick={() => {
        if (!file) return;
        setAcknowledged(false); apply.reset();
        preview.mutate({ data: file });
      }}><FileArchive className="mr-2 h-4 w-4" aria-hidden="true" />{preview.isPending ? "Checking archive…" : "Validate ZIP & preview"}</Button>
      {file && file.size > 20 * 1024 * 1024 && <p role="alert" className="mt-2 text-sm text-destructive">ZIP exceeds the 20 MB limit.</p>}
      {preview.isError && <p role="alert" className="pop mt-3 text-sm text-destructive">{errMsg(preview.error)}</p>}
      {preview.data && <section className="pop mt-5 space-y-4 border-t border-dashed pt-5" data-testid="section-import-preview">
        <div><h3 className="text-sm font-semibold">Verified archive · {dateTime(preview.data.createdAt)}</h3><p className="mt-1 break-all font-mono text-xs text-muted-foreground">SHA-256: {preview.data.archiveHash}</p></div>
        <Counts counts={preview.data.counts} />
        <p className="text-xs text-muted-foreground">Archive structure, integrity, row counts, credentials and relationships checked. Preview expires in five minutes. Only import an export you trust.</p>
        {preview.data.warnings.map(warning => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
        {preview.data.blockers.map(blocker => <p key={blocker} role="alert" className="pop rounded-md border-l-2 border-signal bg-signal-soft/50 px-3 py-1.5 text-sm text-signal">{blocker}</p>)}
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-primary/30 bg-accent/40 p-3 text-sm transition-colors hover:bg-accent/70"><Checkbox className="mt-0.5" checked={acknowledged} disabled={busy || !preview.data.canImport || apply.isSuccess} onCheckedChange={value => setAcknowledged(value === true)} data-testid="checkbox-confirm-import" />I confirm this is the intended ZIP and an empty destination. I understand configuration is replaced and processing remains paused for review.</label>
        <Button disabled={busy || !acknowledged || !preview.data.canImport || !file || apply.isSuccess} data-testid="button-import-shop" onClick={() => {
          if (!file) return;
          apply.mutate({ data: file }, { onSuccess: () => {
            setAcknowledged(false); setSourceStopped(false); setRecordsReviewed(false); review.reset();
            void qc.invalidateQueries();
          } });
        }}>{apply.isPending ? "Importing atomically…" : "Import into empty shop"}</Button>
      </section>}
      {apply.isError && <p role="alert" className="pop mt-3 text-sm text-destructive">{errMsg(apply.error)}</p>}
      {apply.isSuccess && <p role="status" className="pop mt-4 text-sm text-ok">Import completed. All archive records were committed together. Review the imported shop above before resuming processing.</p>}
    </Panel>
  </div>;
}
