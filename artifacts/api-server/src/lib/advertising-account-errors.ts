import { CommerceError } from "./commerce-providers";
import { logger } from "./logger";

const codes = new Set([
  "PEER_FLOOD", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN", "USER_RESTRICTED",
  "SESSION_PASSWORD_NEEDED", "PASSWORD_HASH_INVALID", "PHONE_CODE_INVALID", "PHONE_CODE_EMPTY",
  "PHONE_CODE_EXPIRED", "AUTH_TOKEN_EXPIRED", "AUTH_TOKEN_INVALID", "API_ID_INVALID",
  "API_ID_PUBLISHED_FLOOD", "PHONE_NUMBER_INVALID", "USER_NOT_PARTICIPANT",
  "AUTH_KEY_UNREGISTERED", "AUTH_KEY_DUPLICATED", "AUTH_KEY_INVALID", "AUTH_KEY_PERM_EMPTY",
  "SESSION_REVOKED", "SESSION_EXPIRED", "CHAT_WRITE_FORBIDDEN", "USER_BANNED_IN_CHANNEL",
  "CHAT_ADMIN_REQUIRED", "CHANNEL_PRIVATE", "CHAT_SEND_PLAIN_FORBIDDEN", "CHAT_SEND_MEDIA_FORBIDDEN",
  "CONNECTION_LEASE_LOST", "CONNECTION_CLOSED", "CONNECTION_LOST", "ACCOUNT_IDENTITY_UNVERIFIED", "REQUEST_TIMEOUT", "POST_NOT_CONFIRMED",
  "NETWORK_RECOVERY_EXHAUSTED", "TRANSPORT_UNAVAILABLE",
]);
export function diagnosticCode(value: unknown): string {
  if (typeof value !== "string") return "UNKNOWN";
  if (codes.has(value)) return value;
  if (/^(FLOOD_WAIT|FLOOD_TEST_PHONE_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT)(_\d+)?$/.test(value)) return value.split(/_\d/)[0]!;
  return "UNKNOWN"; // Never copy arbitrary RPC text, exceptions, payloads or stacks.
}
export class AccountError extends CommerceError {
  constructor(message: string, public kind = "validation", public waitSeconds = 0, public telegramCode = "UNKNOWN") {
    super(message, kind === "network" ? 502 : 400);
    this.telegramCode = diagnosticCode(telegramCode);
  }
}
export function safeAccountError(error: unknown): AccountError {
  if (error instanceof AccountError) return error;
  const e = error as { errorMessage?: string; seconds?: number; code?: string } | null;
  const code = typeof e?.errorMessage === "string" ? e.errorMessage : "";
  const make = (message: string, kind = "validation", wait = 0) => new AccountError(message, kind, wait, diagnosticCode(code));
  if (!code && ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EPIPE"].includes(e?.code ?? ""))
    return new AccountError("The Telegram network connection was interrupted.", "network", 0, "TRANSPORT_UNAVAILABLE");
  if (/^(FLOOD|SLOWMODE)/.test(code)) return make("Telegram requested a waiting period. Posting will wait; do not try to bypass this limit.", "rate_limit", Math.max(1, Math.ceil(Number(e?.seconds) || 60)));
  if (["PEER_FLOOD", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN", "USER_RESTRICTED"].includes(code))
    return make("Telegram restricted or disabled this account. Advertising has stopped. Review the notice in Telegram; do not repeatedly log in or try to bypass the restriction.", "restricted");
  if (code === "SESSION_PASSWORD_NEEDED") return make("Enter your Telegram two-step verification password.", "password");
  if (code === "PASSWORD_HASH_INVALID") return make("The two-step verification password was not accepted.");
  if (["PHONE_CODE_INVALID", "PHONE_CODE_EMPTY"].includes(code)) return make("The login code was not accepted. Check the code and try again.");
  if (["PHONE_CODE_EXPIRED", "AUTH_TOKEN_EXPIRED", "AUTH_TOKEN_INVALID"].includes(code)) return make("This sign-in challenge expired. Cancel it and start again.", "expired");
  if (["API_ID_INVALID", "API_ID_PUBLISHED_FLOOD"].includes(code)) return make("Telegram rejected these API app credentials. Check your API ID and API hash.");
  if (code === "PHONE_NUMBER_INVALID") return make("Use your phone number in international +country-code format.");
  if (code === "USER_NOT_PARTICIPANT") return make("The Telegram account connected in Advertising is not a member of this group. Check that it is the same account you used to join.");
  if (["AUTH_KEY_UNREGISTERED", "AUTH_KEY_DUPLICATED", "AUTH_KEY_INVALID", "AUTH_KEY_PERM_EMPTY", "SESSION_REVOKED", "SESSION_EXPIRED"].includes(code))
    return make("Telegram invalidated or revoked this session. Advertising has stopped. Review Telegram Settings → Devices and any security notice before starting another login. Never run the same session on multiple servers.", "auth");
  if (["CHAT_WRITE_FORBIDDEN", "USER_BANNED_IN_CHANNEL", "CHAT_ADMIN_REQUIRED", "CHANNEL_PRIVATE", "CHAT_SEND_PLAIN_FORBIDDEN", "CHAT_SEND_MEDIA_FORBIDDEN"].includes(code))
    return make("This account is not allowed to post this message in the selected group.");
  if (code) return make("Telegram rejected the request. Check account access, group permissions and the message.");
  return make("Telegram did not confirm the request. Check the connection before continuing.", "network");
}
export type AccountOperation = "connect" | "identity" | "send_code" | "verify_code" | "verify_password" | "qr_login" |
  "groups" | "inspect_group" | "send" | "logout" | "account_operation" | "discover_groups" | "check_groups" |
  "check_account" | "post_ad" | "begin_login" | "verify_login" | "qr_poll" | "lease_lost" | "background" | "recover_connection";
export const isTransportFailure = (error: AccountError) => error.kind === "network" &&
  ["CONNECTION_LOST", "REQUEST_TIMEOUT", "TRANSPORT_UNAVAILABLE"].includes(error.telegramCode);
export function reportAccountError(operation: AccountOperation, error: unknown): AccountError {
  const safe = safeAccountError(error);
  logger.warn({ event: "advertising_account_failure", operation, telegramCode: diagnosticCode(safe.telegramCode), kind: safe.kind },
    "Telegram account operation failed; credentials and RPC payloads were not logged.");
  return safe;
}
export const sessionStopped = (error: AccountError) => error.message.startsWith("Account connection stopped [")
  ? error.message : `Account connection stopped [${diagnosticCode(error.telegramCode)}]. ${error.message}`;
export function stoppedAccountError(message: string) {
  const code = diagnosticCode(/^Account connection stopped \[([A-Z_]+)\]/.exec(message)?.[1]);
  return new AccountError(message, code.startsWith("CONNECTION_") ||
    ["REQUEST_TIMEOUT", "TRANSPORT_UNAVAILABLE", "NETWORK_RECOVERY_EXHAUSTED", "POST_NOT_CONFIRMED"].includes(code) ? "network" : "auth", 0, code);
}
export const isSessionStopped = (message: unknown) => typeof message === "string" && (
  message.startsWith("Account connection stopped [") ||
  // Honor revocations recorded before structured diagnostic codes existed.
  ["Reconnect the account before discovering groups.", "Reconnect the Telegram account before checking groups.",
    "Account session is no longer valid.", "Telegram invalidated or revoked this session.",
    "Telegram restricted or disabled this account."].some(prefix => message.startsWith(prefix)));
