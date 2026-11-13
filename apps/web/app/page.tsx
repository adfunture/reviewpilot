"use client";
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PageTitle, Shell } from "@/components/Shell";
import { Badge, Card, Input, Notice, Select, Stat, Table, Td } from "@/components/ui";
import { api, CAMPAIGN_STATUS, fmtNum, fmtPct } from "@/lib/api";

interface Dashboard {
  remindersDue: number;
  stats: {
    orders: number;
    deliveredOrders: number;
    ordersWithoutTracking: number;
    scheduledInvitations: number;
    sentInvitations: number;
    deliveryRate: number | null;
    clickRate: number | null;
    confirmedReviews: number;
    averageRating: number | null;
    ratingCount: number;
    campaignStatus: Record<string, number>;
  };
  series: { day: string; sent: number; clicks: number; reviews: number }[];
  sending: { enabled: boolean; blockedReason: string | null; transport: string; legalBasis: string };
}

interface PlatformStat {
  id: string;
  name: string;
  active: boolean;
  integrationType: string;
  orders: number;
  scheduled: number;
  sent: number;
  deliveredEmails: number;
  clicks: number;
  confirmedReviews: number | null;
  averageRating: number | null;
}

const RANGES = [
  { v: "today", label: "Heute" },
  { v: "7", label: "7 Tage" },
  { v: "30", label: "30 Tage" },
  { v: "90", label: "90 Tage" },
  { v: "custom", label: "Benutzerdefiniert" },
];

function rangeQuery(range: string, from: string, to: string): string {
  if (range === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return `from=${start.toISOString()}`;
  }
  if (range === "custom" && from && to) return `from=${new Date(from).toISOString()}&to=${new Date(`${to}T23:59:59`).toISOString()}`;
  return `days=${range === "custom" ? 30 : range}`;
}

export default function DashboardPage() {
  const [range, setRange] = useState("30");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Dashboard | null>(null);
  const [platforms, setPlatforms] = useState<PlatformStat[]>([]);

  const load = useCallback(async () => {
    const q = rangeQuery(range, from, to);
    const [d, p] = await Promise.all([api<Dashboard>(`/api/dashboard?${q}`), api<PlatformStat[]>(`/api/platform-stats?${q}`)]);
    setData(d);
    setPlatforms(p);
  }, [range, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const s = data?.stats;
  return (
    <Shell>
      <PageTitle
        title="Übersicht"
        description="Alle Werte stammen aus echten Shopify-, Versand- und Bewertungsdaten. „–“ bedeutet: nicht verfügbar oder noch keine Daten."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Zeitraum">
              {RANGES.map((r) => (
                <option key={r.v} value={r.v}>
                  {r.label}
                </option>
              ))}
            </Select>
            {range === "custom" && (
              <>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" aria-label="Von" />
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" aria-label="Bis" />
              </>
            )}
          </div>
        }
      />

      {data && !data.sending.enabled && (
        <div className="mb-6">
          <Notice title="Versand nicht freigegeben">
            Es werden keine Bewertungs-E-Mails an Kunden verschickt. {data.sending.blockedReason && `Grund: ${data.sending.blockedReason}.`} Die Freigabe erfolgt unter „Einstellungen &amp; Freigabe“.
          </Notice>
        </div>
      )}

      {s && (
        <>
          {data!.remindersDue > 0 && (
            <div className="mb-3">
            <Notice tone="amber">
              <a href="/bestellungen?erinnerung=1" className="font-medium underline underline-offset-2">
                {data!.remindersDue === 1 ? "1 Erinnerung ist fällig" : `${data!.remindersDue} Erinnerungen sind fällig`}
              </a>{" "}
              – Kunden ohne bestätigte Bewertung, bei denen der Mindestabstand zur letzten E-Mail erreicht ist.
            </Notice>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Stat label="Shopify-Bestellungen" value={fmtNum(s.orders)} />
            <Stat label="Mit bestätigter Zustellung" value={fmtNum(s.deliveredOrders)} />
            <Stat label="Ohne Tracking / Spedition" value={fmtNum(s.ordersWithoutTracking)} />
            <Stat label="Geplante Anfragen" value={fmtNum(s.scheduledInvitations)} hint="aktuell, unabhängig vom Zeitraum" />
            <Stat label="Versendete Anfragen" value={fmtNum(s.sentInvitations)} />
            <Stat label="E-Mail-Zustellquote" value={fmtPct(s.deliveryRate)} hint="angenommen abzgl. harter Bounces" />
            <Stat label="Klickrate" value={fmtPct(s.clickRate)} hint="Klick ≠ Bewertung" />
            <Stat label="Bestätigte Bewertungen" value={fmtNum(s.confirmedReviews)} hint="per API oder manuell bestätigt" />
            <Stat label="Ø Sterne" value={s.averageRating == null ? "–" : `${fmtNum(s.averageRating, 1)} ★`} hint={s.ratingCount ? `${s.ratingCount} Bewertungen mit Sternen` : undefined} />
            <Stat label="Versandmodus" value={data!.sending.transport === "smtp" ? "SMTP" : "Nur Protokoll"} />
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-3">
            <Card title="Verlauf" description="Versendete Anfragen, Klicks und bestätigte Bewertungen pro Tag" className="xl:col-span-2">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data!.series}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--rp-border)" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(8, 10) + "." + d.slice(5, 7) + "."} fontSize={11} stroke="var(--rp-muted)" />
                    <YAxis allowDecimals={false} fontSize={11} stroke="var(--rp-muted)" width={32} />
                    <Tooltip contentStyle={{ background: "var(--rp-card)", border: "1px solid var(--rp-border)", fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="sent" name="Versendet" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="clicks" name="Klicks" fill="#a855f7" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="reviews" name="Bewertungen" fill="#10b981" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Kampagnenstatus" description="Alle Kampagnen">
              <ul className="space-y-2 text-sm">
                {Object.entries(CAMPAIGN_STATUS).map(([k, v]) => (
                  <li key={k} className="flex items-center justify-between">
                    <Badge tone={v.tone}>{v.label}</Badge>
                    <span className="tabular-nums">{fmtNum(s.campaignStatus[k] ?? 0)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <div className="mt-6">
            <Card title="Bewertungsplattformen" description="Klicks und bestätigte Bewertungen werden getrennt ausgewiesen. Ohne Statusabfrage der Plattform bleibt „Bestätigt“ leer.">
              <Table head={["Plattform", "Status", "Bestellungen", "Geplant", "Versendet", "Zugestellt", "Klicks", "Bestätigt", "Ø Sterne"]}>
                {platforms.map((p) => (
                  <tr key={p.id}>
                    <Td>{p.name}</Td>
                    <Td>{p.active ? <Badge tone="green">aktiv</Badge> : <Badge>inaktiv</Badge>}</Td>
                    <Td>{fmtNum(p.orders)}</Td>
                    <Td>{fmtNum(p.scheduled)}</Td>
                    <Td>{fmtNum(p.sent)}</Td>
                    <Td>{fmtNum(p.deliveredEmails)}</Td>
                    <Td>{fmtNum(p.clicks)}</Td>
                    <Td>{fmtNum(p.confirmedReviews)}</Td>
                    <Td>{p.averageRating == null ? "–" : `${fmtNum(p.averageRating, 1)} ★`}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        </>
      )}
    </Shell>
  );
}
