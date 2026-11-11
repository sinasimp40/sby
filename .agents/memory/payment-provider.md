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

The user requires floating-rate NOWPayments wallet deposits of $5 or higher, and wallet balance as the only way to buy products.

**Why:** After a real $0.10 LTC floating invoice succeeded, the user explicitly chose a $5 minimum top-up and wallet-only product purchases.

**How to apply:** Keep deposit limits separate from product prices: cheap products can use an existing wallet balance without a crypto invoice. Enforce wallet-only purchases server-side, including stale Telegram crypto buttons. Preserve reconciliation for older direct-payment invoices. Some coin/network provider minimums exceed $5; do not promise every coin accepts $5.

Use SOL instead of USDT-TRC20 for this shop's accepted deposit coins.

**Why:** The user explicitly asked to replace TRC20 after its $5 invoice was rejected.

**How to apply:** Do not silently re-enable TRC20 when updating accepted coins; preserve historical invoice reconciliation.

Do not mention NOWPayments in any customer-facing Telegram content; use clean, shop-neutral deposit and payment messages.

**Why:** The user explicitly requested no provider branding anywhere in Telegram, including deposit prompts and invoice footers.

**How to apply:** Keep provider identity visible in admin configuration, but not Telegram prompts, captions, receipts, errors or status updates. Never redact or alter delivered stock credentials.

Use helpful emojis, bold headings, clear spacing, and copyable payment details in Telegram deposit and payment messages.

**Why:** The user said the plain presentation was too dry and asked for emojis and better text styling.

**How to apply:** Keep the formatting compatible with Telegram HTML and caption limits; preserve exact amounts, addresses, and safety warnings.

Telegram invoice Cancel buttons mark the customer's cancellation, hide payment instructions and return to the home menu without stopping payment reconciliation.

**Why:** The user requested Cancel to go home; a transfer already sent must still be verified and credited rather than lost when the customer navigates away.

**How to apply:** Track customer cancellation separately from provider status, including in dashboard history. Clear conversational selections and stop inviting payment. Never describe cancellation as stopping an on-chain transfer or deleting the financial record; credit verified late payments normally.
