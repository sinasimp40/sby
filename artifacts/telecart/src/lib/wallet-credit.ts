import type { CustomerWalletCreditInput } from "@workspace/api-client-react";

export const MAX_WALLET_CENTS = 2_000_000_000;
/** Parse text exactly; never round a third decimal or accept exponent notation. */
export function walletCreditCents(text: string): number | null {
  const value = text.trim();
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_WALLET_CENTS ? cents : null;
}
export function pendingCreditKey(owner: string, customer: string) {
  return `telecart:pending-wallet-credit:${encodeURIComponent(owner)}:${encodeURIComponent(customer)}`;
}
export function readPendingCredit(key: string): { input: CustomerWalletCreditInput | null; error: string } {
  if (typeof window === "undefined") return { input: null, error: "" };
  try {
    const saved = window.sessionStorage.getItem(key);
    if (!saved) return { input: null, error: "" };
    const value = JSON.parse(saved);
    if (typeof value !== "object" || value === null || typeof value.requestKey !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestKey) ||
      !Number.isSafeInteger(value.amountCents) || value.amountCents < 1 || value.amountCents > MAX_WALLET_CENTS ||
      typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 500) throw new Error();
    return { input: { requestKey: value.requestKey, amountCents: value.amountCents, reason: value.reason }, error: "" };
  } catch {
    return { input: null, error: "The browser could not recover a pending credit reference. Do not add another credit until session storage is available and the previous credit has been checked." };
  }
}
export function creditFailureIsDefinite(error: unknown) {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
  return status >= 400 && status < 500 && status !== 408;
}
