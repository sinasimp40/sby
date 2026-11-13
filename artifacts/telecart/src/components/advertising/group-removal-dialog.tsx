import { useState } from "react";
import { useRemoveAdvertisingGroups, type AdvertisingGroup, type AdvertisingWorkspace } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { errMsg } from "@/lib/format";

type GroupChoice = Pick<AdvertisingGroup, "id" | "title" | "target">;

export function GroupRemovalDialog({ groups, onClose, onRemoved }: {
  groups: GroupChoice[] | null;
  onClose: () => void;
  onRemoved: (workspace: AdvertisingWorkspace) => void;
}) {
  const remove = useRemoveAdvertisingGroups();
  const [error, setError] = useState("");
  return <AlertDialog open={!!groups} onOpenChange={open => { if (!open && !remove.isPending) { setError(""); onClose(); } }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Remove {groups?.length ?? 0} selected groups?</AlertDialogTitle>
        <AlertDialogDescription>
          This removes only the groups listed below from advertising and stops their posting schedules.
          It does not leave them on Telegram. Posting history is kept; groups outside this selection are not affected.
          An action already sent to Telegram may have completed.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-3 text-sm" aria-label="Groups confirmed for removal" data-testid="list-bulk-remove-groups">
        {groups?.map(group => <li key={group.id} className="break-words">{group.title || group.target}<span className="ml-2 font-mono text-xs text-muted-foreground">{group.target}</span></li>)}
      </ul>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={remove.isPending}>Keep groups</AlertDialogCancel>
        <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={remove.isPending || !groups?.length}
          data-testid="button-confirm-remove-selected" onClick={async event => {
            event.preventDefault();
            if (!groups?.length || remove.isPending) return;
            setError("");
            try {
              const workspace = await remove.mutateAsync({ data: { groupIds: groups.map(group => group.id) } });
              onRemoved(workspace);
              onClose();
            } catch (failure) { setError(errMsg(failure)); }
          }}>
          {remove.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {remove.isPending ? "Removing…" : `Remove ${groups?.length ?? 0} groups`}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
