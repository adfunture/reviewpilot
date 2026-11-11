"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageTitle, Shell } from "@/components/Shell";
import { Badge, Button, Card, Input, Select, Table, Td } from "@/components/ui";
import { api, CAMPAIGN_STATUS, DELIVERY_STATUS, fmtDate, INVITATION_STATUS, REVIEW_STATUS, RULES } from "@/lib/api";

interface Row {
  id: string;
  name: string;
  customer: string | null;
  orderCreatedAt: string;
  carrier: string | null;
  isFreight: boolean;
  hasTracking: boolean;
  deliveryStatus: string;
  deliveredAt: string | null;
  shippingRule: string | null;
  platform: string | null;
  invitations: ({ status: string; scheduledAt: string; sentAt: string | null } | null)[];
  reviewStatus: string | null;
  campaignStatus: string | null;
  campaignReason: string | null;
}

function Invite({ i }: { i: Row["invitations"][number] }) {
  if (!i) return <span className="text-muted">–</span>;
  return (
    <span className="whitespace-nowrap">
      {fmtDate(i.sentAt ?? i.scheduledAt)} <span className="text-xs text-muted">{INVITATION_STATUS[i.status]}</span>
    </span>
  );
}

export default function OrdersPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [campaignStatus, setCampaignStatus] = useState("");
  const [deliveryStatus, setDeliveryStatus] = useState("");

  const load = useCallback(async () => {
    const q = new URLSearchParams({ page: String(page) });
    if (search) q.set("search", search);
    if (campaignStatus) q.set("campaignStatus", campaignStatus);
    if (deliveryStatus) q.set("deliveryStatus", deliveryStatus);
    const d = await api<{ rows: Row[]; total: number }>(`/api/orders?${q}`);
    setRows(d.rows);
    setTotal(d.total);
  }, [page, search, campaignStatus, deliveryStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    await api("/api/sync/orders", { method: "POST", body: {} });
    alert("Synchronisierung wurde eingeplant und läuft im Hintergrund.");
  }

  return (
    <Shell>
      <PageTitle
        title="Bestellungen & Kampagnen"
        description="Pro Bestellung höchstens eine Kampagne mit maximal drei Kontaktversuchen – plattformübergreifend."
        actions={
          <Button variant="secondary" onClick={sync}>
            Shopify jetzt synchronisieren
          </Button>
        }
      />
      <Card>
        <div className="mb-4 flex flex-wrap gap-2">
          <Input placeholder="Bestellnr., Name oder E-Mail" value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} className="max-w-xs" />
          <Select value={campaignStatus} onChange={(e) => { setPage(1); setCampaignStatus(e.target.value); }} aria-label="Kampagnenstatus">
            <option value="">Alle Kampagnen</option>
            {Object.entries(CAMPAIGN_STATUS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </Select>
          <Select value={deliveryStatus} onChange={(e) => { setPage(1); setDeliveryStatus(e.target.value); }} aria-label="Zustellstatus">
            <option value="">Alle Zustellstatus</option>
            {Object.entries(DELIVERY_STATUS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </Select>
        </div>
        <Table head={["Bestellung", "Kunde", "Bestelldatum", "Versand", "Tracking", "Zustellung", "Versandregel", "Plattform", "1. Einladung", "2. Einladung", "3. Einladung", "Bewertung", "Kampagne"]}>
          {rows.map((r) => {
            const cs = r.campaignStatus ? CAMPAIGN_STATUS[r.campaignStatus] : null;
            return (
              <tr key={r.id} className="hover:bg-hover">
                <Td>
                  <Link href={`/bestellung?id=${r.id}`} className="font-medium underline-offset-2 hover:underline">{r.name}</Link>
                </Td>
                <Td>{r.customer ?? "–"}</Td>
                <Td>{fmtDate(r.orderCreatedAt)}</Td>
                <Td>{r.carrier ?? "–"} {r.isFreight && <Badge tone="amber">Spedition</Badge>}</Td>
                <Td>{r.hasTracking ? "ja" : "nein"}</Td>
                <Td>
                  <span className="block">{DELIVERY_STATUS[r.deliveryStatus]}</span>
                  {r.deliveredAt && <span className="text-xs text-muted">{fmtDate(r.deliveredAt)}</span>}
                </Td>
                <Td>{r.shippingRule ? RULES[r.shippingRule] : "–"}</Td>
                <Td>{r.platform ?? "–"}</Td>
                {r.invitations.map((i, idx) => (
                  <Td key={idx}><Invite i={i} /></Td>
                ))}
                <Td>{r.reviewStatus ? REVIEW_STATUS[r.reviewStatus] : "–"}</Td>
                <Td>{cs ? <Badge tone={cs.tone} title={r.campaignReason ?? undefined}>{cs.label}</Badge> : <span className="text-muted">–</span>}</Td>
              </tr>
            );
          })}
        </Table>
        {rows.length === 0 && <p className="py-6 text-center text-sm text-muted">Keine Bestellungen gefunden.</p>}
        <div className="mt-4 flex items-center justify-between text-sm text-muted">
          <span>{total} Bestellungen</span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Zurück</Button>
            <Button variant="secondary" disabled={page * 50 >= total} onClick={() => setPage(page + 1)}>Weiter</Button>
          </div>
        </div>
      </Card>
    </Shell>
  );
}
