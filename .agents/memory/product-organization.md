---
name: Product organization
description: The user's requirement to identify products by name without a category field.
---

Products should not require or display a category. The user considers the product name sufficient.

**Why:** The user explicitly asked to remove Category from the product form because products already have names.

**How to apply:** Keep category inputs and category-based dashboard organization out of product workflows. Preserve historical data and transfer compatibility rather than deleting stored values merely to remove the field from the interface.

The Telegram product list must show only each product's chosen icon, name, price and stock—not a “Buy now” label or an extra cart icon. Product entries remain tappable to open the purchase flow. Stock-alert messages can retain their separate Buy now button.

**Why:** The user explicitly corrected the added “Buy now” wording in the product list.

**How to apply:** Keep browse-list labels separate from stock-alert action buttons.
