import type { AdvertisingAccountRun } from "@workspace/api-client-react";

export function postingDayRange(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const [year, month, day] = date.split("-").map(Number);
  const from = new Date(year!, month! - 1, day);
  if (from.getFullYear() !== year || from.getMonth() !== month! - 1 || from.getDate() !== day) return undefined;
  // Construct the next local midnight, not +24h: DST days can be 23 or 25h.
  const to = new Date(year!, month! - 1, day! + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function appendPostingPage(current: AdvertisingAccountRun[], incoming: AdvertisingAccountRun[]) {
  const seen = new Set(current.map(r => r.id));
  return [...current, ...incoming.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id); return true;
  })];
}

export function postingHeadChanged(current: AdvertisingAccountRun[], incoming: AdvertisingAccountRun[]) {
  return (!incoming.length && !!current.length) || incoming.some((r, i) => r.id !== current[i]?.id);
}

export function refreshLoadedPosts(current: AdvertisingAccountRun[], head: AdvertisingAccountRun[], cutoff: number) {
  const latest = new Map(head.map(r => [r.id, r]));
  return current.map(r => latest.get(r.id) ?? r).filter(r => Date.parse(r.sentAt ?? r.startedAt) >= cutoff);
}
