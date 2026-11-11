"use client";
// Schlanke Komponenten im Stil von shadcn/ui (Tailwind, ohne zusätzliche Laufzeit-Abhängigkeiten)
import { clsx } from "clsx";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { twMerge } from "tailwind-merge";
import type { Tone } from "@/lib/api";

export const cn = (...c: Parameters<typeof clsx>) => twMerge(clsx(...c));

export function Card({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-border bg-card p-5", className)}>
      {(title || actions) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  return (
    <button
      {...p}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-fg text-bg hover:opacity-90",
        variant === "secondary" && "border border-border bg-card hover:bg-hover",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        variant === "ghost" && "hover:bg-hover",
        className,
      )}
    />
  );
}

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cn("w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40", p.className)} />;
}

export function Textarea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cn("w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-500/40", p.className)} />;
}

export function Select(p: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cn("rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm", p.className)} />;
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="mb-1 block text-sm font-medium">
      {children}
      {hint && <span className="ml-1 font-normal text-muted">{hint}</span>}
    </span>
  );
}

const TONES: Record<Tone, string> = {
  gray: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
  blue: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  green: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  amber: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  red: "bg-red-500/10 text-red-700 dark:text-red-300",
};

export function Badge({ tone = "gray", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", TONES[tone])}>
      {children}
    </span>
  );
}

export function Notice({ tone = "amber", title, children }: { tone?: Tone; title?: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("rounded-md border px-4 py-3 text-sm", tone === "red" ? "border-red-500/30" : tone === "green" ? "border-emerald-500/30" : tone === "blue" ? "border-blue-500/30" : "border-amber-500/40", TONES[tone])}>
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div>{children}</div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-left text-sm">
        <thead className="border-b border-border text-xs text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="px-2 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("px-2 py-2 align-top", className)}>{children}</td>;
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="text-sm text-red-600">{error}</p> : null;
}
