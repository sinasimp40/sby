import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAddCustomerWalletCredit, getListCustomersQueryKey, getGetOverviewQueryKey, getListActivityQueryKey,
  getListCustomerWalletCreditsQueryKey, type Customer, type CustomerWalletCreditInput,
} from "@workspace/api-client-react";
import { Loader2, Plus } from "lucide-react";
import { useAdminAuth } from "@/hooks/use-admin-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CustomerCreditHistory } from "./customer-credit-history";
import { MAX_WALLET_CENTS, walletCreditCents, pendingCreditKey, readPendingCredit, creditFailureIsDefinite } from "@/lib/wallet-credit";
import { customerName, errMsg, money } from "@/lib/format";

export function CustomerWalletCredit({ customer }: { customer: Customer }) {
  const { user } = useAdminAuth();
  const storageKey = pendingCreditKey(user?.id ?? "", customer.id);
  const [restored] = useState(() => readPendingCredit(storageKey));
  const [pending, setPending] = useState(restored.input);
  const [editing, setEditing] = useState(Boolean(restored.input));
  const [amount, setAmount] = useState(restored.input ? (restored.input.amountCents / 100).toFixed(2) : "");
  const [reason, setReason] = useState(restored.input?.reason ?? "");
  const [review, setReview] = useState<{ input: CustomerWalletCreditInput; before: number } | null>(null);
  const [error, setError] = useState(restored.error);
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);
  const credit = useAddCustomerWalletCredit({ mutation: { retry: false } });
  const qc = useQueryClient();
  const { toast } = useToast();
  const cents = walletCreditCents(amount);
  const balance = Math.round(customer.walletBalance * 100);
  const valid = cents !== null && cents + balance <= MAX_WALLET_CENTS && reason.trim().length > 0 && reason.trim().length <= 500;

  async function confirm() {
    if (!review || lock.current || restored.error || !user) return;
    lock.current = true;
    const input = pending ?? review.input;
    try {
      // Persist BEFORE sending. Unknown outcomes must reuse this operation key,
      // including after closing the panel or refreshing the same browser tab.
      try { window.sessionStorage.setItem(storageKey, JSON.stringify(input)); }
      catch { throw new Error("Your browser cannot save the credit retry reference. Allow session storage before adding credit. No new request was sent."); }
      setPending(input);
      setError("");
      const result = await credit.mutateAsync({ id: customer.id, data: input });
      qc.setQueryData<Customer[]>(getListCustomersQueryKey(), rows => rows?.map(row =>
        row.id === customer.id ? { ...row, walletBalance: result.balanceCents / 100 } : row));
      for (const queryKey of [getListCustomersQueryKey(), getGetOverviewQueryKey(), getListActivityQueryKey(), getListCustomerWalletCreditsQueryKey(customer.id)])
        void qc.invalidateQueries({ queryKey });
      // If storage cleanup fails, retain the same reference rather than allowing
      // a new financial operation that might unintentionally repeat this credit.
      window.sessionStorage.removeItem(storageKey);
      setPending(null); setReview(null); setEditing(false); setAmount(""); setReason("");
      setRevision(value => value + 1);
      toast({ title: result.replayed ? "Previous credit confirmed" : "Customer credited",
        description: `${money(result.credit.amountCents / 100)} credited. Current wallet: ${money(result.balanceCents / 100)}.` });
    } catch (failure) {
      if (creditFailureIsDefinite(failure)) {
        try { window.sessionStorage.removeItem(storageKey); setPending(null); }
        catch { /* Keep the reference so an unconfirmed operation is never replaced. */ }
      }
      setError(errMsg(failure));
    } finally { lock.current = false; }
  }
  return <>
    <section className="mt-5 rounded-lg border p-3" aria-label="Add customer wallet credit">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Wallet credit</h3>
        {!editing && <Button size="sm" variant="outline" disabled={!!restored.error || !user} onClick={() => { setEditing(true); setError(""); }} data-testid="button-add-customer-credit"><Plus className="mr-1 h-3.5 w-3.5" />Add credit</Button>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Add owner-issued funds in USD. This is not a payment deposit and does not send the customer a message.</p>
      {pending && <p role="status" className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
        A credit may already have been applied. Retry this same credit to confirm it safely; do not create another credit for the same adjustment.
      </p>}
      {editing && <form className="mt-3 space-y-3" onSubmit={event => {
        event.preventDefault();
        if (credit.isPending || restored.error || (!pending && !valid)) return;
        setError("");
        setReview({ input: pending ?? { requestKey: crypto.randomUUID(), amountCents: cents!, reason: reason.trim() }, before: balance });
      }}>
        <div className="space-y-1">
          <Label htmlFor="customer-credit-amount">Credit amount (USD)</Label>
          <Input id="customer-credit-amount" inputMode="decimal" placeholder="10.00" maxLength={11} value={amount}
            disabled={!!pending || credit.isPending} onChange={event => setAmount(event.target.value)} required aria-describedby="credit-amount-help" data-testid="input-customer-credit-amount" />
          <p id="credit-amount-help" className="text-xs text-muted-foreground">Positive amounts only, with at most two decimal places.</p>
          {amount && cents === null && <p className="text-xs text-destructive">Enter a valid positive USD amount, such as 10.00.</p>}
          {cents !== null && cents + balance > MAX_WALLET_CENTS && <p className="text-xs text-destructive">The resulting balance exceeds the $20,000,000.00 limit.</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor="customer-credit-reason">Reason</Label>
          <Textarea id="customer-credit-reason" value={reason} maxLength={500} rows={3} required
            disabled={!!pending || credit.isPending} onChange={event => setReason(event.target.value)} placeholder="Why are you adding this credit?" data-testid="input-customer-credit-reason" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" disabled={credit.isPending || !!restored.error || (!pending && !valid)} data-testid="button-review-customer-credit">{pending ? "Review pending credit" : "Review credit"}</Button>
          {!pending && <Button size="sm" type="button" variant="ghost" disabled={credit.isPending} onClick={() => { setEditing(false); setError(""); }}>Cancel</Button>}
        </div>
      </form>}
      {error && <p role="alert" className="mt-3 break-words text-sm text-destructive">{error}</p>}
    </section>
    <CustomerCreditHistory customerId={customer.id} revision={revision} />
    <AlertDialog open={!!review} onOpenChange={open => { if (!open && !credit.isPending && !lock.current) setReview(null); }}>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{pending ? "Confirm the pending credit?" : "Add wallet credit?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {pending ? "This safely checks or applies the original credit reference. It cannot add that credit twice." : "Confirm this owner-issued wallet credit. Funds can be spent immediately; this form cannot reverse a completed credit."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {review && <dl className="space-y-2 rounded-lg border p-3 text-sm">
          <div><dt className="text-muted-foreground">Customer</dt><dd className="break-words font-semibold">{customerName(customer.username)}</dd>
            <dd className="break-all text-xs text-muted-foreground">Telegram ID: {customer.telegramId ?? "Not available"} · Customer: {customer.id}</dd></div>
          <div className="flex justify-between gap-3"><dt>Credit amount</dt><dd className="font-semibold">{money(review.input.amountCents / 100)}</dd></div>
          {!pending && <><div className="flex justify-between gap-3"><dt>Current wallet</dt><dd>{money(review.before / 100)}</dd></div>
            <div className="flex justify-between gap-3"><dt>Balance after credit</dt><dd>{money((review.before + review.input.amountCents) / 100)}</dd></div>
            <p className="text-xs text-muted-foreground">Other purchases or deposits can change this estimate. The actual balance is shown after confirmation.</p></>}
          <div><dt className="text-muted-foreground">Reason</dt><dd className="whitespace-pre-wrap break-words">{review.input.reason}</dd></div>
        </dl>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={credit.isPending}>Back</AlertDialogCancel>
          <AlertDialogAction onClick={event => { event.preventDefault(); void confirm(); }} disabled={credit.isPending || !!restored.error} data-testid="button-confirm-customer-credit">
            {credit.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {credit.isPending ? "Confirming…" : pending ? "Retry same credit" : "Confirm credit"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
