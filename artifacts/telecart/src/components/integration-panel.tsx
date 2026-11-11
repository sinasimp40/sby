import { useState } from "react";
import { useGetIntegration, useSaveTelegramCredential, useSaveNowpaymentsCredentials } from "@workspace/api-client-react";
import { Panel, ErrorState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/format";
import { TelegramRuntimeControls } from "./telegram-runtime-controls";

export function IntegrationPanel() {
  const query = useGetIntegration({ query: { refetchInterval: 5000 } });
  const saveTelegram = useSaveTelegramCredential();
  const saveNowpayments = useSaveNowpaymentsCredentials();
  const [telegramToken, setTelegramToken] = useState("");
  const [nowpaymentsApiKey, setNowpaymentsApiKey] = useState("");
  const [nowpaymentsIpnSecret, setNowpaymentsIpnSecret] = useState("");
  const { toast } = useToast();
  const s = query.data;
  const busy = saveTelegram.isPending || saveNowpayments.isPending;
  const error = (e: unknown) => toast({ title: "Connection failed", description: errMsg(e), variant: "destructive" });
  return (
    <Panel title="Provider connections" meta={s?.telegramProcessingEnabled ? s.telegramRuntimeState : "Telegram disabled"}>
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
              <TelegramRuntimeControls status={s} onRefresh={() => { void query.refetch(); }} />
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
                <dt>Telegram token</dt><dd>{s.telegramVerified ? "Verified" : "Not verified"}</dd>
                <dt>NOWPayments API</dt><dd>{s.nowpaymentsVerified ? "Verified" : "Not verified"}</dd>
                <dt>Public callback origin</dt><dd className="max-w-56 break-all">{s.publicUrl || "Not configured"}</dd>
              </dl>
              <p className="text-xs text-muted-foreground">Provider credentials are encrypted before storage and never sent back to the browser. Saving checks the Telegram token and NOWPayments API key with their providers. The IPN secret is saved for signature verification; the provider does not offer a way to check it in advance. The IPN URL is supplied automatically for each invoice. Configure your receiving wallet in NOWPayments.</p>
              <p className="text-xs text-muted-foreground">For localhost: choose Polling above, keep your computer and server running, and disable Telegram here before running the same bot on another computer. Database, admin login, and encryption secrets still need one-time installation setup.</p>
              <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Moving this shop to your computer</summary>
                <p className="mt-2">Follow LOCAL_SETUP.md in the project. Keep this owner ID and your original SESSION_SECRET when using the existing database; a different encryption secret cannot decrypt stored provider keys or stock. Disable this copy before enabling the local one.</p>
                <Input readOnly value={s.ownerId} aria-label="Shop owner ID for local migration" className="mt-2 font-mono text-xs" />
              </details>
            </>}
          </div>
        )}
    </Panel>
  );
}
