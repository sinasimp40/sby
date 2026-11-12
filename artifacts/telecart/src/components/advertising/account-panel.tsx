import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  useBeginAdvertisingAccountLogin, useVerifyAdvertisingAccountLogin, usePollAdvertisingAccountLogin,
  useCancelAdvertisingAccountLogin, useCheckAdvertisingAccount, useDisconnectAdvertisingAccount,
  type AdvertisingWorkspace, type AdvertisingAccountLogin,
} from "@workspace/api-client-react";
import { Loader2, QrCode, Smartphone, RefreshCw, Unplug, KeyRound, UserRound, X } from "lucide-react";
import { Panel } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { errMsg, ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useWorkspaceSync } from "@/components/advertising-panels";
import { AppSetup } from "./app-setup";

const secret = { mutation: { gcTime: 0 } } as const;

function StatusLine({ ws, busy }: { ws: AdvertisingWorkspace; busy: boolean }) {
  const a = ws.account;
  const label = busy ? "Working" : a.connected ? "Connected" : a.login ? (a.login.step === "expired" ? "Login expired" : "Login in progress") : a.configured ? "Needs attention" : "Not connected";
  const ok = a.connected && !busy;
  return <span role="status" aria-live="polite" className={cn("inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider", ok ? "text-ok" : "text-signal")} data-testid="status-ad-account"><span className={cn("h-1.5 w-1.5 rounded-full", ok ? "bg-ok" : "bg-signal")} />{label}</span>;
}

export function AccountPanel({ ws }: { ws: AdvertisingWorkspace }) {
  const sync = useWorkspaceSync();
  const { toast } = useToast();
  const check = useCheckAdvertisingAccount();
  const disconnect = useDisconnectAdvertisingAccount();
  const [confirmOff, setConfirmOff] = useState(false);
  const [relogin, setRelogin] = useState(false);
  const [err, setErr] = useState("");
  const a = ws.account;
  const busy = check.isPending || disconnect.isPending;
  const running = ws.groups.filter(g => g.running).length;
  const showLogin = !a.connected || relogin || !!a.login;
  return (
    <Panel title="Telegram account" meta={<StatusLine ws={ws} busy={busy} />}>
      <p className="mb-4 rounded-lg border border-signal/30 bg-signal-soft/40 p-3 text-xs text-muted-foreground" data-testid="text-telegram-security-warning">If Telegram reports suspicious activity, resets sessions or freezes bots, stop and review Telegram Settings → Devices and the official security notice. Do not repeatedly scan, log in or check channels. Telecart cannot lift Telegram restrictions. Use your own API app credentials and only one server for this account session. Channel checks do not join channels or send advertisements.</p>
      {a.connected && (
        <div className="mb-4 space-y-2">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-primary/10 text-primary"><UserRound className="h-5 w-5" /></div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold" data-testid="text-ad-account-name">{a.displayName || "Telegram account"}</div>
              <div className="truncate font-mono text-xs text-muted-foreground" data-testid="text-ad-account-username">{a.username ? `@${a.username}` : a.accountId ? `id ${a.accountId}` : ""}{a.checkedAt ? ` · checked ${ago(a.checkedAt)}` : ""}</div>
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setErr(""); try { const r = await check.mutateAsync(); sync(r); toast({ title: r.account.connected ? "Session is valid" : "Session check failed", variant: r.account.connected ? "default" : "destructive" }); } catch (x) { setErr(errMsg(x)); } }} data-testid="button-check-ad-account">{check.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Check session</Button>
            <Button size="sm" variant="ghost" disabled={busy} className="text-destructive" onClick={() => setConfirmOff(true)} data-testid="button-disconnect-ad-account"><Unplug className="mr-1 h-3.5 w-3.5" />Disconnect</Button>
          </div>
          {!relogin && !a.login && <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setRelogin(true)} data-testid="button-change-account">Log in with a different account</button>}
        </div>
      )}
      {a.error && <p role="alert" className="mb-3 text-sm text-destructive" data-testid="error-ad-account">{a.error}</p>}
      {err && <p role="alert" className="mb-3 text-sm text-destructive" data-testid="error-ad-account-action">{err}</p>}
      {a.configured && !a.connected && <Button size="sm" variant="outline" className="mb-3" onClick={() => setConfirmOff(true)}>Disconnect saved session</Button>}
      {a.appConfigured && <AppSetup ws={ws} />}
      {showLogin && <LoginFlow ws={ws} onDone={() => setRelogin(false)} onAbort={() => setRelogin(false)} />}
      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Disconnect this account?</AlertDialogTitle>
            <AlertDialogDescription>All schedules stop{running ? ` (${running} running now)` : ""} and the saved Telegram session is removed from Telecart. App setup stays saved, so reconnecting only needs phone and code or QR. Groups, draft and history stay. Your shop bot is not affected. You can also end the session from Telegram Settings, Devices.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep connected</AlertDialogCancel><AlertDialogAction data-testid="button-confirm-disconnect" onClick={async () => { try { sync(await disconnect.mutateAsync()); toast({ title: "Account disconnected, all schedules stopped" }); } catch (x) { setErr(errMsg(x)); } }}>Stop all and disconnect</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

function LoginFlow({ ws, onDone, onAbort }: { ws: AdvertisingWorkspace; onDone: () => void; onAbort: () => void }) {
  const login = ws.account.login;
  if (login) return <PendingLogin login={login} ws={ws} onDone={onDone} />;
  if (!ws.account.appConfigured) return <AppSetup ws={ws} />;
  return <BeginLogin ws={ws} onAbort={ws.account.connected ? onAbort : undefined} />;
}

function BeginLogin({ ws, onAbort }: { ws: AdvertisingWorkspace; onAbort?: () => void }) {
  const sync = useWorkspaceSync();
  const begin = useBeginAdvertisingAccountLogin(secret);
  const [method, setMethod] = useState<"qr" | "phone">("qr");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState("");
  const running = ws.groups.filter(g => g.running).length;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (begin.isPending) return;
    setErr("");
    if (method === "phone" && !/^\+[1-9]\d{6,14}$/.test(phone.replace(/[\s-]/g, ""))) { setErr("Enter the phone in international format, for example +447700900123."); return; }
    try {
      const r = await begin.mutateAsync({ data: { method, ...(method === "phone" ? { phone: phone.replace(/[\s-]/g, "") } : {}) } });
      setPhone("");
      sync(r);
    } catch (x) { setErr(errMsg(x)); }
    finally { setPhone(""); begin.reset(); }
  }
  return (
    <form onSubmit={submit} autoComplete="off" className="space-y-4" data-testid="form-account-login">
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed">
        Your app setup is saved. Choose phone and code or scan a QR code to connect your personal Telegram account. No need to enter the API ID or hash again.
        {running > 0 && <span className="mt-1 block font-medium text-signal">Logging in again stops all {running} running schedules.</span>}
      </div>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
        {([["qr", "Scan QR code", QrCode], ["phone", "Phone and code", Smartphone]] as const).map(([m, label, Icon]) => (
          <button key={m} type="button" role="tab" aria-selected={method === m} onClick={() => { setMethod(m); setErr(""); }} className={cn("flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium transition-colors", method === m ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")} data-testid={`tab-login-${m}`}><Icon className="h-3.5 w-3.5" />{label}</button>
        ))}
      </div>
      {method === "phone" && <label className="block space-y-1.5 text-sm font-medium">Phone number<Input type="tel" autoComplete="off" value={phone} onChange={e => { setPhone(e.target.value); setErr(""); }} placeholder="+447700900123" className="font-mono" maxLength={20} disabled={begin.isPending} data-testid="input-phone" /><span className="block text-xs font-normal text-muted-foreground">International format with + and country code. Telegram sends a login code to your app.</span></label>}
      {method === "qr" && <p className="text-xs text-muted-foreground">A QR code appears next. Scan it from a phone already logged in: Telegram Settings, Devices, Link Desktop Device.</p>}
      {err && <p role="alert" className="text-sm text-destructive" data-testid="error-account-login">{err}</p>}
      <p className="text-xs text-muted-foreground">Connecting never starts posting. Your API hash and session are stored server side and never shown again.</p>
      <p className="rounded-md border border-signal/30 bg-signal/5 p-3 text-xs leading-relaxed text-muted-foreground">Use a dedicated advertising account. A Telegram session grants full account access; Telecart only uses it to discover joined groups and send posts you confirm. You can revoke access in Telegram Settings, Devices. Never post where advertising is not allowed.</p>
      <div className="flex justify-end gap-2">
        {onAbort && <Button type="button" variant="ghost" onClick={onAbort} data-testid="button-abort-relogin">Keep current account</Button>}
        <Button type="submit" disabled={begin.isPending || (method === "phone" && !phone)} data-testid="button-begin-login">{begin.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : method === "qr" ? <QrCode className="mr-1.5 h-4 w-4" /> : <Smartphone className="mr-1.5 h-4 w-4" />}{method === "qr" ? "Show QR code" : "Send login code"}</Button>
      </div>
    </form>
  );
}

function useCountdown(iso: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
}

function PendingLogin({ login, ws, onDone }: { login: AdvertisingAccountLogin; ws: AdvertisingWorkspace; onDone: () => void }) {
  const sync = useWorkspaceSync();
  const verify = useVerifyAdvertisingAccountLogin(secret);
  const poll = usePollAdvertisingAccountLogin(secret);
  const cancel = useCancelAdvertisingAccountLogin();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [pollStopped, setPollStopped] = useState(false);
  const left = useCountdown(login.expiresAt);
  const expired = login.step === "expired" || left === 0;
  const syncRef = useRef(sync); syncRef.current = sync;
  const pollRef = useRef(poll.mutateAsync); pollRef.current = poll.mutateAsync;
  const resetRef = useRef(poll.reset); resetRef.current = poll.reset;
  const doneRef = useRef(onDone); doneRef.current = onDone;
  const wasConnected = useRef(ws.account.connected && !ws.account.login);

  // QR polling: only while the qr step is pending and not expired; sequential, never overlapping.
  const qrActive = login.step === "qr" && !expired;
  useEffect(() => {
    if (!qrActive) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await pollRef.current({ data: { loginId: login.id } });
        if (!alive) return;
        syncRef.current(r);
        if (r.account.connected && !r.account.login) { doneRef.current(); return; }
        if (!r.account.login || r.account.login.step !== "qr") return;
      } catch (x) {
        if (alive) { setErr(errMsg(x)); setPollStopped(true); }
        return; // Never keep reconnecting after a failed/security-blocked login.
      }
      finally { resetRef.current(); }
      if (alive) timer = setTimeout(tick, 5000);
    };
    timer = setTimeout(tick, 5000);
    return () => { alive = false; clearTimeout(timer); };
  }, [qrActive, login.id]);

  useEffect(() => { if (ws.account.connected && !ws.account.login && !wasConnected.current) doneRef.current(); }, [ws.account.connected, ws.account.login]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (verify.isPending) return;
    setErr("");
    const body = login.step === "code" ? { loginId: login.id, code: code.trim() } : { loginId: login.id, password };
    if (login.step === "code" && !/^\d{3,12}$/.test(code.trim())) { setErr("Enter the numeric code Telegram sent."); return; }
    if (login.step === "password" && !password) { setErr("Enter your two-step verification password."); return; }
    try {
      const r = await verify.mutateAsync({ data: body });
      sync(r);
      if (r.account.connected && !r.account.login) onDone();
    } catch (x) { setErr(errMsg(x)); }
    finally { setCode(""); setPassword(""); verify.reset(); }
  }
  async function doCancel() {
    setErr("");
    try { sync(await cancel.mutateAsync()); } catch (x) { setErr(errMsg(x)); }
  }
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="panel-login-pending">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground" data-testid="text-login-step">{expired ? "Expired" : login.step === "qr" ? "Waiting for scan" : login.step === "code" ? "Enter login code" : "Two-step password"}</span>
        {!expired && <span className="ml-auto font-mono text-[11px] text-muted-foreground" data-testid="text-login-expires">login attempt expires in {mm}</span>}
      </div>
      {expired ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-signal" data-testid="text-login-expired">This login attempt expired. Nothing was connected. Start again with fresh credentials.</p>
          <Button onClick={doCancel} disabled={cancel.isPending} data-testid="button-restart-login">{cancel.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}Start over</Button>
        </div>
      ) : login.step === "qr" ? (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div className="grid h-52 w-52 shrink-0 place-items-center rounded-xl border bg-[#fbfaf6] p-2">
            {login.qrImage ? <img src={login.qrImage} alt="Telegram login QR code" className="h-full w-full object-contain" data-testid="img-login-qr" /> : <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />}
          </div>
          <ol className="list-decimal space-y-1.5 pl-4 text-sm">
            <li>Open Telegram on your phone.</li>
            <li>Go to Settings, Devices, Link Desktop Device.</li>
            <li>Point the camera at this code.</li>
            <li className="text-muted-foreground">If two-step verification is on, you will be asked for the password here.</li>
            <li className="list-none pt-1 font-mono text-[11px] text-muted-foreground" data-testid="text-qr-polling">{pollStopped ? "Automatic checks stopped. Review the error, then cancel this attempt." : poll.isPending ? "Checking..." : "Checking every 5 seconds · QR refreshes when Telegram expires it"}</li>
          </ol>
        </div>
      ) : (
        <form onSubmit={submit} autoComplete="off" className="space-y-3" data-testid="form-login-verify">
          {login.step === "code" ? (
            <label className="block space-y-1.5 text-sm font-medium">Login code<Input type="password" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => { setCode(e.target.value.replace(/\D/g, "")); setErr(""); }} maxLength={12} className="font-mono tracking-[0.3em]" disabled={verify.isPending} data-testid="input-login-code" /><span className="block text-xs font-normal text-muted-foreground">Sent by Telegram to your app (or SMS). Never share it with anyone else.</span></label>
          ) : (
            <label className="block space-y-1.5 text-sm font-medium"><span className="inline-flex items-center gap-1"><KeyRound className="h-3.5 w-3.5" />Two-step verification password</span><Input type="password" autoComplete="current-password" value={password} onChange={e => { setPassword(e.target.value); setErr(""); }} maxLength={256} disabled={verify.isPending} data-testid="input-login-password" /><span className="block text-xs font-normal text-muted-foreground">Your account has an extra cloud password. It is used once and not stored.</span></label>
          )}
          <div className="flex justify-end"><Button type="submit" disabled={verify.isPending} data-testid="button-verify-login">{verify.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{login.step === "code" ? "Verify code" : "Verify password"}</Button></div>
        </form>
      )}
      {err && <p role="alert" className="text-sm text-destructive" data-testid="error-login-verify">{err}</p>}
      {!expired && <div className="flex justify-start border-t pt-3"><Button size="sm" variant="ghost" onClick={doCancel} disabled={cancel.isPending} data-testid="button-cancel-login">{cancel.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1 h-3.5 w-3.5" />}Cancel login</Button></div>}
    </div>
  );
}
