import { useState, type FormEvent } from "react";
import { useSaveAdvertisingAppCredentials, useForgetAdvertisingAppCredentials, type AdvertisingWorkspace } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useWorkspaceSync } from "@/components/advertising-panels";
import { errMsg } from "@/lib/format";

export function AppSetup({ ws }: { ws: AdvertisingWorkspace }) {
  const sync = useWorkspaceSync();
  const save = useSaveAdvertisingAppCredentials({ mutation: { gcTime: 0 } });
  const forget = useForgetAdvertisingAppCredentials();
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [id, setId] = useState("");
  const [hash, setHash] = useState("");
  const [error, setError] = useState("");
  const configured = ws.account.appConfigured;
  const busy = save.isPending || forget.isPending;
  const canEdit = !ws.account.configured && !ws.account.login;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const apiId = Number(id);
    if (!/^\d+$/.test(id) || !Number.isInteger(apiId) || apiId < 1 || apiId > 2147483647 || !/^[a-f0-9]{32}$/i.test(hash.trim())) {
      setError("Enter the API ID and 32-character API hash from my.telegram.org/apps."); return;
    }
    setError("");
    try { sync(await save.mutateAsync({ data: { apiId, apiHash: hash.trim() } })); setEdit(false); }
    catch (e) { setError(errMsg(e)); }
    finally { setId(""); setHash(""); save.reset(); }
  }
  return <div className="mb-4 space-y-3 rounded-lg border p-3" data-testid="panel-app-setup">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-sm font-medium">{configured ? "App setup saved" : "One-time Telegram app setup"}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{configured ? "Future logins need only your phone and code, or QR. Disconnecting keeps this setup." : "Telegram needs these app credentials once. After saving, sign in with phone and code or QR."}</p></div>
      {configured && <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!canEdit || busy} title={!canEdit ? "Disconnect and cancel pending login before changing app setup." : undefined} onClick={() => { setEdit(v => !v); setError(""); }} data-testid="button-edit-app-setup">{edit ? "Cancel changes" : "Change setup"}</Button>
        <Button size="sm" variant="ghost" disabled={busy} className="text-destructive" onClick={() => setConfirm(true)} data-testid="button-forget-app-setup">Forget setup</Button>
      </div>}
    </div>
    {(!configured || edit) && <form onSubmit={submit} autoComplete="off" className="space-y-3" data-testid="form-app-setup">
      <p className="text-xs leading-relaxed text-muted-foreground">Get your own API ID and API hash from <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer" className="text-primary underline">my.telegram.org/apps</a>, under API development tools. This is not a BotFather token. Saved values are encrypted and never displayed again; Telegram verifies them when you sign in.</p>
      <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
        <label className="space-y-1 text-sm">API ID<Input inputMode="numeric" value={id} onChange={e => setId(e.target.value.replace(/\D/g, ""))} maxLength={10} disabled={busy} data-testid="input-api-id" /></label>
        <label className="space-y-1 text-sm">API hash<Input type="password" autoComplete="new-password" value={hash} onChange={e => setHash(e.target.value)} maxLength={32} disabled={busy} data-testid="input-api-hash" /></label>
      </div>
      <div className="flex justify-end"><Button type="submit" disabled={busy || !id || !hash} data-testid="button-save-app-setup">{save.isPending ? "Saving..." : "Save app setup"}</Button></div>
    </form>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <AlertDialog open={confirm} onOpenChange={setConfirm}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Forget Telegram app setup?</AlertDialogTitle><AlertDialogDescription>This stops all advertising, disconnects the account, cancels pending login and removes the saved API ID and hash. Groups, draft and posting history stay. You will need app credentials again before logging in.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep setup</AlertDialogCancel><AlertDialogAction disabled={busy} data-testid="button-confirm-forget-app" onClick={async () => {
          try { sync(await forget.mutateAsync()); setEdit(false); setId(""); setHash(""); setError(""); } catch (e) { setError(errMsg(e)); }
        }}>Stop all and forget</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
