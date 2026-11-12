---
name: Product options
description: User-selected grouped buying flow and the stock-preservation rule for adding options.
---

The user chose one product with selectable options, rather than separate top-level products, for examples such as Replit plans with different names, prices, descriptions and stock.

**Why:** The user wants buyers to choose the product first, then its plan, and then type the quantity manually. Descriptions explain the plans; they do not determine prices or inventory.

**How to apply:** Keep one entry per grouped product in Telegram. Give each option its own price, description and inventory. Preserve ordinary single-product buying and the user's no-category requirement.

Grouping an existing product must preserve the original product identity and its stock as the first option, not move or regenerate its inventory.

**Why:** Credentials are encrypted for their owner and product identity, and historical purchases refer to that identity. Recreating the item or moving encrypted rows could break delivery and past orders.

**How to apply:** Preserve existing option IDs when editing or grouping. Archive unwanted saved options instead of silently dropping them from a bulk edit. Do not delete a group with order history or reserved/delivered stock.
