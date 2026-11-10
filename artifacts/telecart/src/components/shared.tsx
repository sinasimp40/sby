import type { ReactNode, ComponentType } from "react";
import { AlertTriangle, RotateCw, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="rise mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <div className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-primary">{eyebrow}</div>
        <h1 className="font-display text-3xl font-bold md:text-[2.15rem]" data-testid="text-page-title">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, meta, children, className, bodyClassName }: { title?: ReactNode; meta?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn("rise rounded-xl border border-card-border bg-card shadow-sm", className)}>
      {(title || meta) && (
        <header className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
          <h2 className="font-display text-[15px] font-semibold">{title}</h2>
          {meta && <div className="text-xs text-muted-foreground">{meta}</div>}
        </header>
      )}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function EmptyState({ icon: Icon, title, body, action }: { icon: ComponentType<{ className?: string }>; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="dotgrid flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-12 text-center" data-testid="state-empty">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-xl border border-border bg-card shadow-sm">
        <Icon className="h-5 w-5 text-primary" />
      </div>
      <div className="font-display text-base font-semibold">{title}</div>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center" data-testid="state-error">
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <div className="text-sm font-medium">{message}</div>
      <Button size="sm" variant="outline" onClick={onRetry} data-testid="button-retry">
        <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Retry
      </Button>
    </div>
  );
}

export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

const tones: Record<string, string> = {
  active: "bg-ok/10 text-ok border-ok/25",
  available: "bg-ok/10 text-ok border-ok/25",
  delivered: "bg-ok/10 text-ok border-ok/25",
  finished: "bg-ok/10 text-ok border-ok/25",
  paid: "bg-primary/10 text-primary border-primary/25",
  confirming: "bg-primary/10 text-primary border-primary/25",
  draft: "bg-muted text-muted-foreground border-border",
  waiting: "bg-signal-soft text-signal border-signal/25",
  pending: "bg-signal-soft text-signal border-signal/25",
  archived: "bg-muted text-muted-foreground/80 border-border line-through decoration-1",
  cancelled: "bg-muted text-muted-foreground border-border",
  expired: "bg-muted text-muted-foreground border-border",
  refunded: "bg-destructive/10 text-destructive border-destructive/25",
  failed: "bg-destructive/10 text-destructive border-destructive/25",
};

export function StatusPill({ status, testId }: { status: string; testId?: string }) {
  return (
    <span data-testid={testId} className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider", tones[status] ?? "bg-muted text-muted-foreground border-border")}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {status}
    </span>
  );
}

export function SetupRequired({ label = "Setup required" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-signal/30 bg-signal-soft px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-signal" data-testid="status-setup-required">
      <PlugZap className="h-3 w-3" /> {label}
    </span>
  );
}

export function Stat({ label, value, hint, testId }: { label: string; value: ReactNode; hint?: ReactNode; testId: string }) {
  return (
    <div className="rise rounded-xl border border-card-border bg-card px-4 py-3.5 shadow-sm">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="tabular mt-1 font-display text-2xl font-bold" data-testid={testId}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
