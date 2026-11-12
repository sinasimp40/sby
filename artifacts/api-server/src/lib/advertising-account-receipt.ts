import { Api, TelegramClient, utils } from "telegram";
import type bigInt from "big-integer";
import { AccountError } from "./advertising-account-errors";

export interface AccountPostReceipt { chatId: string; messageId: number }

function unconfirmed(): never {
  throw new AccountError(
    "The post could not be verified in the selected group. It may have been posted or removed. Advertising stopped; check the group before restarting. No automatic retry.",
    "network", 0, "POST_NOT_CONFIRMED",
  );
}

/** A completed RPC alone is not a receipt. Match its random ID, then read back
 * that exact message from the requested peer. Never resend to obtain evidence.
 */
export async function confirmAccountPost(
  client: Pick<TelegramClient, "invoke">,
  entity: Api.Chat | Api.Channel,
  randomId: bigInt.BigInteger,
  result: Api.TypeUpdates,
): Promise<AccountPostReceipt> {
  let messageId: number | undefined;
  if (result instanceof Api.UpdateShortSentMessage) messageId = result.id;
  else {
    const updates = result instanceof Api.Updates || result instanceof Api.UpdatesCombined ? result.updates
      : result instanceof Api.UpdateShort ? [result.update] : [];
    const ids = updates.filter((update): update is Api.UpdateMessageID =>
      update instanceof Api.UpdateMessageID && update.randomId?.equals(randomId) === true).map(update => update.id);
    if (new Set(ids).size !== 1) unconfirmed();
    messageId = ids[0];
  }
  if (!Number.isSafeInteger(messageId) || messageId! <= 0) unconfirmed();
  const chatId = utils.getPeerId(entity).toString();
  const id = [new Api.InputMessageID({ id: messageId! })];
  const messages = entity instanceof Api.Channel
    ? await client.invoke(new Api.channels.GetMessages({ channel: entity, id }))
    : await client.invoke(new Api.messages.GetMessages({ id }));
  if (!messages || !("messages" in messages) || !Array.isArray(messages.messages) || !messages.messages.some(message =>
    message instanceof Api.Message && message.id === messageId && utils.getPeerId(message.peerId).toString() === chatId))
    unconfirmed();
  return { chatId, messageId: messageId! };
}
