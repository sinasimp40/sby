import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertTriangle, Loader2, QrCode, Clock, Network, Hash, ShieldAlert, KeyRound } from "lucide-react";
import { PageHeader, Panel, ErrorState, RowsSkeleton, SetupRequired } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { useShopSettings } from "@/hooks/use-shop-settings";
import { cn } from "@/lib/utils";

const COINS = [
  { id: "BTC", name: "Bitcoin" }, { id: "ETH", name: "Ethereum" }, { id: "LTC", name: "Litecoin" },
  { id: "USDTTRC20", name: "USDT · TRON" }, { id: "USDTERC20", name: "USDT · Ethereum" }, { id: "SOL", name: "Solana" },
] as const;
const schema = z.object({
  minDeposit: z.coerce.number().min(1, "At least $1").max(100000),
  invoiceExpiryMinutes: z.coerce.number().int("Whole minutes").min(10, "Minimum 10 minutes").max(120, "Maximum 120 minutes"),
  acceptedCoins: z.array(z.enum(["BTC", "ETH", "LTC", "USDTTRC20", "USDTERC20", "SOL"])).min(1, "Select at least one coin"),
});
type V = z.infer<typeof schema>;

const steps = [
  { i: Hash, t: "Buyer picks an amount", d: "From the Wallet menu, at or above your minimum deposit, in USD." },
  { i: QrCode, t: "Invoice is created at NOWPayments", d: "The bot would send a QR code with the exact crypto amount and deposit address." },
  { i: Network, t: "Network is stated explicitly", d: "e.g. USDT on TRC20 vs ERC20 — sending on the wrong network loses funds." },
  { i: Clock, t: "Invoice expires", d: "After your chosen window, the rate lock ends and a new invoice is needed." },
];

export default function PaymentsPage() {
  const { settings, savePartial, saving } = useShopSettings();
  const form = useForm<V>({ resolver: zodResolver(schema), defaultValues: { minDeposit: 5, invoiceExpiryMinutes: 30, acceptedCoins: ["BTC"] } });
  const inited = useRef(false);
  useEffect(() => {
    const s = settings.data;
    if (s && !inited.current) { inited.current = true; form.reset({ minDeposit: s.minDeposit, invoiceExpiryMinutes: s.invoiceExpiryMinutes, acceptedCoins: s.acceptedCoins }); }
  }, [settings.data, form]);

  return (
    <div>
      <PageHeader eyebrow="Provider · NOWPayments" title="Payments" description="Choose how crypto deposits should work. These are saved as preferences only — no payments can be taken in this build." actions={<SetupRequired label="Not connected" />} />
      <div className="rise mb-5 flex gap-3 rounded-xl border border-signal/35 bg-signal-soft p-4" data-testid="note-stars-policy">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-signal" />
        <div className="text-sm">
          <div className="font-semibold">Telegram policy: digital goods inside bots must be paid with Telegram Stars.</div>
          <p className="mt-1 text-foreground/75">Telecart is configured for NOWPayments, not Stars. Before activation, NOWPayments checkout needs a compliant approach — for example, taking payment outside the bot conversation. Live checkout stays off until that is resolved.</p>
        </div>
      </div>
      {settings.isError ? <ErrorState message="Failed to load settings" onRetry={() => settings.refetch()} /> : settings.isLoading ? <RowsSkeleton rows={6} /> : (
        <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
          <Form {...form}>
            <form onSubmit={form.handleSubmit((d) => savePartial(d, "Payment preferences"))} className="space-y-5">
              <Panel title="Accepted coins">
                <FormField control={form.control} name="acceptedCoins" render={({ field }) => (
                  <FormItem>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {COINS.map((c) => {
                        const on = field.value.includes(c.id);
                        return (
                          <button type="button" key={c.id} data-testid={`toggle-coin-${c.id}`} onClick={() => field.onChange(on ? field.value.filter((x) => x !== c.id) : [...field.value, c.id])}
                            className={cn("rounded-lg border px-3 py-2.5 text-left transition-all", on ? "border-primary bg-accent shadow-sm" : "border-border bg-background hover:border-foreground/30")}>
                            <div className="flex items-center justify-between"><span className="font-mono text-xs font-semibold">{c.id}</span><span className={cn("h-3.5 w-3.5 rounded-full border-2", on ? "border-primary bg-primary" : "border-border")} /></div>
                            <div className="mt-0.5 text-xs text-muted-foreground">{c.name}</div>
                          </button>
                        );
                      })}
                    </div>
                    <FormMessage />
                  </FormItem>
                )} />
              </Panel>
              <Panel title="Deposit rules">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField control={form.control} name="minDeposit" render={({ field }) => (<FormItem><FormLabel>Minimum deposit (USD)</FormLabel><FormControl><Input type="number" step="0.01" {...field} data-testid="input-min-deposit" /></FormControl><FormMessage /></FormItem>)} />
                  <FormField control={form.control} name="invoiceExpiryMinutes" render={({ field }) => (<FormItem><FormLabel>Invoice expiry (minutes)</FormLabel><FormControl><Input type="number" {...field} data-testid="input-invoice-expiry" /></FormControl><FormDescription>10–120 minutes</FormDescription><FormMessage /></FormItem>)} />
                </div>
              </Panel>
              <div className="flex justify-end"><Button type="submit" disabled={saving} data-testid="button-save-payments">{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save preferences</Button></div>
            </form>
          </Form>
          <div className="space-y-5">
            <Panel title="Intended deposit flow" meta="not active">
              <ol className="space-y-3">
                {steps.map((s, i) => (
                  <li key={i} className="flex gap-3"><div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border bg-background"><s.i className="h-4 w-4 text-primary" /></div>
                    <div><div className="text-sm font-medium">{s.t}</div><div className="text-xs text-muted-foreground">{s.d}</div></div></li>
                ))}
              </ol>
              <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">No sample QR codes or addresses are generated here, so nobody can mistake one for a real payment request.</p>
            </Panel>
            <Panel title="Connection">
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between"><span>Provider</span><span className="font-mono text-xs">{settings.data?.paymentProvider || "NOWPayments"}</span></div>
                <div className="flex items-center justify-between"><span>Status</span><SetupRequired label="Setup required" /></div>
                <div className="flex gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground"><KeyRound className="h-4 w-4 shrink-0" />API keys are not entered here. They will be added later through a secure secrets workflow, never stored in shop settings.</div>
                <div className="flex gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground"><AlertTriangle className="h-4 w-4 shrink-0" />Until connected, there is no invoice creation and wallet balances cannot change.</div>
              </div>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
