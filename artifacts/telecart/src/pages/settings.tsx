import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { PageHeader, Panel, ErrorState, RowsSkeleton } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { useShopSettings } from "@/hooks/use-shop-settings";

const schema = z.object({
  shopName: z.string().trim().min(1, "Shop name is required").max(100),
  currency: z.literal("USD"),
  maintenanceMode: z.boolean(),
});
type V = z.infer<typeof schema>;

export default function SettingsPage() {
  const { settings, savePartial, saving } = useShopSettings();
  const form = useForm<V>({ resolver: zodResolver(schema), defaultValues: { shopName: "", currency: "USD", maintenanceMode: false } });
  const inited = useRef<boolean | null>(null);
  const dirty = form.formState.isDirty;
  useEffect(() => {
    const s = settings.data;
    if (s && (inited.current !== s.isDemo || !dirty)) { inited.current = s.isDemo; form.reset({ shopName: s.shopName, currency: "USD", maintenanceMode: s.maintenanceMode }); }
  }, [settings.data, form, dirty]);

  return (
    <div>
      <PageHeader eyebrow="Shop" title="Settings" description="Core preferences for your shop." />
      {settings.isError ? <ErrorState message="Failed to load settings" onRetry={() => settings.refetch()} /> : settings.isLoading ? <RowsSkeleton rows={4} /> : (
        <Form {...form}>
          <form onSubmit={form.handleSubmit((d) => savePartial(d, "Shop settings"))} className="max-w-2xl space-y-5">
            <Panel title="General">
              <div className="space-y-4">
                <FormField control={form.control} name="shopName" render={({ field }) => (<FormItem><FormLabel>Shop name</FormLabel><FormControl><Input {...field} data-testid="input-shop-name" /></FormControl><FormDescription>Shown in the bot header and receipts.</FormDescription><FormMessage /></FormItem>)} />
                <div><div className="text-sm font-medium">Currency</div><div className="mt-1.5 inline-flex rounded-md border border-border bg-muted px-3 py-1.5 font-mono text-sm" data-testid="text-currency">USD</div><p className="mt-1 text-xs text-muted-foreground">Prices are set in US dollars; crypto amounts are converted at invoice time.</p></div>
              </div>
            </Panel>
            <Panel title="Availability">
              <FormField control={form.control} name="maintenanceMode" render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-4">
                  <div><FormLabel>Maintenance mode</FormLabel><FormDescription>After saving, customer commands and buttons show a pause notice instead of the menu. Payments already sent continue to be checked automatically.</FormDescription></div>
                  <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} data-testid="switch-maintenance" /></FormControl>
                </FormItem>
              )} />
            </Panel>
            <Panel title="Integrations">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">Telegram bot</dt><dd className="font-medium text-signal">{settings.data?.botConnected ? "Connected" : "Not connected"}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Payments ({settings.data?.paymentProvider || "NOWPayments"})</dt><dd className="font-medium text-signal">{settings.data?.paymentsConnected ? "Connected" : "Not connected"}</dd></div>
              </dl>
            </Panel>
            <div className="flex justify-end"><Button type="submit" disabled={saving} data-testid="button-save-settings">{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save settings</Button></div>
          </form>
        </Form>
      )}
    </div>
  );
}
