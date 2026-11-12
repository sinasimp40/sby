import { TelegramRequestError } from "./commerce-providers";

export async function withCustomEmojiFallback<T>(sendCustom: () => Promise<T>, sendNormal: () => Promise<T>): Promise<T> {
  try { return await sendCustom(); }
  catch (error) {
    // Only a definite custom-icon rejection proves no message was sent/edited.
    // Never resend after a timeout, unknown error, or ambiguous Telegram response.
    if (!(error instanceof TelegramRequestError && error.providerStatus === 400 &&
      error.reason === "custom_emoji_unavailable")) throw error;
    return await sendNormal();
  }
}
