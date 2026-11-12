import { useEffect, useRef, useState, type ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useListProducts } from "@workspace/api-client-react";
import { Bot, Loader2, RotateCcw, ShoppingBag, LifeBuoy, Wallet, History, ChevronLeft, MoreVertical, PlugZap, Sparkles } from "lucide-react";
import { PageHeader, Panel, ErrorState, RowsSkeleton } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { useShopSettings } from "@/hooks/use-shop-settings";
import { money } from "@/lib/format";
import { IntegrationPanel } from "@/components/integration-panel";

const handle = z.string().max(32).regex(/^@?[A-Za-z0-9_]*$/, "Letters, numbers and underscores only");
const label = z.string().trim().min(1, "Required").max(30);
const schema = z.object({
  botUsername: handle, supportUsername: handle,
  welcomeMessage: z.string().trim().min(1, "Welcome message is required").max(3000),
  supportMessage: z.string().max(2000),
  productsLabel: label, supportLabel: label, walletLabel: label, ordersLabel: label,
});
type V = z.infer<typeof schema>;
type Msg = { id: number; from: "bot" | "user"; body: ReactNode };

export default function BotPage() {
  const { settings, savePartial, saving } = useShopSettings();
  const products = useListProducts();
  const form = useForm<V>({ resolver: zodResolver(schema), defaultValues: { botUsername: "", supportUsername: "", welcomeMessage: "", supportMessage: "", productsLabel: "Products", supportLabel: "Support", walletLabel: "Wallet", ordersLabel: "Order History" } });
  const inited = useRef(false);
  useEffect(() => {
    const s = settings.data;
    if (s && !inited.current) {
      inited.current = true;
      form.reset({ botUsername: s.botUsername, supportUsername: s.supportUsername, welcomeMessage: s.welcomeMessage, supportMessage: s.supportMessage, productsLabel: s.productsLabel, supportLabel: s.supportLabel, walletLabel: s.walletLabel, ordersLabel: s.ordersLabel });
    }
  }, [settings.data, form]);
  const v = useWatch({ control: form.control }) as V;
  const [chat, setChat] = useState<Msg[]>([]);
  const idRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [chat]);

  const push = (userText: string, reply: ReactNode) => setChat((c) => [...c, { id: idRef.current++, from: "user", body: userText }, { id: idRef.current++, from: "bot", body: reply }]);
  const active = (products.data ?? []).filter((p) => p.status === "active");
  const stocked = active.filter((p) => p.stock > 0);
  const previewStockAnnouncement = (isNewProduct: boolean) => {
    const product = stocked[0];
    if (!product) return;
    setChat((current) => [...current, {
      id: idRef.current++,
      from: "bot",
      body: (
        <div className="-m-1 space-y-2">
          <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#16835d]">{isNewProduct ? "✨ New product" : "📦 Added stock"}</div>
          <div className="font-semibold">{product.buttonEmoji ?? "🛍"} {product.name}</div>
          {product.description && <div className="whitespace-pre-wrap text-[12px] text-[#566273]">{product.description}</div>}
          <div className="flex items-center justify-between gap-2 text-[12px]">
            <span className="font-mono font-semibold">{money(product.price)}</span>
            <span className="rounded-full bg-[#eaf6ef] px-2 py-0.5 text-[11px] font-medium text-[#16835d]">{product.stock} in stock</span>
          </div>
          <button onClick={() => push("Buy now", <div>🔢 Choose your quantity to continue.</div>)} className="w-full rounded-lg bg-[#16835d] px-3 py-2 text-center text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-[#116d4c]">🛒 Buy now</button>
        </div>
      ),
    }]);
  };
  const tap = (k: "products" | "support" | "wallet" | "orders") => {
    if (k === "products") push(v.productsLabel, active.length ? (
      <div><div className="mb-1.5 font-semibold">Available now</div>{active.map((p) => (
        <div key={p.id} className="flex justify-between gap-3 border-t border-black/5 py-1"><span className="truncate">{p.name}</span><span className="font-mono">{money(p.price)}</span></div>))}
        <div className="mt-1.5 text-[11px] opacity-60">Checkout is not connected in preview.</div></div>
    ) : "No products are listed right now.");
    if (k === "support") push(v.supportLabel, <div className="whitespace-pre-wrap">{v.supportMessage || "Need help? Contact us."}{v.supportUsername && <div className="mt-1 font-medium text-[#2a8bd0]">@{v.supportUsername.replace(/^@/, "")}</div>}</div>);
    if (k === "wallet") push(v.walletLabel, <div><div>Balance: <b className="font-mono">$0.00</b></div><div className="mt-1 text-[11px] opacity-70">Top-ups via NOWPayments will show a QR code, amount, address, network and expiry here once payments are connected.</div></div>);
    if (k === "orders") push(v.ordersLabel, "You have no orders yet.");
  };
  const keys = [[{ k: "products" as const, l: v.productsLabel, i: ShoppingBag }, { k: "support" as const, l: v.supportLabel, i: LifeBuoy }], [{ k: "wallet" as const, l: v.walletLabel, i: Wallet }, { k: "orders" as const, l: v.ordersLabel, i: History }]];

  return (
    <div>
      <PageHeader eyebrow="Bot copy" title="Bot messages" description="Write what buyers see. The phone on the right is a local simulation of your menu — it does not talk to Telegram." />
      <div className="mb-5"><IntegrationPanel /></div>
      {settings.isError ? <ErrorState message="Failed to load settings" onRetry={() => settings.refetch()} /> : settings.isLoading ? <RowsSkeleton rows={8} /> : (
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <Form {...form}>
            <form onSubmit={form.handleSubmit((d) => savePartial(d, "Bot messages"))} className="space-y-5">
              <Panel title="Identity">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField control={form.control} name="botUsername" render={({ field }) => (<FormItem><FormLabel>Bot username</FormLabel><FormControl><Input placeholder="@yourshop_bot" className="font-mono" {...field} data-testid="input-bot-username" /></FormControl><FormMessage /></FormItem>)} />
                  <FormField control={form.control} name="supportUsername" render={({ field }) => (<FormItem><FormLabel>Support contact</FormLabel><FormControl><Input placeholder="@yoursupport" className="font-mono" {...field} data-testid="input-support-username" /></FormControl><FormMessage /></FormItem>)} />
                </div>
              </Panel>
              <Panel title="Messages">
                <div className="space-y-4">
                  <FormField control={form.control} name="welcomeMessage" render={({ field }) => (<FormItem><FormLabel>Welcome message</FormLabel><FormControl><Textarea rows={5} {...field} data-testid="input-welcome-message" /></FormControl><FormDescription>Sent on /start, above the menu.</FormDescription><FormMessage /></FormItem>)} />
                  <FormField control={form.control} name="supportMessage" render={({ field }) => (<FormItem><FormLabel>Support reply</FormLabel><FormControl><Textarea rows={3} {...field} data-testid="input-support-message" /></FormControl><FormMessage /></FormItem>)} />
                </div>
              </Panel>
              <Panel title="Menu buttons" meta="2 × 2 reply keyboard">
                <div className="grid grid-cols-2 gap-3">
                  {(["productsLabel", "supportLabel", "walletLabel", "ordersLabel"] as const).map((n) => (
                    <FormField key={n} control={form.control} name={n} render={({ field }) => (<FormItem><FormLabel className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{n.replace("Label", "")}</FormLabel><FormControl><Input {...field} data-testid={`input-${n}`} /></FormControl><FormMessage /></FormItem>)} />
                  ))}
                </div>
              </Panel>
              <Panel title="New-stock announcements" meta={<span className="inline-flex items-center gap-1 text-ok"><Sparkles className="h-3 w-3" />automatic</span>}>
                <div className="flex gap-3 rounded-md border border-ok/20 bg-ok/5 p-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ok/10 text-ok"><ShoppingBag className="h-4 w-4" /></div>
                  <div>
                    <p className="text-sm font-medium">Let customers know when stock is ready</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">The first stocked announcement says “New product.” Later restocks say “Added stock.” Both show the name, price, availability and Buy now button to customers who have already messaged your bot. Alerts wait until the product is active and stocked. Telegram must be enabled; blocked or unreachable accounts may not receive it.</p>
                  </div>
                </div>
              </Panel>
              <div className="flex justify-end"><Button type="submit" disabled={saving} data-testid="button-save-bot">{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save bot messages</Button></div>
            </form>
          </Form>

          <div className="lg:sticky lg:top-6 lg:self-start">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-signal px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-white" data-testid="badge-preview-not-connected"><PlugZap className="h-3 w-3" />Preview · not connected</span>
                <Button size="sm" variant="outline" disabled={!stocked.length} onClick={() => previewStockAnnouncement(true)} data-testid="button-preview-stock-announcement"><Sparkles className="mr-1 h-3 w-3" />New product</Button>
                <Button size="sm" variant="outline" disabled={!stocked.length} onClick={() => previewStockAnnouncement(false)} data-testid="button-preview-restock-announcement">Added stock</Button>
              </div>
              <button onClick={() => setChat([])} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="button-reset-preview"><RotateCcw className="h-3 w-3" />Reset</button>
            </div>
            <div className="overflow-hidden rounded-[28px] border-[6px] border-ink bg-ink shadow-xl">
              <div className="flex items-center gap-2.5 bg-[#f6f8fa] px-3 py-2.5 text-[#1b2433]">
                <ChevronLeft className="h-5 w-5 text-[#2a8bd0]" />
                <div className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-[#38b0ea] to-[#1d7fc4] text-white"><Bot className="h-5 w-5" /></div>
                <div className="min-w-0 flex-1 leading-tight"><div className="truncate text-sm font-semibold">{settings.data?.shopName || "Your shop"}</div><div className="text-[11px] text-[#7d8896]">bot · offline preview</div></div>
                <MoreVertical className="h-4 w-4 text-[#7d8896]" />
              </div>
              <div ref={scrollRef} className="tg-wall h-[380px] space-y-2 overflow-y-auto px-3 py-3 text-[13px] text-[#1b2433]">
                <div className="mx-auto w-fit rounded-full bg-black/20 px-2.5 py-0.5 text-[11px] text-white">/start</div>
                <div className="pop max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-white px-3 py-2 shadow-sm" data-testid="text-preview-welcome">{v.welcomeMessage || "Write a welcome message"}</div>
                {chat.map((m) => (
                  <div key={m.id} className={`pop max-w-[85%] rounded-2xl px-3 py-2 shadow-sm ${m.from === "user" ? "ml-auto rounded-br-md bg-[#e1f7c9]" : "rounded-bl-md bg-white"}`}>{m.body}</div>
                ))}
              </div>
              <div className="grid gap-1.5 bg-[#eef1f4] p-2">
                {keys.map((row, i) => (
                  <div key={i} className="grid grid-cols-2 gap-1.5">
                    {row.map((b) => (
                      <button key={b.k} onClick={() => tap(b.k)} data-testid={`button-preview-${b.k}`} className="flex items-center justify-center gap-1.5 truncate rounded-lg bg-white px-2 py-2.5 text-[13px] font-medium text-[#1b2433] shadow-[0_1px_0_rgba(0,0,0,0.08)] transition-transform active:scale-[0.97]">
                        <b.i className="h-3.5 w-3.5 text-[#2a8bd0]" />{b.l || "—"}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">Local simulation. Taps never reach Telegram.</p>
          </div>
        </div>
      )}
    </div>
  );
}
