import { useEffect, useMemo, useRef, useState } from "react";
import { useGetAdvertisingWorkspace, getGetAdvertisingWorkspaceQueryKey, useSaveAdvertisingDraft } from "@workspace/api-client-react";
import { Send } from "lucide-react";
import { PageHeader, ErrorState, RowsSkeleton } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/format";
import { ConnectionPanel, DraftPanel, ImportPanel, GroupsPanel, HistoryPanel, SendDialog, MessagePreview, draftProblem, toDraft, useWorkspaceSync, type DraftState } from "@/components/advertising-panels";

export default function AdvertisingPage() {
  const ws = useGetAdvertisingWorkspace({ query: { queryKey: getGetAdvertisingWorkspaceQueryKey(), refetchInterval: 5000 } });
  const save = useSaveAdvertisingDraft();
  const sync = useWorkspaceSync();
  const { toast } = useToast();
  const [d, setD] = useState<DraftState>({ text: "", imageUrl: "", buttonText: "", buttonUrl: "" });
  const [dirty, setDirty] = useState(false);
  const inited = useRef(false);
  const dRef = useRef(d);
  dRef.current = d;
  const markSavedIf = (fp: string) => { if (JSON.stringify(toDraft(dRef.current)) === fp) setDirty(false); };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sendOpen, setSendOpen] = useState(false);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const server = ws.data?.draft;
  useEffect(() => {
    if (server && (!inited.current || !dirty)) {
      inited.current = true;
      setD({ text: server.text, imageUrl: server.imageUrl ?? "", buttonText: server.buttonText, buttonUrl: server.buttonUrl ?? "" });
    }
  }, [server, dirty]);
  const recipients = useMemo(() => (ws.data?.groups ?? []).filter(g => selected.has(g.id) && g.enabled && g.status === "ready"), [ws.data?.groups, selected]);
  if (ws.isLoading) return <div><PageHeader eyebrow="Growth" title="Advertising" /><RowsSkeleton rows={8} /></div>;
  if (ws.isError || !ws.data) return <div><PageHeader eyebrow="Growth" title="Advertising" /><ErrorState message={errMsg(ws.error) || "Failed to load advertising"} onRetry={() => ws.refetch()} /></div>;
  const w = ws.data;
  const active = w.campaigns.some(c => c.status === "queued" || c.status === "sending");
  const problem = draftProblem(d);
  async function saveDraft() {
    const frozen = toDraft(d);
    try { sync(await save.mutateAsync({ data: frozen })); markSavedIf(JSON.stringify(frozen)); toast({ title: "Draft saved" }); }
    catch (x) { toast({ title: "Save failed", description: errMsg(x), variant: "destructive" }); }
  }
  return (
    <div>
      <PageHeader eyebrow="Growth" title="Advertising" description="A separate bot posts your ad to groups you choose. It never touches orders, payments, or shop maintenance."
        actions={<Button disabled={!w.bot.connected || !recipients.length || !!problem || active} onClick={() => setSendOpen(true)} data-testid="button-open-send"><Send className="mr-1.5 h-4 w-4" />Send to {recipients.length} ready</Button>} />
      {active && <p className="mb-4 rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-sm" data-testid="banner-active-campaign">A send is in progress. New sends unlock when it finishes or is cancelled.</p>}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-5">
          <ConnectionPanel ws={w} />
          <DraftPanel d={d} setD={v => { setD(v); setDirty(true); }} dirty={dirty} onSave={saveDraft} saving={save.isPending} shopBotUrl={w.shopBotUrl} />
          <ImportPanel ws={w} />
          <GroupsPanel ws={w} selected={selected} setSelected={setSelected} />
          <HistoryPanel ws={w} selectedId={campaignId} setSelectedId={setCampaignId} />
        </div>
        <div className="lg:sticky lg:top-6 lg:self-start">
          <MessagePreview d={d} />
          <p className="mt-2 text-center text-[11px] text-muted-foreground">Local preview. Nothing is sent until you confirm.</p>
        </div>
      </div>
      <SendDialog open={sendOpen} onOpenChange={setSendOpen} ws={w} d={d} recipients={recipients} onStarted={(id, fp) => { setCampaignId(id); markSavedIf(fp); }} />
    </div>
  );
}
