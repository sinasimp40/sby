import type { AdvertisingWorkspace } from "@workspace/api-client-react";
import { retainedGroupSelection } from "./group-list";
import { queueGroups } from "./forwarding-panels";

export function campaignGroupCounts(ws: AdvertisingWorkspace, selected: Set<string>) {
  const retained = retainedGroupSelection(ws.groups, selected);
  const groups = ws.groups.filter(group => retained.has(group.id));
  const eligible = queueGroups(ws, retained);
  const activeIds = new Set(ws.forwarding?.running ? ws.forwarding.groupIds : []);
  return {
    selected: retained.size, eligible: eligible.length, active: activeIds.size,
    disabled: groups.filter(group => !group.enabled).length,
    needsPermission: groups.filter(group => group.enabled && group.status !== "ready").length,
    missingIdentity: groups.filter(group => group.enabled && group.status === "ready" && !group.chatId).length,
    eligibleOutsideCampaign: eligible.filter(group => !activeIds.has(group.id)).length,
    activeOutsideSelection: [...activeIds].filter(id => !retained.has(id)).length,
    legacyActive: ws.groups.filter(group => group.running && !activeIds.has(group.id)).length,
  };
}

export function CampaignGroupCounts({ ws, selected }: { ws: AdvertisingWorkspace; selected: Set<string> }) {
  const counts = campaignGroupCounts(ws, selected);
  const reasons = [
    counts.disabled ? `${counts.disabled} disabled` : "",
    counts.needsPermission ? `${counts.needsPermission} need a successful permission check` : "",
    counts.missingIdentity ? `${counts.missingIdentity} missing a verified Telegram group ID` : "",
  ].filter(Boolean);
  return <div className="mt-4 border-t pt-3" data-testid="panel-campaign-group-counts">
    <dl className="space-y-2 text-xs">
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Selected for a new campaign</dt><dd className="font-mono font-semibold" data-testid="text-campaign-selected">{counts.selected}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Eligible for a new campaign</dt><dd className="font-mono font-semibold" data-testid="text-queue-size">{counts.eligible}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">In the running campaign</dt><dd className="font-mono font-semibold" data-testid="text-campaign-active">{counts.active}</dd></div>
    </dl>
    {reasons.length > 0 && <p className="mt-2 text-xs text-signal" data-testid="text-skipped-groups">
      {counts.selected - counts.eligible} selected groups are not eligible: {reasons.join("; ")}.
    </p>}
    {ws.forwarding?.running ? <p className="mt-2 text-xs text-muted-foreground" data-testid="text-campaign-selection-note">
      {counts.eligibleOutsideCampaign > 0 && <>{counts.eligibleOutsideCampaign} eligible selected groups are not in the running campaign. </>}
      {counts.activeOutsideSelection > 0 && <>{counts.activeOutsideSelection} running groups are not currently selected. </>}
      Checkbox changes do not change the running campaign. Review and start a new campaign to apply this selection.
    </p> : <p className="mt-2 text-xs text-muted-foreground">No forwarding campaign is running. Selecting groups does not start sending.</p>}
    {counts.legacyActive > 0 && <p className="mt-2 text-xs text-signal">
      {counts.legacyActive} older group schedules are running separately.
    </p>}
  </div>;
}
