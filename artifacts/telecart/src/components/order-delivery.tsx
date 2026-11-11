import { useState } from "react";
import { useRevealOrderDelivery } from "@workspace/api-client-react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { dateTime, errMsg } from "@/lib/format";

export function OrderDelivery({ orderId, delivered }: { orderId: string; delivered: boolean }) {
  const reveal = useRevealOrderDelivery({ mutation: { gcTime: 0, retry: false } });
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  return (
    <section className="mt-6 rounded-lg border border-border p-3" data-testid="section-order-delivery">
      <h3 className="text-sm font-semibold">Delivered inventory</h3>
      {!delivered ? <p className="mt-2 text-xs text-muted-foreground">No inventory has been delivered for this order yet.</p> : (
        <>
          <p className="mt-1 text-xs text-muted-foreground">The exact stock item sent to this customer. Hidden until you reveal it; not included in CSV exports.</p>
          {reveal.data ? (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground">Inventory #{reveal.data.inventoryId} · Sent {dateTime(reveal.data.deliveredAt)}</p>
              <pre className="mt-2 max-h-72 select-text overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs" data-testid="text-delivered-inventory">{reveal.data.credential}</pre>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="outline" onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(reveal.data!.credential);
                    setCopied(true);
                  } catch {
                    toast({ title: "Could not copy", description: "Select the inventory text and copy it manually.", variant: "destructive" });
                  }
                }} data-testid="button-copy-delivered-inventory"><Copy className="mr-1.5 h-3.5 w-3.5" />{copied ? "Copied" : "Copy"}</Button>
                <Button size="sm" variant="outline" onClick={() => { reveal.reset(); setCopied(false); }} data-testid="button-hide-delivered-inventory"><EyeOff className="mr-1.5 h-3.5 w-3.5" />Hide</Button>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              {reveal.isError && <p className="mb-2 text-xs text-destructive" role="alert">{errMsg(reveal.error)}</p>}
              <Button size="sm" variant="outline" disabled={reveal.isPending} onClick={() => reveal.mutate({ id: orderId })} data-testid="button-reveal-delivered-inventory">
                <Eye className="mr-1.5 h-3.5 w-3.5" />{reveal.isPending ? "Loading…" : reveal.isError ? "Try again" : "Reveal delivered item"}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
