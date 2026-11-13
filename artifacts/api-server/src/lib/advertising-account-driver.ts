import { Api, TelegramClient, utils } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import bigInt from "big-integer";
import type { AdvertisingDraft, AdvertisingEmojiSet, AdvertisingSavedMessage, AdvertisingSavedMessagesPage, AdvertisingForwardSnapshot } from "@workspace/api-zod";
import { readSavedMessages, readSavedMessage } from "./advertising-saved-messages";
import { loadAccountEmojiSet, verifyAccountEmoji } from "./advertising-account-emoji";
import { telegramAdEntities } from "./advertising-formatting";
import { validateAdvertisingDraft } from "./advertising-telegram";
import { AccountError, safeAccountError, reportAccountError, type AccountOperation } from "./advertising-account-errors";
import { confirmAccountPost, type AccountPostReceipt } from "./advertising-account-receipt";
import { inspectMembership, joinMembership, leaveMembership, type MembershipProbe } from "./advertising-membership-telegram";
export { AccountError, safeAccountError } from "./advertising-account-errors";
async function bounded<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(), new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new AccountError("Telegram did not confirm the request in time.", "network", 0, "REQUEST_TIMEOUT")), 20000); })]);
  } catch (error) { throw safeAccountError(error); }
  finally { if (timer) clearTimeout(timer); }
}
export function accountMessage(draft: AdvertisingDraft) {
  const clean = validateAdvertisingDraft(draft, true);
  const text = clean.text + (clean.buttonUrl ? `\n\n${clean.buttonText}: ${clean.buttonUrl}` : "");
  if (text.length > (clean.imageUrl ? 1024 : 4096)) throw new AccountError("The complete message, including its shop link, exceeds Telegram's text/caption limit.");
  return { ...clean, text };
}
export interface AccountIdentity { id: string; username: string; displayName: string }
export interface AccountGroup { chatId: string; target: string; title: string }
export interface AccountDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  session(): string;
  me(allowPending?: boolean): Promise<AccountIdentity | null>;
  onFailure?(handler: (error: AccountError) => void): void;
  sendCode(phone: string): Promise<string>;
  code(phone: string, hash: string, code: string): Promise<void>;
  password(password: string): Promise<void>;
  qr(): Promise<{ authorized: boolean; url?: string; expires?: number }>;
  groups(): Promise<AccountGroup[]>;
  inspect(target: string, draft?: AdvertisingDraft): Promise<AccountGroup>;
  membership?(target: string): Promise<MembershipProbe>;
  join?(target: string, expectedChatId: string | null): Promise<MembershipProbe & { outcome: string }>;
  leave?(target: string, expectedChatId: string): Promise<string>;
  emojiSet?(name: string): Promise<AdvertisingEmojiSet>;
  savedMessages?(offsetId: number): Promise<AdvertisingSavedMessagesPage>;
  savedMessage?(id: number): Promise<AdvertisingSavedMessage>;
  forward?(chatId: string, source: AdvertisingForwardSnapshot, randomId: string): Promise<AccountPostReceipt>;
  send(chatId: string, draft: AdvertisingDraft, randomId: string): Promise<AccountPostReceipt>;
  logout(): Promise<void>;
}
export type AccountFactory = (input: { apiId: number; apiHash: string; session?: string; preserveAuthorization?: boolean }) => AccountDriver;
export const createAccountDriver: AccountFactory = ({ apiId, apiHash, session = "", preserveAuthorization = false }) => {
  const store = new StringSession(session);
  let originalKey: Buffer | undefined;
  if (preserveAuthorization && !session)
    throw new AccountError("The saved authorization key is missing. Recovery will not create a new login.", "auth", 0, "AUTH_KEY_INVALID");
  const client = new TelegramClient(store, apiId, apiHash, {
    baseLogger: new Logger(LogLevel.NONE), connectionRetries: 1, requestRetries: 1,
    floodSleepThreshold: 0, autoReconnect: false, retryDelay: 500, timeout: 10,
    deviceModel: "Telecart Advertising", appVersion: "1.0",
  });
  let dialogs: Awaited<ReturnType<typeof client.getDialogs>> | null = null;
  let closed = false;
  let authorized = false;
  let fatal: AccountError | undefined;
  let onFailure: ((error: AccountError) => void) | undefined;
  const available = () => {
    if (fatal) throw fatal;
    if (closed) throw new AccountError("This account connection was closed. No request was sent.", "network", 0, "CONNECTION_CLOSED");
  };
  const run = async <T>(operation: AccountOperation, fn: () => Promise<T>): Promise<T> => {
    available();
    try { return await bounded(fn); }
    catch (error) {
      const raw = safeAccountError(error);
      const safe = reportAccountError(operation, ["auth", "restricted"].includes(raw.kind) ? raw : fatal ?? raw);
      if (["auth", "restricted", "network"].includes(safe.kind)) fatal = safe;
      throw safe;
    }
  };
  const connectionLost = () => {
    if (closed || fatal) return;
    fatal = new AccountError("The Telegram network connection was interrupted. The old client was closed; bounded recovery may reuse the saved authorization. This alone does not mean Telegram logged you out.",
      "network", 0, "CONNECTION_LOST");
    reportAccountError("background", fatal);
    if (onFailure) onFailure(fatal);
    else void client.destroy().catch(() => { reportAccountError("background", new AccountError("Client disposal failed.", "network", 0, "CONNECTION_CLOSED")); });
  };
  // GramJS 2.26 assigns autoReconnect but its MTProtoSender.reconnect() never
  // reads it. Guard each main sender at assignment, before even its first
  // connect, and guard _reconnect too so a previously queued retry cannot run.
  let sender = client._sender;
  Object.defineProperty(client, "_sender", {
    configurable: true,
    get: () => sender,
    set: (next: typeof sender) => {
      sender = next;
      if (!next) return;
      next.reconnect = () => { connectionLost(); };
      next._reconnect = async () => { connectionLost(); };
      const connectSender = next.connect.bind(next);
      next.connect = async (...args) => {
        available();
        if (preserveAuthorization && (!originalKey || !originalKey.equals(next.authKey.getKey() ?? Buffer.alloc(0))))
          throw new AccountError("Recovery cannot replace or generate an authorization key.", "auth", 0, "AUTH_KEY_INVALID");
        const result = await connectSender(...args);
        if (preserveAuthorization && (!originalKey || !originalKey.equals(next.authKey.getKey() ?? Buffer.alloc(0))))
          throw new AccountError("The authorization key changed during recovery.", "auth", 0, "AUTH_KEY_INVALID");
        if (closed || fatal) { await next.disconnect(); available(); }
        return result;
      };
    },
  });
  // Also gate SDK-internal RPCs/migrations: a timed-out asynchronous operation
  // must not reconnect or send its next request after the owner closed it.
  const invoke = client.invoke.bind(client);
  client.invoke = ((...args: Parameters<TelegramClient["invoke"]>) => {
    available();
    return invoke(...args);
  }) as TelegramClient["invoke"];
  const connect = client.connect.bind(client);
  client.connect = async () => {
    available();
    if (preserveAuthorization && !originalKey) {
      // StringSession's constructor only decodes _key. Public authKey is
      // populated asynchronously by load(), even for a valid saved session.
      await store.load();
      available();
      const key = store.authKey?.getKey();
      if (!key?.length) throw new AccountError("The saved authorization key is missing. Recovery will not create a new login.",
        "auth", 0, "AUTH_KEY_INVALID");
      originalKey = Buffer.from(key);
    }
    const result = await connect();
    if (closed || fatal) { await client.destroy(); available(); }
    return result;
  };
  const switchDC = client._switchDC.bind(client);
  client._switchDC = async dc => {
    available();
    if (preserveAuthorization && dc !== store.dcId)
      throw new AccountError("Recovery will not migrate or replace this authorization. Review the account connection.", "auth", 0, "AUTH_KEY_INVALID");
    return switchDC(dc);
  };
  client.onError = async error => {
    if (closed || fatal) return;
    if (!authorized && !preserveAuthorization && (error as { errorMessage?: string }).errorMessage === "AUTH_KEY_UNREGISTERED") return;
    const safe = reportAccountError("background", error);
    if (["auth", "restricted", "network"].includes(safe.kind)) { fatal = safe; onFailure?.(safe); }
  };
  let qrAccepted = false;
  let cachedQr: { authorized: false; url: string; expires: number } | undefined;
  client.addEventHandler(update => {
    if (update instanceof Api.UpdateLoginToken) qrAccepted = true;
  });
  const resolvedGroups = new Map<string, Api.Chat | Api.Channel>();
  const joined = async () => {
    // GramJS 2.26's ignoreMigrated filter drops channels/supergroups as well.
    // Fetch normally and exclude only obsolete or left chats ourselves.
    available();
    if (!dialogs) dialogs = await client.getDialogs({ limit: 1000, ignoreMigrated: false });
    return dialogs.filter(d => {
      const entity = d.entity;
      if (entity instanceof Api.Chat) return !entity.left && !entity.deactivated && !entity.migratedTo;
      return entity instanceof Api.Channel && !entity.left;
    });
  };
  const inspect = async (target: string, draft?: AdvertisingDraft) => run("inspect_group", async () => {
    let entity = resolvedGroups.get(target);
    if (entity) {
      const refreshed = await client.getEntity(entity);
      if (!(refreshed instanceof Api.Chat || refreshed instanceof Api.Channel)) throw new AccountError("The saved destination is no longer a group or channel.");
      entity = refreshed;
    }
    if (!entity && target.startsWith("@")) {
      // Public username resolution plus GetParticipant is authoritative. The
      // first 1,000 dialogs can omit an older joined group; absence isn't proof.
      const candidate = await client.getEntity(target);
      if (candidate instanceof Api.Chat || candidate instanceof Api.Channel) entity = candidate;
    }
    if (!entity && !target.startsWith("@")) {
      const dialog = (await joined()).find(d => d.id?.toString() === target);
      if (dialog?.entity instanceof Api.Chat || dialog?.entity instanceof Api.Channel) entity = dialog.entity;
    }
    if (!entity) throw new AccountError("Could not resolve this group for the connected Telegram account. Check the account shown in Advertising, or use the group's public @username.");
    if (entity.left || (entity instanceof Api.Chat && entity.deactivated)) throw new AccountError("This account is no longer a member of this group.", "permission", 0, "USER_NOT_PARTICIPANT");
    let admin = entity.creator || Boolean(entity.adminRights);
    let personalBan: Api.ChatBannedRights | undefined;
    if (entity instanceof Api.Channel) {
      const result = await client.invoke(new Api.channels.GetParticipant({ channel: entity, participant: new Api.InputPeerSelf() }));
      const p = result.participant;
      admin = p instanceof Api.ChannelParticipantCreator || p instanceof Api.ChannelParticipantAdmin;
      if (p instanceof Api.ChannelParticipantLeft || (p instanceof Api.ChannelParticipantBanned && p.left))
        throw new AccountError("The account is not a member of this group.", "permission", 0, "USER_NOT_PARTICIPANT");
      if (p instanceof Api.ChannelParticipantBanned) personalBan = p.bannedRights;
      if (entity.broadcast && !(entity.creator || entity.adminRights?.postMessages)) throw new AccountError("This account cannot post in this channel.", "permission", 0, "CHAT_ADMIN_REQUIRED");
    } else {
      const full = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
      const me = await client.getMe();
      if (!(full.fullChat instanceof Api.ChatFull)) throw new AccountError("Could not verify group membership.");
      const participants = full.fullChat.participants;
      if (!(participants instanceof Api.ChatParticipants) || !participants.participants.some(p => p.userId.equals(me.id)))
        throw new AccountError("Could not verify that the connected Telegram account is a member of this group.");
    }
    const restrictions = [personalBan, ...(admin ? [] : [entity.defaultBannedRights])];
    const kind = draft?.forward?.source.mediaKind;
    const media = draft?.imageUrl || (kind && kind !== "text");
    if (restrictions.some(r => r?.sendMessages || r?.sendPlain || (media && r?.sendMedia) ||
      (draft?.imageUrl && (r?.sendPhotos || r?.sendGifs)) || (kind === "photo" && r?.sendPhotos) ||
      (kind === "animation" && r?.sendGifs) || (kind === "video" && r?.sendVideos) ||
      (kind === "document" && r?.sendDocs) || (kind === "audio" && r?.sendAudios) ||
      (kind === "voice" && r?.sendVoices) || (kind === "sticker" && r?.sendStickers)))
      throw new AccountError("This account lacks permission to send this message/media in the group.", "permission", 0, "CHAT_WRITE_FORBIDDEN");
    const chatId = utils.getPeerId(entity).toString();
    resolvedGroups.set(chatId, entity);
    resolvedGroups.set(target, entity);
    return { chatId, target: chatId, title: utils.getDisplayName(entity) || target };
  });
  return {
    connect: () => run("connect", async () => {
      await client.connect();
      if (closed || fatal) { await client.destroy(); available(); }
    }),
    disconnect: async () => { closed = true; await client.destroy(); },
    onFailure: handler => { onFailure = handler; },
    session: () => store.save(),
    me: (allowPending = false) => run("identity", async () => {
      // Only explicitly pending login keys may mean "not signed in".
      // Saved authorizations must preserve AUTH_KEY_UNREGISTERED as a failure.
      let user;
      try { user = await client.getMe(); }
      catch (error) {
        if (allowPending && (error as { errorMessage?: string })?.errorMessage === "AUTH_KEY_UNREGISTERED") return null;
        throw error;
      }
      if (!(user instanceof Api.User) || user.bot) throw new AccountError("Sign in with a personal Telegram account, not a bot.");
      authorized = true;
      return { id: user.id.toString(), username: user.username ?? "", displayName: [user.firstName, user.lastName].filter(Boolean).join(" ").slice(0, 200) };
    }),
    sendCode: phone => run("send_code", async () => {
      // GramJS counts a Telegram data-centre redirect as an attempt. A single
      // attempt switches DC but never submits SendCode on the destination.
      // Scope extra attempts to login: unconfirmed advertising sends must not retry.
      const attempts = client._requestRetries;
      client._requestRetries = 3;
      try { return (await client.sendCode({ apiId, apiHash }, phone)).phoneCodeHash; }
      finally { client._requestRetries = attempts; }
    }),
    code: (phone, hash, code) => run("verify_code", async () => {
      const result = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: hash, phoneCode: code }));
      if (!(result instanceof Api.auth.Authorization)) throw new AccountError("Use an existing Telegram account. This dashboard does not create Telegram accounts.");
    }),
    password: password => run("verify_password", async () => { await client.signInWithPassword({ apiId, apiHash }, { password: async () => password, onError: error => { throw error; } }); }),
    qr: () => run("qr_login", async () => {
      if (cachedQr && !qrAccepted && cachedQr.expires * 1000 > Date.now()) return cachedQr;
      qrAccepted = false;
      cachedQr = undefined;
      // Like phone login, QR login may redirect to another data centre.
      // Scope retries to authentication, never to advertising sends.
      const attempts = client._requestRetries;
      client._requestRetries = 3;
      try {
        let result = await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }));
        if (result instanceof Api.auth.LoginTokenMigrateTo) {
          await client._switchDC(result.dcId);
          result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
        }
        if (result instanceof Api.auth.LoginTokenSuccess) return { authorized: true };
        if (result instanceof Api.auth.LoginToken && result.expires * 1000 > Date.now()) {
          cachedQr = { authorized: false, url: `tg://login?token=${result.token.toString("base64url")}`, expires: result.expires };
          return cachedQr;
        }
        throw new AccountError("Telegram returned an expired or unsupported QR challenge. Cancel this attempt before trying again.", "expired");
      } finally {
        client._requestRetries = attempts;
      }
    }),
    groups: () => run("groups", async () => {
      // Do not retain an old dialog snapshot indefinitely on the persistent client.
      dialogs = null;
      return (await joined()).map(d => ({ chatId: d.id!.toString(), target: d.id!.toString(), title: d.title ?? d.id!.toString() }));
    }),
    inspect,
    membership: target => run("membership", () => inspectMembership(client, target)),
    join: (target, expected) => run("join_group", async () => {
      const result = await joinMembership(client, target, expected);
      dialogs = null; resolvedGroups.clear(); return result;
    }),
    leave: (target, expected) => run("leave_group", async () => {
      const result = await leaveMembership(client, target, expected);
      dialogs = null; resolvedGroups.clear(); return result;
    }),
    emojiSet: name => run("emoji_set", () => loadAccountEmojiSet(client, name)),
    savedMessages: offsetId => run("saved_messages", () => readSavedMessages(client, offsetId)),
    savedMessage: id => run("saved_messages", () => readSavedMessage(client, id)),
    forward: (chatId, snapshot, randomId) => run("send", async () => {
      const source = await readSavedMessage(client, snapshot.source.id);
      available();
      if (source.accountId !== snapshot.source.accountId || source.fingerprint !== snapshot.source.fingerprint)
        throw new AccountError("The selected saved message changed. Advertising stopped; refresh and select it again.", "validation", 0, "SAVED_MESSAGE_CHANGED");
      await inspect(chatId, { text: source.text, imageUrl: null, buttonText: "", buttonUrl: null, forward: snapshot });
      available();
      const entity = resolvedGroups.get(chatId)!;
      const id = bigInt(randomId);
      const result = await client.invoke(new Api.messages.ForwardMessages({
        fromPeer: new Api.InputPeerSelf(), id: [source.id], randomId: [id], toPeer: utils.getInputPeer(entity),
      }));
      available();
      const receipt = await confirmAccountPost(client, entity, id, result);
      available();
      return receipt;
    }),
    send: (chatId, draft, randomId) => run("send", async () => {
      await inspect(chatId, draft);
      available(); // A timed-out/disposed preflight must never dispatch a late post.
      const entity = resolvedGroups.get(chatId)!;
      const message = accountMessage(draft);
      await verifyAccountEmoji(client, message.text, message.entities ?? []);
      available();
      const common = { peer: utils.getInputPeer(entity), message: message.text, randomId: bigInt(randomId),
        ...(message.entities?.length ? { entities: telegramAdEntities(message.entities) } : {}) };
      let result: Api.TypeUpdates;
      if (message.imageUrl) {
        const gif = new URL(message.imageUrl).pathname.toLowerCase().endsWith(".gif");
        const media = gif ? new Api.InputMediaDocumentExternal({ url: message.imageUrl }) : new Api.InputMediaPhotoExternal({ url: message.imageUrl });
        result = await client.invoke(new Api.messages.SendMedia({ ...common, media }));
      } else result = await client.invoke(new Api.messages.SendMessage({ ...common, noWebpage: true }));
      available();
      const receipt = await confirmAccountPost(client, entity, common.randomId, result);
      available();
      return receipt;
    }),
    logout: () => run("logout", async () => { await client.invoke(new Api.auth.LogOut()); }),
  };
};
