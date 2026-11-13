---
name: Telegram button icon eligibility
description: Custom emojis in buttons and welcome/support text, bot-owner eligibility and normal fallbacks.
---

The user initially replaced animated coin icons with static symbols, concerned about Premium restrictions. They later explicitly approved per-coin normal/custom emoji selection in the Payments dashboard.

**Why:** Ordinary buyers must be able to choose a deposit coin without Premium-dependent behavior. Customers do not need Premium to pay. Telegram restricts custom button icons, including static custom emoji, by the bot owner's Premium subscription or additional bot usernames purchased on Fragment.

**How to apply:** Default to standard coin symbols, but allow the user to select a normal or imported custom emoji per accepted coin. Always retain full coin/network names and unchanged payment callbacks. Retry with normal icons only after a definite Telegram custom-icon rejection, never after an uncertain send. Telegram does not provide an ordinary PNG/image field inside inline buttons. Official reference: https://core.telegram.org/bots/api#inlinekeyboardbutton

The user explicitly requested custom Telegram emojis for individual product buttons and later for accepted-coin buttons, using the shared emoji library with pack imports and private bot-import links.

**Why:** They want to choose their own product icons in the dashboard, not be restricted to ordinary emoji presets.

**How to apply:** Keep eligibility explanations tied to the bot owner, preserve the normal product emoji as fallback, and distinguish custom emoji packs from ordinary sticker packs. Emoji capture must be explicitly authorized by the dashboard, not collected from ordinary customers. Temporary import authorization must not travel with portable business data.

The normal fallback emoji is optional and must be deselectable. Dashboard product rows, button previews and Telegram product-name headings should reflect the selected custom or normal icon, not a hardcoded shopping bag.

**Why:** The user confirmed custom emojis work in Telegram but reported that the dashboard did not reflect them, could not unclick the normal emoji, and later pointed out the wrong icon beside the product name in the purchase caption.

**How to apply:** An explicitly cleared normal fallback means no normal icon, including when Telegram cannot use the custom icon. Do not silently restore a generic shopping-bag emoji for that state.

The user explicitly requested custom emojis inside both welcome and support messages, not only on menu buttons.

**Why:** They chose “Welcome and support messages” when asked which message fields should support custom emojis.

**How to apply:** Reuse the imported library for message-body insertion and distinguish inline message emojis from button icons. Preserve ordinary message text rather than interpreting it as merchant-supplied HTML.
