import { format, formatDistanceToNow } from "date-fns";

export const money = (n: number | null | undefined) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n ?? 0);

export const customerName = (name: string) =>
  /^@?(?:Telegram \d+|\d+)$/.test(name.trim()) ? "Telegram customer" : name.trim() || "Telegram customer";

export const shortDate = (s: string) => {
  try {
    return format(new Date(s), "MMM d, yyyy");
  } catch {
    return s;
  }
};

export const dateTime = (s: string) => {
  try {
    return format(new Date(s), "MMM d, yyyy · HH:mm");
  } catch {
    return s;
  }
};

export const ago = (s: string) => {
  try {
    return formatDistanceToNow(new Date(s), { addSuffix: true });
  } catch {
    return s;
  }
};

export const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Try again.";

export const countLines = (s: string) =>
  s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
