import { useEffect, useMemo, useRef, useState } from "react";
import { useGetAdvertisingWorkspace, getGetAdvertisingWorkspaceQueryKey, type AdvertisingSavedMessage } from "@workspace/api-client-react";
import { Play } from "lucide-react";
import { PageHeader, ErrorState, RowsSkeleton } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { errMsg } from "@/lib/format";
import { ImportPanel, GroupsPanel, HistoryPanel } from "@/components/advertising-panels";
import { AccountPanel } from "@/components/advertising/account-panel";
import { RunsPanel } from "@/components/advertising/schedule-panels";
import { SavedMessagePicker, SavedMessageCard } from "@/components/advertising/saved-message-picker";
import { ForwardingStatus, ForwardStartDialog, IntervalPanel, GroupsPerIntervalPanel, groupsPerIntervalOk, intervalOk, queueGroups, splitInterval, toSeconds, type IntervalUnit } from "@/components/advertising/forwarding-panels";
import { MembershipPanel } from "@/components/advertising/membership-panel";
import { ResumePanel } from "@/components/advertising/resume-panel";
import { retainedGroupSelection } from "@/components/advertising/group-list";
import { useLiveAdvertisingWorkspace } from "@/components/advertising/use-live-workspace";
import { CampaignGroupCounts } from "@/components/advertising/campaign-group-counts";

export default function AdvertisingPage() {
  const live = useLiveAdvertisingWorkspace();
  const ws = useGetAdvertisingWorkspace({ query: { queryKey: getGetAdvertisingWorkspaceQueryKey(),
    refetchOnWindowFocus: true, refetchOnReconnect: true } });
  const [source, setSource] = useState<AdvertisingSavedMessage | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ivValue, setIvValue] = useState("30");
  const [ivUnit, setIvUnit] = useState<IntervalUnit>("m");
  const [batchValue, setBatchValue] = useState("1");
  const [startOpen, setStartOpen] = useState(false);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const touched = useRef(false);
  const boundTo = useRef<string | null | undefined>(undefined);
  // A transport drop is not an identity change. Keep unsent choices while the
  // same saved account recovers; readiness separately blocks reads and Start.
  const accountId = ws.data?.account.accountId ?? null;
  const fwd = ws.data?.forwarding;
  const activeSelected = useMemo(() => retainedGroupSelection(ws.data?.groups ?? [], selected), [ws.data?.groups, selected]);

  // Identity binding: clear choices whenever the connected account changes; restore prior plan once per account.
  useEffect(() => {
    if (!ws.data) return;
    if (boundTo.current !== accountId) {
      boundTo.current = accountId; touched.current = false;
      setSource(null); setSelected(new Set()); setBatchValue("1");
    }
    if (touched.current || !accountId || !fwd) return;
    if (fwd.source && fwd.source.accountId === accountId) setSource(fwd.source);
    if (intervalOk(fwd.intervalSeconds)) { const [v, u] = splitInterval(fwd.intervalSeconds); setIvValue(v); setIvUnit(u); }
    setBatchValue(String(fwd.groupsPerInterval ?? 1));
    if (fwd.groupIds.length) setSelected(new Set(fwd.groupIds));
    touched.current = true;
  }, [ws.data, accountId, fwd]);

  // Worker-side removal changes the workspace, not local checkbox state.
  // Prune only after a workspace exists, and do not mark the form dirty or
  // reset source/interval choices. Render from activeSelected immediately.
  useEffect(() => {
    const groups = ws.data?.groups;
    if (groups) setSelected(previous => retainedGroupSelection(groups, previous));
  }, [ws.data?.groups]);

  if (ws.isLoading) return <div><PageHeader eyebrow="Growth" title="Advertising" /><RowsSkeleton rows={8} /></div>;
  if (!ws.data) return <div><PageHeader eyebrow="Growth" title="Advertising" /><ErrorState message={errMsg(ws.error) || "Failed to load advertising"} onRetry={() => ws.refetch()} /></div>;
  const w = ws.data;
  const signingIn = !!w.account.login;
  const ready = w.account.connected && !signingIn && !!w.account.accountId;
  const blocked = signingIn ? "Finish or cancel account sign-in first." : !w.account.connected ? "Connect your Telegram account first." : "";
  const touch = () => { touched.current = true; };
  const intervalSeconds = toSeconds(ivValue, ivUnit);
  const groupsPerInterval = Number(batchValue);
  const queue = queueGroups(w, activeSelected);
  const reason = (ws.isError ? "Connection interrupted. Wait for current group data before starting a campaign." : blocked) || (!source ? "Choose a source message." : !source.canForward ? "This message cannot be forwarded." : source.accountId !== w.account.accountId ? "Source belongs to a different account. Load Saved Messages again." : !queue.length ? "Select at least one ready, enabled group." : !intervalOk(intervalSeconds) ? "Set a delay between 1 minute and 30 days." : !groupsPerIntervalOk(groupsPerInterval) ? "Choose 1 to 500 groups per interval." : "");

  return (
    <div>
      <PageHeader eyebrow="Growth" title="Advertising" description="Forward one message from your Saved Messages through your groups, one at a time with a shared delay. Nothing starts until you confirm, and it never touches orders, payments or the shop bot." />
      <p className="mb-4 text-xs text-muted-foreground" role="status" data-testid="status-advertising-live">
        {live ? "Live updates connected · group changes appear automatically." : "Connecting live updates… changes will sync when connected."}
      </p>
      {ws.isError && <p role="status" className="mb-4 text-xs text-signal" data-testid="banner-advertising-connection">
        Connection interrupted. Keeping your group list and selections visible while reconnecting.
      </p>}
      <ForwardingStatus ws={w} />
      <ResumePanel key={`resume-${accountId ?? "none"}`} ws={w} />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-5">
          <AccountPanel ws={w} />
          <SavedMessagePicker key={accountId ?? "none"} accountId={accountId} ready={ready} blockedReason={blocked} value={source} onChange={m => { touch(); setSource(m); }} />
          <IntervalPanel value={ivValue} unit={ivUnit} onChange={(v, u) => { touch(); setIvValue(v); setIvUnit(u); }} />
          <GroupsPerIntervalPanel value={batchValue} onChange={v => { touch(); setBatchValue(v); }} />
          <ImportPanel ws={w} />
          <MembershipPanel key={`membership-${accountId ?? "no-account"}`} ws={w} />
          <GroupsPanel ws={w} selected={activeSelected} setSelected={s => { touch(); setSelected(s); }} sequential
            onRefresh={() => { void ws.refetch(); }} refreshing={ws.isFetching} />
          <RunsPanel ws={w} />
          {w.campaigns.length > 0 && <HistoryPanel ws={w} selectedId={campaignId} setSelectedId={setCampaignId} />}
        </div>
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-xl border bg-card p-4" data-testid="panel-forward-summary">
            <div className="mb-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">New campaign setup</div>
            {source ? <SavedMessageCard m={source} compact /> : <p className="text-sm text-muted-foreground">No source message chosen.</p>}
            <CampaignGroupCounts ws={w} selected={activeSelected} />
            <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-3 text-xs">
              <div><dt className="text-muted-foreground">Delay</dt><dd className="font-mono text-base font-semibold">{intervalOk(intervalSeconds) ? `${ivValue}${ivUnit === "m" ? " min" : " h"}` : "-"}</dd></div>
              <div><dt className="text-muted-foreground">Groups per interval</dt><dd className="font-mono text-base font-semibold" data-testid="text-batch-summary">{groupsPerIntervalOk(groupsPerInterval) ? groupsPerInterval : "-"}</dd></div>
            </dl>
            <Button className="mt-4 w-full" disabled={!!reason} onClick={() => setStartOpen(true)} data-testid="button-open-start"><Play className="mr-1.5 h-4 w-4" />Start new campaign</Button>
            {reason && <p className="mt-2 text-center text-xs text-muted-foreground" data-testid="text-start-blocked">{reason}</p>}
          </div>
        </aside>
      </div>
      <ForwardStartDialog open={startOpen} onOpenChange={setStartOpen} ws={w} source={source} selected={activeSelected} intervalSeconds={intervalSeconds} groupsPerInterval={groupsPerInterval} />
    </div>
  );
}
