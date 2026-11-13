"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { PageTitle, Shell } from "@/components/Shell";
import { Badge, Button, Card, ErrorText, Input, Label, Notice, Table, Td } from "@/components/ui";
import { api, CAMPAIGN_STATUS, CHANNELS, DELIVERY_STATUS, fmtDate, INVITATION_STATUS, REVIEW_STATUS, RULES } from "@/lib/api";

interface Detail {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  orderCreatedAt: string;
  totalPrice: string;
  currency: string;
  channel: string;
  channelMethod: string | null;
  channelConfidence: string;
  deliveryStatus: string;
  deliverySource: string | null;
  deliveredAt: string | null;
  carrier: string | null;
  isFreight: boolean;
  hasTracking: boolean;
  reviewBlocked: boolean;
  reviewBlockedReason: string | null;
  email: string | null;
  customerSuppressed: boolean;
  items: { id: string; title: string; quantity: number; sku: string | null }[];
  attribution: { utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; referrerUrl: string | null; landingPage: string | null } | null;
  fulfillments: { id: string; carrier: string | null; trackingNumber: string | null; trackingUrl: string | null; displayStatus: string | null; shippedAt: string; trackingEvents: { id: string; status: string; happenedAt: string; source: string; message: string | null }[] }[];
  campaign: {
    id: string;
    status: string;
    statusReason: string | null;
    shippingRule: string | null;
    anchorAt: string | null;
    reviewStatus: string;
    platform: { name: string } | null;
    invitations: { id: string; step: number; manual: boolean; status: string; statusReason: string | null; scheduledAt: string; sentAt: string | null; attempts: number; lastError: string | null; clickCount: number; emailEvents: { id: string; type: string; detail: string | null; occurredAt: string }[] }[];
  } | null;
  reviewEvents: { id: string; type: string; rating: number | null; occurredAt: string }[];
}

function OrderDetail() {
  const id = useSearchParams().get("id");
  const [o, setO] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deliveredAt, setDeliveredAt] = useState("");
  const [reschedule, setReschedule] = useState<Record<string, string>>({});
  const [reminder, setReminder] = useState<{ ok: boolean; reason?: string; step?: number; earliest?: string } | null>(null);
  const [confirmNoReview, setConfirmNoReview] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const d = await api<Detail>(`/api/orders/${id}`);
    setO(d);
    setReminder(d.campaign ? await api(`/api/campaigns/${d.campaign.id}/manual-reminder`) : null);
    setConfirmNoReview(false);
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(path: string, body?: unknown, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setError(null);
    try {
      await api(path, { method: "POST", body: body ?? {} });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!o) return <p className="text-sm text-muted">Lade …</p>;
  const c = o.campaign;
  const cs = c ? CAMPAIGN_STATUS[c.status] : null;
  const open = c && ["PENDING", "SCHEDULED", "ACTIVE", "PAUSED", "CONSENT_MISSING"].includes(c.status);

  return (
    <>
      <PageTitle title={`Bestellung ${o.name}`} description={`${[o.firstName, o.lastName].filter(Boolean).join(" ") || "Kunde unbekannt"} · ${fmtDate(o.orderCreatedAt, true)} · ${Number(o.totalPrice).toLocaleString("de-DE", { style: "currency", currency: o.currency })}`} />
      <ErrorText error={error} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Sperre" description="Gesperrte Bestellungen bzw. Kunden erhalten keine Bewertungsanfragen und keine Erinnerungen.">
          {o.customerSuppressed && <Notice tone="gray">Kunde ist dauerhaft gesperrt (Abmeldung, Widerspruch oder manuelle Sperre) – gilt für alle Bestellungen dieser E-Mail-Adresse.</Notice>}
          {o.reviewBlocked && <Notice tone="gray">Diese Bestellung ist gesperrt: {o.reviewBlockedReason}</Notice>}
          <div className="mt-3 flex flex-wrap gap-2">
            {o.reviewBlocked ? (
              <Button variant="secondary" onClick={() => act(`/api/orders/${o.id}/unblock`, {}, "Sperre aufheben? Die Bestellung wird nach den aktuellen Regeln neu geplant (keine rückwirkende Versendung).")}>
                Sperre aufheben
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={() => {
                  const reason = window.prompt("Grund der Sperre für diese Bestellung (z. B. Kundenwunsch, Reklamation in Klärung). Hinweis: Keine Sperre nur wegen erwarteter Unzufriedenheit.");
                  if (reason && reason.trim().length >= 3) void act(`/api/orders/${o.id}/block`, { reason: reason.trim() });
                }}
              >
                Diese Bestellung sperren
              </Button>
            )}
            {!o.customerSuppressed && o.email && (
              <Button
                variant="danger"
                onClick={() => act("/api/suppressions", { email: o.email, reason: "MANUAL" }, `Kunde ${o.email} dauerhaft sperren? Er erhält für keine Bestellung mehr Bewertungsanfragen. Aufheben ist nur über „Datenschutz & System“ möglich.`)}
              >
                Kunde dauerhaft sperren
              </Button>
            )}
          </div>
        </Card>

        <Card
          title="Bewertungskampagne"
          actions={cs && <Badge tone={cs.tone}>{cs.label}</Badge>}
          description={c?.statusReason ?? undefined}
        >
          {!c ? (
            <p className="text-sm text-muted">Noch keine Kampagne – wird beim nächsten Planungslauf angelegt.</p>
          ) : (
            <>
              <dl className="mb-4 grid grid-cols-2 gap-2 text-sm">
                <dt className="text-muted">Versandregel</dt>
                <dd>{c.shippingRule ? RULES[c.shippingRule] : "–"}</dd>
                <dt className="text-muted">Bezugsdatum</dt>
                <dd>{fmtDate(c.anchorAt)}</dd>
                <dt className="text-muted">Plattform</dt>
                <dd>{c.platform?.name ?? "–"}</dd>
                <dt className="text-muted">Bewertungsstatus</dt>
                <dd>{REVIEW_STATUS[c.reviewStatus]}</dd>
              </dl>
              <Table head={["Stufe", "Status", "Zeitpunkt", "Klicks", "Verlauf", ""]}>
                {c.invitations.map((i) => (
                  <tr key={i.id}>
                    <Td>{i.step}{i.manual && <span className="block text-xs text-muted">manuell</span>}</Td>
                    <Td>
                      {INVITATION_STATUS[i.status]}
                      {i.statusReason && <span className="block text-xs text-muted">{i.statusReason}</span>}
                      {i.lastError && <span className="block text-xs text-red-600">{i.lastError}</span>}
                    </Td>
                    <Td>{fmtDate(i.sentAt ?? i.scheduledAt, true)}</Td>
                    <Td>{i.clickCount}</Td>
                    <Td>
                      {i.emailEvents.map((e) => (
                        <span key={e.id} className="block text-xs">{fmtDate(e.occurredAt, true)} {e.type}</span>
                      ))}
                    </Td>
                    <Td>
                      {i.status === "SCHEDULED" && (
                        <div className="flex gap-1">
                          <Input type="datetime-local" className="w-auto" value={reschedule[i.id] ?? ""} onChange={(e) => setReschedule({ ...reschedule, [i.id]: e.target.value })} aria-label="Neuer Zeitpunkt" />
                          <Button variant="secondary" disabled={!reschedule[i.id]} onClick={() => act(`/api/invitations/${i.id}/reschedule`, { scheduledAt: new Date(reschedule[i.id]!).toISOString() })}>
                            Verschieben
                          </Button>
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
              {reminder && (
                <div className="mt-4 rounded-md border border-border p-3">
                  <p className="text-sm font-medium">Manuelle Erinnerung</p>
                  {reminder.ok ? (
                    <>
                      <p className="mt-1 text-xs text-muted">
                        Automatisch wird nur eine Anfrage versendet. Eine Erinnerung (Stufe {reminder.step}) geht frühestens {fmtDate(reminder.earliest, true)} im Versandfenster raus – mit allen Prüfungen (Abmeldung, Storno, Freigabe).
                      </p>
                      <label className="mt-2 flex items-start gap-2 text-sm">
                        <input type="checkbox" checked={confirmNoReview} onChange={(e) => setConfirmNoReview(e.target.checked)} className="mt-1" />
                        Ich habe geprüft, dass dieser Kunde noch keine Bewertung abgegeben hat.
                      </label>
                      <Button className="mt-2" variant="secondary" disabled={!confirmNoReview} onClick={() => act(`/api/campaigns/${c.id}/manual-reminder`, { confirmNoReview: true })}>
                        Erinnerung einplanen
                      </Button>
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-muted">Nicht möglich: {reminder.reason}</p>
                  )}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {c.status === "PAUSED" ? (
                  <Button onClick={() => act(`/api/campaigns/${c.id}/resume`)}>Fortsetzen</Button>
                ) : (
                  open && <Button variant="secondary" onClick={() => act(`/api/campaigns/${c.id}/pause`)}>Pausieren</Button>
                )}
                {open && <Button variant="danger" onClick={() => act(`/api/campaigns/${c.id}/cancel`, {}, "Kampagne endgültig abbrechen?")}>Abbrechen</Button>}
                {open && <Button variant="secondary" onClick={() => act(`/api/orders/${o.id}/mark-reviewed`, {}, "Bewertung wurde nachweislich abgegeben?")}>Bewertung bestätigen</Button>}
              </div>
            </>
          )}
        </Card>

        <Card title="Versand & Zustellung" description={`${DELIVERY_STATUS[o.deliveryStatus]}${o.deliveredAt ? ` am ${fmtDate(o.deliveredAt)}` : ""}${o.deliverySource === "MANUAL" ? " (manuell bestätigt)" : ""}`}>
          {o.fulfillments.length === 0 && <p className="text-sm text-muted">Noch nicht versendet.</p>}
          {o.fulfillments.map((f) => (
            <div key={f.id} className="mb-3 text-sm">
              <p>
                {f.carrier ?? "Unbekannter Versender"} {o.isFreight && <Badge tone="amber">Spedition</Badge>} · versendet {fmtDate(f.shippedAt)}
                {f.trackingUrl ? (
                  <a href={f.trackingUrl} target="_blank" rel="noreferrer" className="ml-2 underline">Tracking</a>
                ) : (
                  <span className="ml-2 text-muted">kein Trackinglink</span>
                )}
              </p>
              <ul className="mt-1 text-xs text-muted">
                {f.trackingEvents.map((e) => (
                  <li key={e.id}>{fmtDate(e.happenedAt, true)} · {e.status} · {e.source}{e.message ? ` · ${e.message}` : ""}</li>
                ))}
              </ul>
            </div>
          ))}
          {o.fulfillments.length > 0 && o.deliveryStatus !== "DELIVERED" && (
            <div className="mt-4 border-t border-border pt-4">
              <Label hint="nur bei nachweislicher Zustellung (z. B. Speditions-Abliefernachweis)">Zustellung manuell bestätigen</Label>
              <div className="flex gap-2">
                <Input type="date" className="w-auto" value={deliveredAt} onChange={(e) => setDeliveredAt(e.target.value)} />
                <Button variant="secondary" disabled={!deliveredAt} onClick={() => act(`/api/orders/${o.id}/confirm-delivery`, { deliveredAt: new Date(`${deliveredAt}T12:00:00`).toISOString() })}>
                  Bestätigen
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card title="Herkunft" description={`${CHANNELS[o.channel]} · Methode: ${o.channelMethod ?? "–"} · Zuverlässigkeit: ${o.channelConfidence}`}>
          {o.attribution ? (
            <dl className="grid grid-cols-[8rem_1fr] gap-1 text-sm">
              <dt className="text-muted">utm_source</dt><dd>{o.attribution.utmSource ?? "–"}</dd>
              <dt className="text-muted">utm_medium</dt><dd>{o.attribution.utmMedium ?? "–"}</dd>
              <dt className="text-muted">utm_campaign</dt><dd>{o.attribution.utmCampaign ?? "–"}</dd>
              <dt className="text-muted">Referrer</dt><dd className="break-all">{o.attribution.referrerUrl ?? "–"}</dd>
              <dt className="text-muted">Landingpage</dt><dd className="break-all">{o.attribution.landingPage ?? "–"}</dd>
            </dl>
          ) : (
            <p className="text-sm text-muted">Keine Attributionsdaten von Shopify.</p>
          )}
        </Card>

        <Card title="Artikel">
          <ul className="mb-4 text-sm">
            {o.items.map((i) => (
              <li key={i.id}>{i.quantity} × {i.title} <span className="text-muted">{i.sku}</span></li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

export default function OrderPage() {
  return (
    <Shell>
      <Suspense fallback={<p className="text-sm text-muted">Lade …</p>}>
        <OrderDetail />
      </Suspense>
    </Shell>
  );
}
