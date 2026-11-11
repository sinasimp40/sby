import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetIntegration, useConnectIntegration, useDisconnectIntegration, useSaveTelegramCredential, useSaveNowpaymentsCredentials } from "@workspace/api-client-react";
import { Panel, ErrorState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/format";

export function IntegrationPanel() {
  const query = useGetIntegration({ query: { refetchInterval: 30000 } });
  const connect = useConnectIntegration();
  const disconnect = useDisconnectIntegration();
  const saveTelegram = useSaveTelegramCredential();
  const saveNowpayments = useSaveNowpaymentsCredentials();
  const [accepted, setAccepted] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [nowpaymentsApiKey, setNowpaymentsApiKey] = useState("");
  const [nowpaymentsIpnSecret, setNowpaymentsIpnSecret] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();
  const s = query.data;
  const busy = connect.isPending || disconnect.isPending || saveTelegram.isPending || saveNowpayments.isPending;
  const success = () => { qc.invalidateQueries(); toast({ title: "Connection updated" }); };
  const error = (e: unknown) => toast({ title: "Connection failed", description: errMsg(e), variant: "destructive" });
  return (
    <Panel title="Provider connections" meta={s?.connected ? (s.publicUrl.includes(".replit.dev") ? "workspace polling" : "webhook configured") : "activation required"}>
      {query.isError ? <ErrorState message="Could not load connection status" onRetry={() => query.refetch()} /> :
        !s ? <p className="text-sm text-muted-foreground">Checking configuration…</p> :
        !s.signedIn ? <p className="text-sm text-muted-foreground">Sign in to see your private shop connection and setup instructions.</p> : (
          <div className="space-y-3 text-sm">
            <p>Settlement rule: <strong>finished only</strong>. Confirming, confirmed, sending and partial payments do not deliver stock or credit wallets.</p>
            {!s.ownerBound && <div className="rounded-lg bg-muted p-3">
              <p className="font-medium">Bind the shared bot to your admin account first.</p>
              <p className="mt-1 text-xs text-muted-foreground">Sign in to your configured admin account. A secure first-admin setup binds it automatically; otherwise set TELECART_OWNER_ID to this account ID. Workspace and published sign-ins have separate IDs. This binding prevents another signup from taking control of your bot.</p>
              <Input readOnly value={s.ownerId} aria-label="Your shop owner ID" className="mt-2 font-mono text-xs" data-testid="input-owner-binding" />
            </div>}
            {s.ownerBound && !s.isOperator && <p className="text-muted-foreground">This account is not the configured bot operator. Sign in to the bound admin account to connect the shared bot.</p>}
            {s.isOperator && <>
              <div className="space-y-4 rounded-lg border p-3">
                <div>
                  <label htmlFor="telegram-bot-token" className="text-xs font-medium">Telegram bot token</label>
                  <p className="mb-2 mt-1 text-xs text-muted-foreground">{s.telegramVerified ? `Verified with Telegram${s.botUsername ? ` as @${s.botUsername}` : ""}. Enter a new token to replace it.` : "Enter the token from BotFather. We’ll check it with Telegram before saving."}</p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input id="telegram-bot-token" type="password" autoComplete="new-password" maxLength={512} value={telegramToken} onChange={e => setTelegramToken(e.target.value)} placeholder={s.tokenPresent ? "Saved token — enter to replace" : "Paste Telegram bot token"} data-testid="input-telegram-token" />
                    <Button type="button" variant="outline" disabled={busy || !telegramToken.trim()} onClick={() => saveTelegram.mutate({ data: { token: telegramToken.trim() } }, {
                      onSuccess: async result => {
                        if (result.saved) { setTelegramToken(""); await query.refetch(); }
                        toast({ title: result.saved ? `Telegram verified as @${result.botUsername}` : `Verified as @${result.botUsername} but not saved`, description: result.message, variant: result.saved ? "default" : "destructive" });
                      },
                      onError: error,
                    })} data-testid="button-check-telegram">{saveTelegram.isPending ? "Checking…" : s.telegramVerified ? "Check and replace" : "Check and save"}</Button>
                  </div>
                </div>
                <div className="border-t pt-3">
                  <label htmlFor="nowpayments-api-key" className="text-xs font-medium">NOWPayments API key</label>
                  <p className="mb-2 mt-1 text-xs text-muted-foreground">{s.nowpaymentsVerified ? "API key verified with NOWPayments. Enter both values to replace them." : "We’ll verify the API key with NOWPayments before saving."}</p>
                  <Input id="nowpayments-api-key" type="password" autoComplete="new-password" maxLength={512} value={nowpaymentsApiKey} onChange={e => setNowpaymentsApiKey(e.target.value)} placeholder={s.apiKeyPresent ? "Saved key — enter to replace" : "Paste NOWPayments API key"} data-testid="input-nowpayments-api-key" />
                  <label htmlFor="nowpayments-ipn-secret" className="mt-3 block text-xs font-medium">NOWPayments IPN secret</label>
                  <p className="mb-2 mt-1 text-xs text-muted-foreground">{s.ipnSecretPresent ? "A signature secret is saved. It is used to verify payment notifications." : "Copy the IPN secret from your NOWPayments settings. The API can’t verify this value directly."}</p>
                  <Input id="nowpayments-ipn-secret" type="password" autoComplete="new-password" maxLength={512} value={nowpaymentsIpnSecret} onChange={e => setNowpaymentsIpnSecret(e.target.value)} placeholder={s.ipnSecretPresent ? "Saved secret — enter to replace" : "Paste NOWPayments IPN secret"} data-testid="input-nowpayments-ipn-secret" />
                  <Button type="button" variant="outline" className="mt-2 w-full sm:w-auto" disabled={busy || !nowpaymentsApiKey.trim() || !nowpaymentsIpnSecret.trim()} onClick={() => saveNowpayments.mutate({ data: { apiKey: nowpaymentsApiKey.trim(), ipnSecret: nowpaymentsIpnSecret.trim() } }, {
                    onSuccess: async () => { setNowpaymentsApiKey(""); setNowpaymentsIpnSecret(""); await query.refetch(); toast({ title: "NOWPayments API key verified and credentials saved" }); },
                    onError: error,
                  })} data-testid="button-check-nowpayments">{saveNowpayments.isPending ? "Checking…" : s.nowpaymentsVerified ? "Check and replace" : "Check and save"}</Button>
                </div>
              </div>
              <dl className="grid grid-cols-[1fr_auto] gap-2 text-xs">
                <dt>Telegram bot</dt><dd>{s.connected ? "Connected" : s.telegramVerified ? `Token verified · ${s.telegramProcessingEnabled ? "not connected" : "processing disabled"}` : "Not verified"}</dd>
                <dt>NOWPayments API</dt><dd>{s.nowpaymentsVerified ? "Verified" : "Not verified"}</dd>
                <dt>Public callback origin</dt><dd className="max-w-56 break-all">{s.publicUrl || "Not configured"}</dd>
              </dl>
              {!s.publicUrl && <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">Set TELECART_PUBLIC_URL to the public HTTPS origin. For workspace testing, also enable TELECART_ALLOW_WORKSPACE_TESTING. Providers must be able to reach the URL without signing in.</p>}
              <p className="text-xs text-muted-foreground">Provider credentials are encrypted before storage and never sent back to the browser. Saving checks the Telegram token and NOWPayments API key with their providers. The IPN secret is saved for signature verification; the provider does not offer a way to check it in advance. The IPN URL is supplied automatically for each invoice. Configure your receiving wallet in NOWPayments.</p>
              {!s.telegramProcessingEnabled && <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">Telegram processing is disabled in this workspace for safety. The token check still verifies it with Telegram, but connecting the bot and processing messages requires enabling TELECART_TELEGRAM_DISABLED=false when you are ready for live bot activity.</p>}
              {s.publicUrl.includes(".replit.dev") && <p className="rounded-lg bg-muted p-3 text-xs">{s.telegramProcessingEnabled ? "Workspace Telegram testing uses outbound polling. Connecting replaces this bot's other receiver." : "Telegram polling is disabled in this workspace."} Payment status and received amounts are checked against NOWPayments while the workspace runs, even if incoming notifications are blocked. The invoice's Check payment button also refreshes immediately. Messages and invoices are real after activation.</p>}
              {!s.connected && <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-0.5" data-testid="checkbox-activate-policy" />
                <span>I understand Telegram requires Stars for digital goods inside bots, and I am responsible for meeting Telegram and NOWPayments requirements. This setup does not override their rules.</span>
              </label>}
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy || !accepted || !s.publicUrl || !s.tokenPresent || !s.apiKeyPresent || !s.ipnSecretPresent || s.connected || !s.telegramProcessingEnabled}
                  onClick={() => connect.mutate({ data: { acknowledgePolicy: true } }, { onSuccess: success, onError: error })}
                  data-testid="button-connect-telegram">{connect.isPending ? "Connecting…" : "Connect Telegram bot"}</Button>
                {s.connected && <Button variant="outline" disabled={busy} onClick={() => disconnect.mutate(undefined, { onSuccess: success, onError: error })} data-testid="button-disconnect-telegram">Disconnect bot</Button>}
              </div>
              <p className="text-xs text-muted-foreground">Disconnecting stops new Telegram messages. Existing payment notifications can still settle and deliver orders.</p>
            </>}
          </div>
        )}
    </Panel>
  );
}
