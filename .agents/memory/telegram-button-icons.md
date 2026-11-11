---
name: Animated Telegram coin-button icons
description: Telegram eligibility restrictions and how to identify crypto custom emoji correctly.
---

The shop wants animated, matching crypto logos on Telegram's deposit coin buttons. Telegram restricts custom button icons to eligible bots: a bot owner's Telegram Premium subscription or an additional bot username purchased on Fragment. Owner eligibility has not been confirmed.

**Why:** The user explicitly requested animated coin logos. Telegram's official InlineKeyboardButton documentation lists these restrictions; correct IDs alone do not guarantee that every bot or client displays animation.

**How to apply:** Preserve usable payment buttons when Telegram rejects custom emojis, and explain the eligibility requirement rather than promising animation unconditionally. Do not assume the bot owner's Premium status from a customer's status.

Public crypto custom-emoji metadata may identify every sticker with the same ordinary emoji (the inspected pack used 🤑 for many different logos).

**Why:** Public pack lookup did not distinguish BTC, ETH, LTC and SOL by the ordinary emoji field; the actual sticker previews did.

**How to apply:** When adding another coin, verify that its custom emoji is animated and visually check its logo. Do not map coins by the ordinary emoji field or guess custom emoji IDs.
