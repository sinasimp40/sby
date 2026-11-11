import type { SettingsInput, Product } from "@workspace/api-zod";

export const defaultSettings: SettingsInput = {
  shopName: "My Digital Store",
  botUsername: "",
  welcomeMessage: "Welcome to our store!\nDiscover our products, manage your wallet, and find all your orders in one place.\n\nHow can we help you today?",
  supportUsername: "",
  supportMessage: "Need a hand? Contact our support team for help with your orders.",
  currency: "USD",
  minDeposit: 5,
  rateMode: "floating",
  acceptedCoins: ["BTC", "ETH", "USDTTRC20", "LTC"],
  invoiceExpiryMinutes: 30,
  maintenanceMode: false,
  productsLabel: "Products",
  supportLabel: "Support",
  walletLabel: "Wallet",
  ordersLabel: "Order History",
};

// Public, read-only examples. These are never inserted as a user's stock or orders.
export const sampleProducts: Product[] = [
  { id: 1, name: "ChatGPT Plus Account", description: "Sample listing. Replace with your authorized product details.", category: "AI accounts", price: 12, status: "draft", deliveryFormat: "email:pass", stock: 0, sold: 0, createdAt: "2026-11-10T00:00:00.000Z" },
  { id: 2, name: "Premium AI Account", description: "Sample listing for an authorized digital account.", category: "AI accounts", price: 25, status: "draft", deliveryFormat: "user:pass", stock: 0, sold: 0, createdAt: "2026-11-10T00:00:00.000Z" },
  { id: 3, name: "Digital Service Access", description: "Sample listing. Set your price and add inventory after signing in.", category: "Digital services", price: 8, status: "draft", deliveryFormat: "email:pass", stock: 0, sold: 0, createdAt: "2026-11-10T00:00:00.000Z" },
];
