import { providerMinimumCents } from "./commerce-providers";
import type { PaymentMinimum } from "@workspace/api-zod";

const coins = ["LTC", "BTC", "USDTERC20", "USDTTRC20", "BNBBSC", "SOL"];
let cache: PaymentMinimum[] | null = null;
let checked = 0;
let inflight: Promise<PaymentMinimum[]> | null = null;
export async function paymentMinimums() {
  if (cache && Date.now() - checked < 60000) return cache;
  if (inflight) return inflight;
  inflight = Promise.all(coins.map(async coin => {
    const read = async (mode: "fixed" | "floating") => {
      try { return (await providerMinimumCents(coin.toLowerCase(), mode)) / 100; }
      catch { return null; }
    };
    const [fixedUSD, floatingUSD] = await Promise.all([read("fixed"), read("floating")]);
    return { coin, fixedUSD, floatingUSD, checkedAt: new Date().toISOString() };
  }));
  try { cache = await inflight; checked = Date.now(); return cache; }
  finally { inflight = null; }
}
