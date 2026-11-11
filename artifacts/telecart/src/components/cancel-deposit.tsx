import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCancelDeposit, getListDepositsQueryKey, getListPaymentAttemptsQueryKey,
  getGetOverviewQueryKey, getListActivityQueryKey,
} from "@workspace/api-client-react";
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/format";

export function CancelDepositButton({ id, available }: { id: string; available?: boolean }) {
  const [open, setOpen] = useState(false);
  const cancel = useCancelDeposit();
  const qc = useQueryClient();
  const { toast } = useToast();
  if (!available) return null;
  return (
    <AlertDialog open={open} onOpenChange={value => { if (!cancel.isPending) setOpen(value); }}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-destructive" data-testid={`button-cancel-deposit-${id}`}>Cancel top-up</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this top-up?</AlertDialogTitle>
          <AlertDialogDescription>
            This closes the customer’s deposit flow and updates its Telegram invoice when available.
            It cannot stop a crypto transfer. Any funds already sent will still be checked and credited after final payment verification.
            No wallet funds will be removed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={cancel.isPending}>Keep top-up</AlertDialogCancel>
          <AlertDialogAction disabled={cancel.isPending} data-testid="button-confirm-cancel-deposit" onClick={event => {
            event.preventDefault();
            cancel.mutate({ id }, {
              onSuccess: result => {
                setOpen(false);
                for (const queryKey of [getListDepositsQueryKey(), getListPaymentAttemptsQueryKey(), getGetOverviewQueryKey(), getListActivityQueryKey()]) {
                  void qc.invalidateQueries({ queryKey });
                }
                toast({
                  title: "Top-up cancelled",
                  description: result.telegramUpdatePending
                    ? "Saved. The Telegram invoice update is pending; payment verification continues."
                    : "The deposit flow is cancelled. Payment verification continues for any funds already sent.",
                });
              },
              onError: error => {
                void qc.invalidateQueries({ queryKey: getListDepositsQueryKey() });
                toast({ title: "Could not cancel top-up", description: errMsg(error), variant: "destructive" });
              },
            });
          }}>{cancel.isPending ? "Cancelling…" : "Cancel top-up"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
