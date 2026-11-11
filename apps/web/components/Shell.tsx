"use client";
import { BarChart3, Layers, LogOut, Mail, Package, Settings, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { cn } from "./ui";

interface Me {
  user: { email: string; role: string };
  shop: { name: string; domain: string };
}

const NAV = [
  { href: "/", label: "Übersicht", icon: BarChart3 },
  { href: "/bestellungen", label: "Bestellungen & Kampagnen", icon: Package },
  { href: "/plattformen", label: "Bewertungsplattformen", icon: Layers },
  { href: "/vorlagen", label: "E-Mail-Vorlagen", icon: Mail },
  { href: "/einstellungen", label: "Einstellungen & Freigabe", icon: Settings },
  { href: "/system", label: "Datenschutz & System", icon: ShieldCheck },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api<Me>("/api/me").then(setMe).catch(() => undefined);
  }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  if (!me) return <div className="p-8 text-sm text-muted">Lade …</div>;
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-border bg-card md:sticky md:top-0 md:h-screen md:w-64 md:shrink-0 md:border-r md:border-b-0">
        <div className="p-4">
          <p className="text-lg font-semibold">ReviewPilot</p>
          <p className="text-xs text-muted">{me.shop.name}</p>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {NAV.map((n) => {
            const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className={cn("flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm", active ? "bg-hover font-medium" : "text-muted hover:bg-hover")}>
                <n.icon size={16} />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="hidden p-4 text-xs text-muted md:block">
          <p className="truncate">{me.user.email}</p>
          <button onClick={logout} className="mt-2 inline-flex items-center gap-1 hover:underline">
            <LogOut size={12} /> Abmelden
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}

export function PageTitle({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}
