import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetAdvertisingWorkspaceQueryKey, type AdvertisingWorkspace } from "@workspace/api-client-react";

/** Push authoritative snapshots without resetting unsaved campaign choices. */
export function useLiveAdvertisingWorkspace() {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let active = true, received = 0;
    const key = getGetAdvertisingWorkspaceQueryKey();
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    const events = new EventSource(`${base}/api/shop/advertising/events`);
    const update = async (event: MessageEvent) => {
      const version = ++received;
      try {
        const workspace = JSON.parse(event.data) as AdvertisingWorkspace;
        await qc.cancelQueries({ queryKey: key });
        if (active && version === received) qc.setQueryData<AdvertisingWorkspace>(key, workspace);
      }
      catch { void qc.invalidateQueries({ queryKey: key }); }
    };
    events.addEventListener("workspace", update as EventListener);
    // Initial connection and every reconnect rehydrate missed changes.
    events.onopen = () => { setConnected(true); void qc.invalidateQueries({ queryKey: key }); };
    events.onerror = () => { setConnected(false); void qc.invalidateQueries({ queryKey: key }); };
    const resume = () => { if (document.visibilityState === "visible") void qc.invalidateQueries({ queryKey: key }); };
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      events.close(); document.removeEventListener("visibilitychange", resume);
    };
  }, [qc]);
  return connected;
}
