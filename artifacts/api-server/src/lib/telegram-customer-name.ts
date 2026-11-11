export interface TelegramCustomerProfile {
  username?: string;
  first_name?: string;
  last_name?: string;
}

export function telegramCustomerName(profile: TelegramCustomerProfile) {
  const username = profile.username?.trim().replace(/^@+/, "");
  if (username) return `@${username}`;
  return [profile.first_name?.trim(), profile.last_name?.trim()].filter(Boolean).join(" ") || "Telegram customer";
}
