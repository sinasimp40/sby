import { useEffect, useRef, useState } from "react";
import { useGetAdvertisingWorkspace, getGetAdvertisingWorkspaceQueryKey, useSaveAdvertisingDraft } from "@workspace/api-client-react";
import { PageHeader, ErrorState, RowsSkeleton } from "@/components/shared";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/format";
import { DraftPanel, ImportPanel, GroupsPanel, HistoryPanel, MessagePreview, draftProblem, toDraft, useWorkspaceSync, type DraftState } from "@/components/advertising-panels";
import { AccountPanel } from "@/components/advertising/account-panel";
import { ScheduleBar, StartDialog, RunsPanel } from "@/components/advertising/schedule-panels";

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
  const [startOpen, setStartOpen] = useState(false);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const server = ws.data?.draft;
  useEffect(() => {
    if (server && (!inited.current || !dirty)) {
      inited.current = true;
      setD({ text: server.text, imageUrl: server.imageUrl ?? "", buttonText: server.buttonText, buttonUrl: server.buttonUrl ?? "", entities: server.entities ?? [] });
    }
  }, [server, dirty]);
  if (ws.isLoading) return <div><PageHeader eyebrow="Growth" title="Advertising" /><RowsSkeleton rows={8} /></div>;
  if (ws.isError || !ws.data) return <div><PageHeader eyebrow="Growth" title="Advertising" /><ErrorState message={errMsg(ws.error) || "Failed to load advertising"} onRetry={() => ws.refetch()} /></div>;
  const w = ws.data;
  const problem = draftProblem(d);
  async function saveDraft() {
    const frozen = toDraft(d);
    try { sync(await save.mutateAsync({ data: frozen })); markSavedIf(JSON.stringify(frozen)); toast({ title: "Draft saved" }); }
    catch (x) { toast({ title: "Save failed", description: errMsg(x), variant: "destructive" }); }
  }
  return (
    <div>
      <PageHeader eyebrow="Growth" title="Advertising" description="Your personal Telegram account posts your ad to the groups you pick, each on its own interval. It never touches orders, payments, or the shop bot." />
      <ScheduleBar ws={w} selected={selected} problem={problem} onStart={() => setStartOpen(true)} />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-5">
          <AccountPanel ws={w} />
          <DraftPanel d={d} setD={v => { setD(v); setDirty(true); }} dirty={dirty} onSave={saveDraft} saving={save.isPending} shopBotUrl={w.shopBotUrl} connected={w.account.connected && !w.account.login} />
          <ImportPanel ws={w} />
          <GroupsPanel ws={w} selected={selected} setSelected={setSelected} />
          <RunsPanel ws={w} />
          {w.campaigns.length > 0 && <HistoryPanel ws={w} selectedId={campaignId} setSelectedId={setCampaignId} />}
        </div>
        <div className="lg:sticky lg:top-6 lg:self-start">
          <MessagePreview d={d} />
          <p className="mt-2 text-center text-[11px] text-muted-foreground">Local preview. Nothing is posted until you confirm Start.</p>
        </div>
      </div>
      <StartDialog open={startOpen} onOpenChange={setStartOpen} ws={w} d={d} toDraft={toDraft} selected={selected} onStarted={markSavedIf} />
    </div>
  );
}
