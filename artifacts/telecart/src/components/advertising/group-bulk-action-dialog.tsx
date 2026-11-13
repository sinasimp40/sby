import { useState } from "react";
import { useRemoveAdvertisingGroups, useDisableAdvertisingGroups, type AdvertisingGroup, type AdvertisingWorkspace } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { errMsg } from "@/lib/format";

type GroupChoice = Pick<AdvertisingGroup, "id" | "title" | "target">;

export function GroupBulkActionDialog({ groups, action = "remove", onClose, onComplete }: {
  groups: GroupChoice[] | null;
  action?: "remove" | "disable";
  onClose: () => void;
  onComplete: (workspace: AdvertisingWorkspace) => void;
}) {
  const remove = useRemoveAdvertisingGroups();
  const disable = useDisableAdvertisingGroups();
  const mutation = action === "disable" ? disable : remove;
  const [error, setError] = useState("");
  const verb = action === "disable" ? "Disable" : "Remove";
  return <AlertDialog open={!!groups} onOpenChange={open => { if (!open && !mutation.isPending) { setError(""); onClose(); } }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{verb} {groups?.length ?? 0} {action === "disable" ? "shown" : "selected"} groups?</AlertDialogTitle>
        <AlertDialogDescription>
          {action === "disable"
            ? "This turns off every enabled group listed below from your current filter and search, including unchecked groups, and stops their posting schedules. It does not delete groups or leave them on Telegram."
            : "This removes only the groups listed below from advertising and stops their posting schedules. It does not leave them on Telegram."}
          {" "}Posting history is kept; groups outside this list are not affected.
          An action already sent to Telegram may have completed.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-3 text-sm" aria-label={`Groups confirmed for ${action === "disable" ? "disabling" : "removal"}`} data-testid={`list-bulk-${action}-groups`}>
        {groups?.map(group => <li key={group.id} className="break-words">{group.title || group.target}<span className="ml-2 font-mono text-xs text-muted-foreground">{group.target}</span></li>)}
      </ul>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
        <AlertDialogAction className={action === "remove" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined} disabled={mutation.isPending || !groups?.length}
          data-testid={action === "disable" ? "button-confirm-disable-shown" : "button-confirm-remove-selected"} onClick={async event => {
            event.preventDefault();
            if (!groups?.length || mutation.isPending) return;
            setError("");
            try {
              const workspace = await mutation.mutateAsync({ data: { groupIds: groups.map(group => group.id) } });
              onComplete(workspace);
              onClose();
            } catch (failure) { setError(errMsg(failure)); }
          }}>
          {mutation.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {mutation.isPending ? action === "disable" ? "Disabling…" : "Removing…" : `${verb} ${groups?.length ?? 0} groups`}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
