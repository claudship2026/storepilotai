import * as React from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: Array<string | undefined | false | null>) {
  return twMerge(clsx(inputs));
}

/* ---------------- Card ---------------- */

export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-lg border border-ink-700 bg-ink-900", className)}>{children}</div>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-ink-700 px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-ink-100">{title}</h2>
        {description ? <p className="mt-1 text-xs text-ink-400">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

/* ---------------- Button ---------------- */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        variant === "primary" && "bg-accent text-ink-950 hover:bg-accent/90",
        variant === "secondary" &&
          "border border-ink-600 bg-ink-800 text-ink-100 hover:border-ink-400",
        variant === "danger" && "bg-bad text-white hover:bg-bad/90",
        variant === "ghost" && "text-ink-300 hover:bg-ink-800 hover:text-ink-100",
        className,
      )}
    />
  );
}

/* ---------------- Badge ---------------- */

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad" | "accent";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide",
        tone === "neutral" && "bg-ink-800 text-ink-300",
        tone === "good" && "bg-good/15 text-good",
        tone === "warn" && "bg-warn/15 text-warn",
        tone === "bad" && "bg-bad/15 text-bad",
        tone === "accent" && "bg-accent/15 text-accent",
      )}
    >
      {children}
    </span>
  );
}

/** Every displayed fact carries one of these. Nothing is shown bare. */
export function Provenance({ value }: { value: string }) {
  const tone =
    value === "verified"
      ? "good"
      : value === "supplier_provided"
        ? "accent"
        : value === "estimated"
          ? "warn"
          : "bad";
  return <Badge tone={tone as never}>{value.replace("_", " ")}</Badge>;
}

/* ---------------- Form ---------------- */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-300">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-ink-400">{hint}</span> : null}
    </label>
  );
}

const inputClass =
  "w-full rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-ink-100 " +
  "placeholder:text-ink-400 focus:border-accent focus:outline-none";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputClass, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(inputClass, "min-h-24", props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(inputClass, props.className)} />;
}

/* ---------------- Table ---------------- */

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-ink-700 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-400">
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={cn("border-b border-ink-800 px-4 py-2.5 align-top text-ink-100", className)}>
      {children}
    </td>
  );
}

/* ---------------- Misc ---------------- */

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "good" | "warn" | "bad";
}) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div
        className={cn(
          "mt-1.5 text-2xl font-semibold tabular-nums",
          tone === "good" && "text-good",
          tone === "warn" && "text-warn",
          tone === "bad" && "text-bad",
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-ink-400">{sub}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-ink-700 px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink-100">{title}</p>
      <p className="mx-auto mt-1.5 max-w-lg text-xs leading-relaxed text-ink-400">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function PhasePlaceholder({
  phase,
  title,
  summary,
  ships,
}: {
  phase: string;
  title: string;
  summary: string;
  ships: string[];
}) {
  return (
    <Card>
      <CardHeader title={title} description={summary} action={<Badge tone="accent">{phase}</Badge>} />
      <CardBody>
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-400">
          What this tab will contain
        </p>
        <ul className="space-y-1.5">
          {ships.map((s) => (
            <li key={s} className="flex gap-2 text-sm text-ink-300">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-600" />
              {s}
            </li>
          ))}
        </ul>
        <p className="mt-5 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-xs text-ink-400">
          Locked by a feature flag until its phase is built. Nothing here can write to Shopify or
          spend money before the approval queue governs it.
        </p>
      </CardBody>
    </Card>
  );
}

export function money(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function bps(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${(value / 100).toFixed(1)}%`;
}
