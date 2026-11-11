import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSettings,
  useSaveSettings,
  getGetSettingsQueryKey,
  getGetOverviewQueryKey,
  getListActivityQueryKey,
} from "@workspace/api-client-react";
import type { SettingsInput, ShopSettings } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthGate } from "@/components/auth-gate";
import { errMsg } from "@/lib/format";

export function toInput(s: ShopSettings): SettingsInput {
  return {
    shopName: s.shopName,
    botUsername: s.botUsername,
    welcomeMessage: s.welcomeMessage,
    supportUsername: s.supportUsername,
    supportMessage: s.supportMessage,
    currency: s.currency,
    minDeposit: s.minDeposit,
    rateMode: s.rateMode,
    acceptedCoins: s.acceptedCoins,
    invoiceExpiryMinutes: s.invoiceExpiryMinutes,
    maintenanceMode: s.maintenanceMode,
    productsLabel: s.productsLabel,
    supportLabel: s.supportLabel,
    walletLabel: s.walletLabel,
    ordersLabel: s.ordersLabel,
  };
}

export function useShopSettings() {
  const settings = useGetSettings();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { requireAuth } = useAuthGate();

  const savePartial = (patch: Partial<SettingsInput>, label: string, onDone?: () => void) => {
    if (!requireAuth("save settings")) return;
    if (!settings.data) return;
    save.mutate(
      { data: { ...toInput(settings.data), ...patch } },
      {
        onSuccess: (data) => {
          qc.setQueryData(getGetSettingsQueryKey(), data);
          qc.invalidateQueries({ queryKey: getGetOverviewQueryKey() });
          qc.invalidateQueries({ queryKey: getListActivityQueryKey() });
          toast({ title: `${label} saved`, description: "Saved. A connected bot uses these settings on its next interaction. Existing invoices keep their original amounts." });
          onDone?.();
        },
        onError: (e) => toast({ variant: "destructive", title: "Could not save", description: errMsg(e) }),
      },
    );
  };

  return { settings, savePartial, saving: save.isPending };
}
