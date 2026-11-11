import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUpdateTelegramRuntime, getGetIntegrationQueryKey, type IntegrationStatus } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/format";

export function TelegramRuntimeControls({ status: s, onRefresh }: { status: IntegrationStatus; onRefresh: () => void }) {
  const [draft, setDraft] = useState<{ transport: "polling" | "webhook"; publicUrl: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const mutation = useUpdateTelegramRuntime();
  const qc = useQueryClient();
  const { toast } = useToast();
  const values = draft ?? { transport: s.telegramTransport, publicUrl: s.publicUrl };
  const labels = { disabled: "Disabled", starting: "Starting — checking Telegram", running: "Running · polling", error: "Needs attention", webhook: "Webhook configured" };
  function save(enabled: boolean) {
    mutation.mutate({ data: {
      ...(enabled ? values : { transport: s.telegramTransport, publicUrl: s.publicUrl }),
      enabled, acknowledgePolicy: enabled && accepted,
    } }, {
      onSuccess: result => {
        setDraft(null); setConfirm(false); setAccepted(false);
        qc.setQueryData(getGetIntegrationQueryKey(), result);
        qc.invalidateQueries();
        toast({ title: enabled ? "Telegram enabled" : "Telegram disabled", description: enabled ? "The server is checking the receiver. Watch the live status below." : "Saved. Payment checks continue; bot messages and delivery will wait until you enable it again." });
      },
      onError: e => {
        qc.invalidateQueries();
        toast({ title: "Could not update Telegram", description: errMsg(e), variant: "destructive" });
      },
    });
  }
  function saveSettings() {
    mutation.mutate({ data: { ...values, enabled: false, acknowledgePolicy: false } }, {
      onSuccess: result => { setDraft(null); qc.setQueryData(getGetIntegrationQueryKey(), result); qc.invalidateQueries(); toast({ title: "Connection settings saved", description: "Telegram is still disabled." }); },
      onError: e => toast({ title: "Could not save settings", description: errMsg(e), variant: "destructive" }),
    });
  }
  return <section className="space-y-3 rounded-lg border p-3" aria-label="Telegram processing controls">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="font-medium">Telegram processing</h3>
        <p className="mt-1 text-xs" role="status" data-testid="text-telegram-runtime-status">{labels[s.telegramRuntimeState]}{s.botUsername ? ` · @${s.botUsername}` : ""}</p>
      </div>
      <Button size="sm" variant="outline" type="button" onClick={onRefresh} data-testid="button-refresh-telegram-status">Refresh status</Button>
    </div>
    {s.telegramRuntimeError && <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive" role="alert">{s.telegramRuntimeError}</p>}
    {s.telegramLastCheckedAt && <p className="text-xs text-muted-foreground">Last worker check: {new Date(s.telegramLastCheckedAt).toLocaleTimeString()}</p>}
    <fieldset disabled={s.telegramProcessingEnabled || mutation.isPending} className="space-y-3 disabled:opacity-60">
      <div><label htmlFor="telegram-transport" className="text-xs font-medium">Connection mode</label>
        <select id="telegram-transport" className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={values.transport}
          onChange={e => setDraft({ ...values, transport: e.target.value as "polling" | "webhook" })} data-testid="select-telegram-transport">
          <option value="polling">Polling — localhost or a running server</option>
          <option value="webhook">Webhook — public HTTPS server</option>
        </select>
        <p className="mt-1 text-xs text-muted-foreground">Polling needs only internet access, not a public Telegram URL. Run only one copy of this bot. Disable Telegram before changing these settings.</p>
      </div>
      <div><label htmlFor="telegram-public-url" className="text-xs font-medium">Public HTTPS callback origin {values.transport === "polling" ? "(optional)" : "(required)"}</label>
        <Input id="telegram-public-url" type="url" value={values.publicUrl} placeholder="https://shop.example.com"
          onChange={e => setDraft({ ...values, publicUrl: e.target.value })} data-testid="input-telegram-public-url" />
        <p className="mt-1 text-xs text-muted-foreground">No path after the domain. Never enter localhost here. Without a public URL, payment status is checked through NOWPayments automatically while the server runs; incoming payment notifications are unavailable.</p>
      </div>
      <Button type="button" size="sm" variant="outline" disabled={!draft || mutation.isPending} onClick={saveSettings} data-testid="button-save-telegram-settings">Save connection settings</Button>
    </fieldset>
    <div className="flex flex-wrap gap-2">
      {s.telegramProcessingEnabled ?
        <Button type="button" variant="destructive" disabled={mutation.isPending} onClick={() => save(false)} data-testid="button-disable-telegram">{mutation.isPending ? "Disabling…" : "Disable Telegram"}</Button> :
        <Button type="button" disabled={mutation.isPending || !s.tokenPresent} onClick={() => { setAccepted(false); setConfirm(true); }} data-testid="button-enable-telegram">Enable Telegram</Button>}
    </div>
    {!s.tokenPresent && <p className="text-xs text-muted-foreground">Check and save a Telegram token below before enabling.</p>}
    <p className="text-xs text-muted-foreground">Changes apply immediately without a server restart and stay saved after restart. Disabling pauses new bot commands and delivery messages, not payment verification. In-flight requests may finish. No orders or stock are deleted.</p>
    {s.telegramTransport === "webhook" && s.telegramProcessingEnabled && <p className="text-xs text-muted-foreground">Webhook configured does not prove delivery. The callback URL must be publicly reachable without sign-in.</p>}
    <AlertDialog open={confirm} onOpenChange={open => !mutation.isPending && setConfirm(open)}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Enable real Telegram processing?</AlertDialogTitle>
          <AlertDialogDescription>This server will take over this bot’s receiver, process queued commands, send real replies, and retry pending delivery messages. Stop other copies on Replit or your computer before enabling. Existing payments are not recreated.</AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-1" data-testid="checkbox-activate-policy" />
          <span>I approve live processing and understand that Telegram requires Stars for digital goods. I am responsible for complying with Telegram and NOWPayments rules; this setup does not override them.</span></label>
        <AlertDialogFooter><AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <Button disabled={!accepted || mutation.isPending} onClick={() => save(true)} data-testid="button-confirm-enable-telegram">{mutation.isPending ? "Enabling…" : "Enable and send real replies"}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
