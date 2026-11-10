---
name: Payment provider requirement
description: The user's explicit NOWPayments requirement and handling of unresolved Telegram payment restrictions.
---

The user requires NOWPayments, not Telegram Stars. Their requested payment flow sends an embedded QR code and payment information when a customer purchases or deposits into their wallet.

**Why:** The user repeated and corrected this requirement after Stars was suggested.

**How to apply:** Keep NOWPayments as the requested provider. Do not treat advice about Telegram's digital-goods rules as consent to substitute a payment provider. Clearly distinguish saved configuration and previews from actual connected payment processing. Resolve any platform-rule conflict explicitly before activation.

The user chose to wait for NOWPayments API status `finished` before delivering exactly one stock line or crediting a wallet.

**Why:** After the risk of early delivery was explained, the user explicitly selected “Wait for finished status.”

**How to apply:** Never fulfill at `confirming`, `confirmed`, or `sending`. Verify payment identity, amount, and currency server-side, and prevent repeated notifications from consuming or delivering additional stock.
