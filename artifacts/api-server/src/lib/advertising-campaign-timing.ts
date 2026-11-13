import type { AdvertisingClient } from "./advertising-store";

// A confirmed Start resets only the merchant's interval. Telegram flood/slow
// mode waits and outstanding ambiguous-send safeguards are not merchant timers.
export async function resetCampaignInterval(owner: string, client: AdvertisingClient) {
  await client.query(`UPDATE advertising_accounts SET next_send_at=GREATEST(now(),telegram_wait_until,
    CASE WHEN (SELECT status FROM advertising_account_runs WHERE owner_id=$1
      ORDER BY started_at DESC,id DESC LIMIT 1) IN ('sending','uncertain')
    THEN next_send_at ELSE now() END) WHERE owner_id=$1`, [owner]);
}
