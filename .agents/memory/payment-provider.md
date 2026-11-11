---
name: Payment provider requirement
description: The user's explicit NOWPayments requirement and handling of unresolved Telegram payment restrictions.
---

The user requires automatic payment-status and amount detection, with the existing Telegram invoice text edited when it changes, rather than requiring a Check payment button.

**Why:** The user explicitly asked to remove manual checks and improve the Telegram payment presentation.

**How to apply:** New invoices should not depend on callback-button processing for settlement. Preserve message references for automatic caption updates and never fabricate provider states to demonstrate a transition.

The user requires NOWPayments, not Telegram Stars. Their requested payment flow sends an embedded QR code and payment information when a customer purchases or deposits into their wallet.

**Why:** The user repeated and corrected this requirement after Stars was suggested.

**How to apply:** Keep NOWPayments as the requested provider. Do not treat advice about Telegram's digital-goods rules as consent to substitute a payment provider. Clearly distinguish saved configuration and previews from actual connected payment processing. Resolve any platform-rule conflict explicitly before activation.

The user chose to wait for NOWPayments API status `finished` before delivering exactly one stock line or crediting a wallet.

**Why:** After the risk of early delivery was explained, the user explicitly selected “Wait for finished status.”

**How to apply:** Never fulfill at `confirming`, `confirmed`, or `sending`. Verify payment identity, amount, and currency server-side, and prevent repeated notifications from consuming or delivering additional stock.

The user asked to remove the app-imposed payment minimum, rather than treating $0.10 as a NOWPayments requirement.

**Why:** The user wants small deposits and product payments where the selected provider route supports them.

**How to apply:** Do not reintroduce an arbitrary app floor. Keep positive USD-cent precision, optional merchant limits, and live provider minimum checks distinct. Do not automatically switch rate mode to make quotes cheaper.
