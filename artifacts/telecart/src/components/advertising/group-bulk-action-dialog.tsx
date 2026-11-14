import { useState } from "react";
import { useRemoveAdvertisingGroups, useDisableAdvertisingGroups, useUpdateAdvertisingGroup, type AdvertisingGroup, type AdvertisingWorkspace } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { errMsg } from "@/lib/format";

type GroupChoice = Pick<AdvertisingGroup, "id" | "title" | "target">;

export function GroupBulkActionDialog({ groups, action = "remove", onClose, onComplete }: {
  groups: GroupChoice[] | null;
  action?: "remove" | "disable" | "enable";
  onClose: () => void;
  onComplete: (workspace: AdvertisingWorkspace) => void;
}) {
  const remove = useRemoveAdvertisingGroups();
  const disable = useDisableAdvertisingGroups();
  const update = useUpdateAdvertisingGroup();
  const mutation = action === "disable" ? disable : remove;
  const [error, setError] = useState("");
  const [enabling, setEnabling] = useState(false);
  const [enabledCount, setEnabledCount] = useState(0);
  const busy = mutation.isPending || enabling;
  const verb = action === "enable" ? "Enable" : action === "disable" ? "Disable" : "Remove";
  return <AlertDialog open={!!groups} onOpenChange={open => { if (!open && !busy) { setError(""); onClose(); } }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{verb} {groups?.length ?? 0} {action === "remove" ? "selected" : "shown"} groups?</AlertDialogTitle>
        <AlertDialogDescription>
          {action === "enable"
            ? "This turns on the disabled groups listed below from your current filter and search, including unchecked groups. Groups with errors must pass a permission check first and are not included. It does not select groups, join Telegram groups, start posting, or add groups to an already-running campaign."
            : action === "disable"
            ? "This turns off every enabled group listed below from your current filter and search, including unchecked groups, and stops their posting schedules. It does not delete groups or leave them on Telegram."
            : "Posting stops now. The verified account will leave these groups; after departure or absence is confirmed, their saved records and related history are permanently erased. Failed or uncertain departures remain recorded. Duplicate aliases are erased without leaving the valid original group."}
          {" "}{action === "disable" ? "Posting history is kept; " : ""}Groups outside this list are not affected.
          {action !== "enable" && " An action already sent to Telegram may have completed."}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-3 text-sm" aria-label={`Groups confirmed for ${action === "enable" ? "enabling" : action === "disable" ? "disabling" : "removal"}`} data-testid={`list-bulk-${action}-groups`}>
        {groups?.map(group => <li key={group.id} className="break-words">{group.title || group.target}<span className="ml-2 font-mono text-xs text-muted-foreground">{group.target}</span></li>)}
      </ul>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {enabling && <p role="status" className="text-sm">Enabled {enabledCount} / {groups?.length ?? 0}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction className={action === "remove" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined} disabled={busy || !groups?.length}
          data-testid={action === "remove" ? "button-confirm-remove-selected" : `button-confirm-${action}-shown`} onClick={async event => {
            event.preventDefault();
            if (!groups?.length || busy) return;
            setError("");
            if (action === "enable") {
              setEnabling(true);
              setEnabledCount(0);
              let workspace: AdvertisingWorkspace | undefined;
              let completed = 0;
              try {
                for (const group of groups) {
                  workspace = await update.mutateAsync({ id: group.id, data: { enabled: true } });
                  setEnabledCount(++completed);
                }
                onClose();
              } catch (failure) {
                setError(`Enabled ${completed} of ${groups.length} groups. ${errMsg(failure)} Remaining groups were not changed.`);
              } finally {
                if (workspace) onComplete(workspace);
                setEnabling(false);
              }
              return;
            }
            try {
              const workspace = await mutation.mutateAsync({ data: { groupIds: groups.map(group => group.id) } });
              onComplete(workspace);
              onClose();
            } catch (failure) { setError(errMsg(failure)); }
          }}>
          {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {busy ? action === "enable" ? "Enabling…" : action === "disable" ? "Disabling…" : "Removing…" : `${verb} ${groups?.length ?? 0} groups`}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
