import { useCallback, useEffect, useRef, useState } from "react";
import { revealProductInventory, type InventoryRevealedItem } from "@workspace/api-client-react";
import { errMsg } from "@/lib/format";

// Keep decrypted text out of the query cache, browser storage, and URLs.
export function useInventoryReveal(productId: number | null, itemIds: string, signedIn: boolean) {
  const scope = `${productId}:${itemIds}`;
  const request = useRef<AbortController | null>(null);
  const [shown, setShown] = useState<{ scope: string; items: InventoryRevealedItem[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hide = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setShown(null);
    setLoading(false);
    setError(null);
  }, []);

  useEffect(() => {
    hide();
    const onVisibility = () => { if (document.hidden) hide(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      request.current?.abort();
      request.current = null;
    };
  }, [scope, signedIn, hide]);

  const show = async () => {
    if (productId === null || !signedIn) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await revealProductInventory(productId, { signal: controller.signal, cache: "no-store" });
      if (request.current !== controller || controller.signal.aborted) return;
      if (result.productId !== productId) throw new Error("Inventory response does not match the selected product.");
      setShown({ scope, items: result.items });
    } catch (cause) {
      if (request.current === controller && !controller.signal.aborted) {
        setShown(null);
        setError(errMsg(cause));
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  };

  const visible = signedIn && shown?.scope === scope;
  return { visible, credentials: new Map(visible ? shown.items.map(item => [item.id, item.credential]) : []), loading, error, show, hide };
}
