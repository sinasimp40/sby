export function canCancelDeposit(p: {
  kind: string; status: string; fulfillment: string; cancelledAt: Date | null; deliveredAt: Date | null;
}) {
  return p.kind === "deposit" && !p.cancelledAt && !p.deliveredAt &&
    ["creating", "waiting", "confirming", "confirmed", "sending", "partially_paid"].includes(p.status) &&
    !["allocated", "credited", "delivered"].includes(p.fulfillment);
}
