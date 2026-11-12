import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export function isProductImageUrl(value: string) {
  try {
    const url = new URL(value);
    return value.length <= 2048 && url.protocol === "https:" && !url.username && !url.password && !url.port &&
      !url.hash && url.hostname.includes(".") && !/^[\d.]+$/.test(url.hostname) &&
      !url.hostname.includes(":") && !/\.(localhost|local|internal|invalid|test)$/.test(url.hostname) &&
      /\.(jpe?g|png|webp|gif)$/i.test(url.pathname);
  } catch { return false; }
}

export function ProductMediaPreview({ url, name, className }: { url?: string | null; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || !isProductImageUrl(url)) return null;
  return <div className={cn("overflow-hidden rounded-lg border bg-muted/30", className)}>
    {failed ? <p role="status" className="p-3 text-xs text-destructive">Image could not load. Use a direct public image or GIF link, not a sharing page.</p>
      : <img key={url} src={url} alt={name || "Product image preview"} referrerPolicy="no-referrer" loading="lazy"
        className="max-h-64 w-full object-contain" onError={() => setFailed(true)} />}
  </div>;
}
