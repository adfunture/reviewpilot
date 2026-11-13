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
  campaignId: string | null;
  reminderDue: { step: number; lastSentAt: string } | null;
}

type SortKey = "name" | "customer" | "orderCreatedAt" | "carrier" | "hasTracking" | "deliveryStatus" | "shippingRule" | "platform" | "invite1" | "invite2" | "invite3" | "reviewStatus" | "campaignStatus";

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
  const [invitationStatus, setInvitationStatus] = useState("");
  const [reminderDue, setReminderDue] = useState(false);
  const [busy, setBusy] = useState(false);

  // Link vom Dashboard: /bestellungen?erinnerung=1
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("erinnerung") === "1") setReminderDue(true);
  }, []);

  async function scheduleReminders(campaignIds: string[], confirmText: string) {
    if (!campaignIds.length || !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const res = await api<{ scheduled: number; failed: { campaignId: string; reason: string }[] }>("/api/campaigns/manual-reminders", { method: "POST", body: { campaignIds, confirmNoReview: true } });
      const failed = res.failed.length ? `\n\nNicht eingeplant (${res.failed.length}):\n${[...new Set(res.failed.map((f) => f.reason))].join("\n")}` : "";
      alert(`${res.scheduled} Erinnerung(en) eingeplant. Der Versand erfolgt im Versandfenster, höchstens 5 Mails auf einmal.${failed}`);
      await load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const [sort, setSort] = useState<SortKey>("orderCreatedAt");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  function toggleSort(key: SortKey) {
    setPage(1);
    if (key === sort) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      // Datumsspalten zuerst neueste, Textspalten zuerst A–Z
      setDir(key === "orderCreatedAt" || key.startsWith("invite") ? "desc" : "asc");
    }
  }

  const header = (label: string, key: SortKey) => (
    <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 whitespace-nowrap hover:text-fg" title="Sortieren">
      {label}
      <span className={sort === key ? "text-fg" : "opacity-30"}>{sort === key ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
    </button>
  );

  const load = useCallback(async () => {
    const q = new URLSearchParams({ page: String(page), sort, dir });
    if (search) q.set("search", search);
    if (campaignStatus) q.set("campaignStatus", campaignStatus);
    if (deliveryStatus) q.set("deliveryStatus", deliveryStatus);
    if (invitationStatus) q.set("invitationStatus", invitationStatus);
    if (reminderDue) q.set("reminderDue", "true");
    const d = await api<{ rows: Row[]; total: number }>(`/api/orders?${q}`);
    setRows(d.rows);
    setTotal(d.total);
  }, [page, search, campaignStatus, deliveryStatus, invitationStatus, reminderDue, sort, dir]);

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
          <Select value={invitationStatus} onChange={(e) => { setPage(1); setInvitationStatus(e.target.value); }} aria-label="Einladungsstatus">
            <option value="">Alle Einladungen</option>
            {["SENT", "SCHEDULED", "FAILED", "SKIPPED", "CANCELLED"].map((k) => (
              <option key={k} value={k}>Einladung {INVITATION_STATUS[k]}</option>
            ))}
          </Select>
          <Button variant={reminderDue ? "primary" : "secondary"} onClick={() => { setPage(1); setReminderDue(!reminderDue); }}>
            {reminderDue ? "✓ " : ""}Erinnerung fällig
          </Button>
          {(search || campaignStatus || deliveryStatus || invitationStatus || reminderDue) && (
            <Button variant="secondary" onClick={() => { setPage(1); setSearch(""); setCampaignStatus(""); setDeliveryStatus(""); setInvitationStatus(""); setReminderDue(false); }}>Filter zurücksetzen</Button>
          )}
        </div>
        {reminderDue && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-hover px-4 py-3 text-sm">
            <span>
              {total === 0
                ? "Aktuell ist keine Erinnerung fällig."
                : `${total} Kunde(n) ohne bestätigte Bewertung, bei denen der Mindestabstand zur letzten E-Mail erreicht ist. Bitte vorher prüfen, ob schon bewertet wurde – bestätigte Bewertungen über „Bewertung bestätigen“ in der Bestellung eintragen.`}
            </span>
            {rows.length > 0 && (
              <Button
                disabled={busy}
                onClick={() =>
                  scheduleReminders(
                    rows.filter((r) => r.reminderDue && r.campaignId).map((r) => r.campaignId!),
                    `Erinnerung an ${rows.filter((r) => r.reminderDue).length} angezeigte Kunden einplanen?

Bestätigung: Diese Kunden haben laut meiner Prüfung noch keine Bewertung abgegeben.`,
                  )
                }
              >
                Alle {rows.filter((r) => r.reminderDue).length} angezeigten einplanen
              </Button>
            )}
          </div>
        )}
        <Table
          head={[
            header("Bestellung", "name"),
            header("Kunde", "customer"),
            header("Bestelldatum", "orderCreatedAt"),
            header("Versand", "carrier"),
            header("Tracking", "hasTracking"),
            header("Zustellung", "deliveryStatus"),
            header("Versandregel", "shippingRule"),
            header("Plattform", "platform"),
            header("1. Einladung", "invite1"),
            header("2. Einladung", "invite2"),
            header("3. Einladung", "invite3"),
            header("Bewertung", "reviewStatus"),
            header("Kampagne", "campaignStatus"),
            "Erinnerung",
          ]}
        >
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
                <Td>
                  {r.reminderDue && r.campaignId ? (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      title={`Letzte E-Mail am ${fmtDate(r.reminderDue.lastSentAt)}`}
                      onClick={() => scheduleReminders([r.campaignId!], `Erinnerung (${r.reminderDue!.step}. Kontakt) an ${r.customer ?? r.name} einplanen?

Bestätigung: Dieser Kunde hat laut meiner Prüfung noch keine Bewertung abgegeben.`)}
                    >
                      {r.reminderDue.step}. Mail senden
                    </Button>
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </Td>
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
