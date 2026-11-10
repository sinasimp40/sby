import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetIntegration, useConnectIntegration, useDisconnectIntegration } from "@workspace/api-client-react";
import { Panel, ErrorState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/format";

export function IntegrationPanel() {
  const query = useGetIntegration({ query: { refetchInterval: 30000 } });
  const connect = useConnectIntegration();
  const disconnect = useDisconnectIntegration();
  const [accepted, setAccepted] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();
  const s = query.data;
  const busy = connect.isPending || disconnect.isPending;
  const success = () => { qc.invalidateQueries(); toast({ title: "Connection updated" }); };
  const error = (e: unknown) => toast({ title: "Connection failed", description: errMsg(e), variant: "destructive" });
  return (
    <Panel title="Live bot connection" meta={s?.connected ? "webhook configured" : "activation required"}>
      {query.isError ? <ErrorState message="Could not load connection status" onRetry={() => query.refetch()} /> :
        !s ? <p className="text-sm text-muted-foreground">Checking configuration…</p> :
        !s.signedIn ? <p className="text-sm text-muted-foreground">Sign in to see your private shop connection and setup instructions.</p> : (
          <div className="space-y-3 text-sm">
            <p>Settlement rule: <strong>finished only</strong>. Confirming, confirmed, sending and partial payments do not deliver stock or credit wallets.</p>
            {!s.ownerBound && <div className="rounded-lg bg-muted p-3">
              <p className="font-medium">Bind the shared bot to your admin account first.</p>
              <p className="mt-1 text-xs text-muted-foreground">For live use, sign in on the published site and set the non-secret environment variable TELECART_OWNER_ID to that account ID. Preview and production sign-ins have separate IDs. This binding prevents another signup from taking control of your bot.</p>
              <Input readOnly value={s.ownerId} aria-label="Your shop owner ID" className="mt-2 font-mono text-xs" data-testid="input-owner-binding" />
            </div>}
            {s.ownerBound && !s.isOperator && <p className="text-muted-foreground">This account is not the configured bot operator. Sign in to the bound admin account to connect the shared bot.</p>}
            {s.isOperator && <>
              <dl className="grid grid-cols-[1fr_auto] gap-2 text-xs">
                <dt>Telegram token</dt><dd>{s.tokenPresent ? "Saved" : "Missing"}</dd>
                <dt>NOWPayments API key</dt><dd>{s.apiKeyPresent ? "Saved" : "Missing"}</dd>
                <dt>NOWPayments IPN secret</dt><dd>{s.ipnSecretPresent ? "Saved" : "Missing"}</dd>
                <dt>Bot</dt><dd>{s.botUsername ? `@${s.botUsername}` : "Not activated"}</dd>
                <dt>Public callback origin</dt><dd className="max-w-56 break-all">{s.publicUrl || "Not configured"}</dd>
              </dl>
              {!s.publicUrl && <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">Publish the app publicly, then set TELECART_PUBLIC_URL to its verified HTTPS production origin. Private/password-protected deployments block provider webhooks unless external access is configured. A workspace preview URL is not used for live callbacks.</p>}
              <p className="text-xs text-muted-foreground">Activate from the published admin panel, not this development preview. Keys stay in server secrets. The IPN URL is supplied automatically when a payment is created. Your receiving wallet must be configured in NOWPayments.</p>
              {!s.connected && <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-0.5" data-testid="checkbox-activate-policy" />
                <span>I understand Telegram requires Stars for digital goods inside bots, and I am responsible for meeting Telegram and NOWPayments requirements. This setup does not override their rules.</span>
              </label>}
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy || !accepted || !s.publicUrl || !s.tokenPresent || !s.apiKeyPresent || !s.ipnSecretPresent || s.connected}
                  onClick={() => connect.mutate({ data: { acknowledgePolicy: true } }, { onSuccess: success, onError: error })}
                  data-testid="button-connect-telegram">{connect.isPending ? "Connecting…" : "Connect Telegram webhook"}</Button>
                {s.connected && <Button variant="outline" disabled={busy} onClick={() => disconnect.mutate(undefined, { onSuccess: success, onError: error })} data-testid="button-disconnect-telegram">Disconnect bot</Button>}
              </div>
              <p className="text-xs text-muted-foreground">Disconnecting stops new Telegram messages. Existing payment notifications can still settle and deliver orders.</p>
            </>}
          </div>
        )}
    </Panel>
  );
}
