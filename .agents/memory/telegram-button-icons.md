---
name: Telegram button icon eligibility
description: Static deposit symbols versus explicitly requested custom product emojis.
---

The user replaced the animated-coin requirement with static coin logos, concerned about Premium restrictions.

**Why:** Ordinary buyers must be able to choose a deposit coin without Premium-dependent behavior. Customers do not need Premium to pay. Telegram restricts custom button icons, including static custom emoji, by the bot owner's Premium subscription or additional bot usernames purchased on Fragment.

**How to apply:** Use standard Unicode coin symbols and full coin names; do not reintroduce custom emoji unless asked. Telegram does not provide an ordinary PNG/image field inside inline buttons, so distinguish static symbols from actual logo images. Official reference: https://core.telegram.org/bots/api#inlinekeyboardbutton

The user later explicitly requested custom Telegram emojis for individual product buttons, supporting both emoji-pack imports and sending emojis through a private bot-import link. This does not replace the static deposit-coin requirement.

**Why:** They want to choose their own product icons in the dashboard, not be restricted to ordinary emoji presets.

**How to apply:** Keep eligibility explanations tied to the bot owner, preserve the normal product emoji as fallback, and distinguish custom emoji packs from ordinary sticker packs. Emoji capture must be explicitly authorized by the dashboard, not collected from ordinary customers. Temporary import authorization must not travel with portable business data.

The normal fallback emoji is optional and must be deselectable. Dashboard product rows, button previews and Telegram product-name headings should reflect the selected custom or normal icon, not a hardcoded shopping bag.

**Why:** The user confirmed custom emojis work in Telegram but reported that the dashboard did not reflect them, could not unclick the normal emoji, and later pointed out the wrong icon beside the product name in the purchase caption.

**How to apply:** An explicitly cleared normal fallback means no normal icon, including when Telegram cannot use the custom icon. Do not silently restore a generic shopping-bag emoji for that state.
