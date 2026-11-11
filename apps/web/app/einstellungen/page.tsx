"use client";
import { useEffect, useState } from "react";
import { PageTitle, Shell } from "@/components/Shell";
import { Badge, Button, Card, ErrorText, Input, Label, Notice, Select, Table, Td } from "@/components/ui";
import { api, CHANNELS, fmtDate } from "@/lib/api";

interface Settings {
  firstRequestDaysAfterDelivery: number;
  fallbackDaysAfterOrder: number;
  reminderIntervalDays: number;
  maxAttempts: number;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  timezone: string;
  dailySendLimit: number;
  freightPatterns: string[];
  legalBasis: "NONE" | "CONSENT" | "UWG_7_3";
  remindersOnUnknownStatus: boolean;
  includeRefundedOrders: boolean;
  uwgNoticeConfirmedAt: string | null;
  considerJudgemeInvitations: boolean;
  testRecipients: string[];
  sendingEnabled: boolean;
  blockedReason: string | null;
}
interface Checklist {
  items: { label: string; ok: boolean; blocking: boolean }[];
  judgemeWarning: string;
  released: boolean;
  releasedAt: string | null;
  releasedBy: string | null;
}
interface Integrations {
  shopify: { configured: boolean; domain: string | null; apiVersion: string };
  email: { transport: string; from: string | null; allowCustomerEmails: boolean };
  judgeme: { status: string; statusDetail: string | null; lastCheckedAt: string | null; capabilities: { readReviews: boolean; readInvitations: boolean; webhooks: boolean } };
}
interface Mapping {
  id: string;
  field: string;
  pattern: string;
  channel: string;
  priority: number;
}

const LEGAL: Record<string, string> = {
  NONE: "Nicht festgelegt – kein Versand",
  CONSENT: "Ausdrückliche Einwilligung (§ 7 Abs. 2 Nr. 2 UWG)",
  UWG_7_3: "Bestandskundenausnahme (§ 7 Abs. 3 UWG)",
};

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [check, setCheck] = useState<Checklist | null>(null);
  const [integ, setInteg] = useState<Integrations | null>(null);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [ack, setAck] = useState(false);
  const [uwgAck, setUwgAck] = useState(false);
  const [jm, setJm] = useState({ shopDomain: "", apiToken: "" });
  const [newMap, setNewMap] = useState({ field: "utm_source", pattern: "", channel: "IDEALO", priority: 15 });

  async function load() {
    const [a, b, c, d] = await Promise.all([api<Settings>("/api/settings"), api<Checklist>("/api/release-checklist"), api<Integrations>("/api/integrations"), api<Mapping[]>("/api/channel-mappings")]);
    setS(a);
    setCheck(b);
    setInteg(c);
    setMappings(d);
  }
  useEffect(() => {
    void load();
  }, []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMsg(null);
    try {
      const r = await fn();
      setMsg(typeof r === "object" && r && "detail" in r ? String((r as { detail: string }).detail) : ok);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!s || !check || !integ) return <Shell><p className="text-sm text-muted">Lade …</p></Shell>;
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });
  const { blockedReason, sendingEnabled, uwgNoticeConfirmedAt, ...editable } = s;
  void blockedReason;
  void sendingEnabled;
  void uwgNoticeConfirmedAt;
  const needsUwg = s.legalBasis === "UWG_7_3";

  return (
    <Shell>
      <PageTitle title="Einstellungen & Freigabe" />
      {(msg || error) && (
        <div className="mb-4">
          {msg && <Notice tone="green">{msg}</Notice>}
          <ErrorText error={error} />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Produktivfreigabe" description="Vor dem ersten Versand an echte Kunden ist eine ausdrückliche Freigabe nötig." actions={check.released ? <Badge tone="green">freigegeben</Badge> : <Badge tone="amber">gesperrt</Badge>}>
          <ul className="mb-4 space-y-1 text-sm">
            {check.items.map((i) => (
              <li key={i.label} className="flex gap-2">
                <span className={i.ok ? "text-emerald-600" : i.blocking ? "text-red-600" : "text-amber-600"}>{i.ok ? "✔" : "✘"}</span>
                {i.label}
                {!i.blocking && <span className="text-muted">(optional)</span>}
              </li>
            ))}
          </ul>
          <Notice title="Judge.me läuft parallel">{check.judgemeWarning}</Notice>
          {check.released ? (
            <div className="mt-4 flex items-center gap-3">
              <p className="text-sm text-muted">Freigegeben am {fmtDate(check.releasedAt, true)} von {check.releasedBy}</p>
              <Button variant="danger" onClick={() => run(() => api("/api/settings/stop", { method: "POST" }), "Versand gestoppt")}>Versand stoppen</Button>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" />
                Mir ist bewusst, dass Kunden parallel Judge.me-Anfragen erhalten können, und die Rechtsgrundlage ist geprüft.
              </label>
              {needsUwg && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={uwgAck} onChange={(e) => setUwgAck(e.target.checked)} className="mt-1" />
                  Kunden werden bei der Bestellung (Checkout bzw. Datenschutzerklärung) klar darauf hingewiesen, dass sie der Nutzung ihrer E-Mail-Adresse für Bewertungsanfragen jederzeit widersprechen können.
                </label>
              )}
              <div className="flex gap-2">
                <Input placeholder="VERSAND FREIGEBEN" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} className="max-w-xs" />
                <Button disabled={!ack || (needsUwg && !uwgAck) || confirmation !== "VERSAND FREIGEBEN"} onClick={() => run(() => api("/api/settings/release", { method: "POST", body: { confirmation, acknowledgeJudgemeParallel: ack, confirmUwgNotice: uwgAck } }), "Versand freigegeben")}>
                  Freigeben
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card title="Rechtsgrundlage & Einwilligung" description="Bewertungsanfragen per E-Mail gelten als Werbung (BGH, VI ZR 225/17). Keine Rechtsberatung – vor Aktivierung prüfen lassen.">
          <label className="block">
            <Label>Rechtsgrundlage</Label>
            <Select value={s.legalBasis} onChange={(e) => setS({ ...s, legalBasis: e.target.value as Settings["legalBasis"] })} className="w-full">
              {Object.entries(LEGAL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </label>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Einwilligung: Versand nur bei dokumentierter Einwilligung (Shopify-Marketingeinwilligung oder manuell erfasst).</li>
            <li>§ 7 Abs. 3 UWG: Hinweis auf das Widerspruchsrecht bei Erhebung der Adresse (Checkout/Datenschutzerklärung) und in jeder E-Mail (automatisch).</li>
            <li>Ein Wechsel der Rechtsgrundlage sperrt den Versand bis zur erneuten Freigabe.</li>
          </ul>
          {s.legalBasis === "CONSENT" && (
            <div className="mt-3">
              <Notice>Mit „Einwilligung“ erhalten nur Kunden mit dokumentierter Einwilligung eine Anfrage – bei Adfunture derzeit etwa 1 von 100 Bestellungen. Für eine Anfrage an jede Bestellung ist § 7 Abs. 3 UWG nötig.</Notice>
            </div>
          )}
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={s.includeRefundedOrders} onChange={(e) => setS({ ...s, includeRefundedOrders: e.target.checked })} className="mt-1" />
            Auch erstattete und retournierte Bestellungen anfragen (Kunde hat die Ware erhalten; vermeidet selektives Auslassen unzufriedener Kunden). Stornierte, nie versendete Bestellungen erhalten keine Anfrage.
          </label>
          <label className="mt-2 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={s.remindersOnUnknownStatus} onChange={(e) => setS({ ...s, remindersOnUnknownStatus: e.target.checked })} className="mt-1" />
            Erinnerungen auch bei unbekanntem Bewertungsstatus senden (nur aktivieren, wenn technisch, rechtlich und nach Plattformregeln ausdrücklich zulässig)
          </label>
          <label className="mt-2 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={s.considerJudgemeInvitations} onChange={(e) => setS({ ...s, considerJudgemeInvitations: e.target.checked })} className="mt-1" />
            Judge.me-Einladungen berücksichtigen (vorhandene Judge.me-Bewertung beendet die Kampagne)
          </label>
        </Card>

        <Card title="Versandregeln">
          <div className="grid gap-3 sm:grid-cols-2">
            <label><Label hint="3–5">Erste Anfrage nach Zustellung (Tage)</Label><Input type="number" min={3} max={5} value={s.firstRequestDaysAfterDelivery} onChange={num("firstRequestDaysAfterDelivery")} /></label>
            <label><Label>Ohne Tracking: Tage nach Bestellung</Label><Input type="number" min={7} max={30} value={s.fallbackDaysAfterOrder} onChange={num("fallbackDaysAfterOrder")} /></label>
            <label><Label>Abstand zwischen Erinnerungen (Tage)</Label><Input type="number" min={1} max={14} value={s.reminderIntervalDays} onChange={num("reminderIntervalDays")} /></label>
            <label><Label>Maximale Kontaktversuche</Label><Input type="number" min={1} max={3} value={s.maxAttempts} onChange={num("maxAttempts")} /></label>
            <label><Label>Versandfenster ab (Uhr)</Label><Input type="number" min={0} max={23} value={s.sendWindowStartHour} onChange={num("sendWindowStartHour")} /></label>
            <label><Label>Versandfenster bis (Uhr)</Label><Input type="number" min={1} max={24} value={s.sendWindowEndHour} onChange={num("sendWindowEndHour")} /></label>
            <label><Label>Zeitzone</Label><Input value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} /></label>
            <label><Label>Versandlimit pro Tag</Label><Input type="number" min={1} value={s.dailySendLimit} onChange={num("dailySendLimit")} /></label>
            <label className="sm:col-span-2"><Label hint="kommagetrennt, in Versender oder Versandart">Speditions-Kennungen</Label><Input value={s.freightPatterns.join(", ")} onChange={(e) => setS({ ...s, freightPatterns: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
            <label className="sm:col-span-2"><Label hint="kommagetrennt, max. 10">Testempfänger</Label><Input value={s.testRecipients.join(", ")} onChange={(e) => setS({ ...s, testRecipients: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
          </div>
          <Button className="mt-4" onClick={() => run(() => api("/api/settings", { method: "PUT", body: editable }), "Einstellungen gespeichert")}>Einstellungen speichern</Button>
        </Card>

        <Card title="Integrationen">
          <dl className="grid grid-cols-[9rem_1fr] gap-2 text-sm">
            <dt className="text-muted">Shopify</dt>
            <dd>{integ.shopify.configured ? <>{integ.shopify.domain} · API {integ.shopify.apiVersion}</> : <Badge tone="red">nicht konfiguriert</Badge>}</dd>
            <dt className="text-muted">E-Mail</dt>
            <dd>{integ.email.transport === "smtp" ? `SMTP · ${integ.email.from}` : "Nur Protokoll (kein Versand)"} {integ.email.allowCustomerEmails ? <Badge tone="green">Kundenversand erlaubt</Badge> : <Badge>Kundenversand serverseitig gesperrt</Badge>}</dd>
            <dt className="text-muted">Judge.me</dt>
            <dd>
              <Badge tone={integ.judgeme.status === "OK" ? "green" : integ.judgeme.status === "ERROR" ? "red" : "gray"}>{integ.judgeme.status === "OK" ? "Bewertungen abrufbar" : integ.judgeme.status === "ERROR" ? "Fehler" : "nicht verbunden"}</Badge>
              {integ.judgeme.statusDetail && <span className="block text-xs text-muted">{integ.judgeme.statusDetail}</span>}
              <span className="block text-xs text-muted">Einladungen synchronisierbar: nein (keine API) · Webhooks: nein</span>
            </dd>
          </dl>
          {integ.shopify.configured && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => run(() => api("/api/integrations/shopify/test", { method: "POST" }), "Shopify-Verbindung OK")}>Shopify testen</Button>
              <Button variant="secondary" onClick={() => run(() => api("/api/integrations/shopify/register-webhooks", { method: "POST" }), "Webhooks geprüft/angelegt")}>Webhooks registrieren</Button>
            </div>
          )}
          <div className="mt-4 grid gap-2 border-t border-border pt-4 sm:grid-cols-2">
            <label><Label>Judge.me Shop-Domain</Label><Input placeholder="xyz.myshopify.com" value={jm.shopDomain} onChange={(e) => setJm({ ...jm, shopDomain: e.target.value })} /></label>
            <label><Label hint="Settings → Integrations → View API tokens">Private API Token</Label><Input type="password" value={jm.apiToken} onChange={(e) => setJm({ ...jm, apiToken: e.target.value })} /></label>
            <div className="flex gap-2 sm:col-span-2">
              <Button variant="secondary" disabled={!jm.shopDomain || !jm.apiToken} onClick={() => run(() => api("/api/integrations/judgeme", { method: "PUT", body: jm }), "Gespeichert")}>Speichern & testen</Button>
              <Button variant="ghost" onClick={() => run(() => api("/api/integrations/judgeme/test", { method: "POST" }), "Getestet")}>Erneut testen</Button>
            </div>
          </div>
        </Card>

        <Card title="Herkunftskanäle (Mapping)" description="Regeln werden nach Priorität geprüft. Ohne Treffer: „Unbekannt“." className="xl:col-span-2">
          <Table head={["Feld", "enthält", "Kanal", "Priorität", ""]}>
            {mappings.map((m) => (
              <tr key={m.id}>
                <Td>{m.field}</Td>
                <Td>{m.pattern}</Td>
                <Td>{CHANNELS[m.channel]}</Td>
                <Td>{m.priority}</Td>
                <Td><Button variant="ghost" onClick={() => run(() => api(`/api/channel-mappings/${m.id}`, { method: "DELETE" }), "Regel gelöscht")}>Löschen</Button></Td>
              </tr>
            ))}
          </Table>
          <div className="mt-3 flex flex-wrap gap-2">
            <Select value={newMap.field} onChange={(e) => setNewMap({ ...newMap, field: e.target.value })}>
              {["utm_source", "utm_medium", "referrer_host", "landing_page", "source_name"].map((f) => <option key={f}>{f}</option>)}
            </Select>
            <Input placeholder="enthält …" value={newMap.pattern} onChange={(e) => setNewMap({ ...newMap, pattern: e.target.value })} className="w-40" />
            <Select value={newMap.channel} onChange={(e) => setNewMap({ ...newMap, channel: e.target.value })}>
              {Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Input type="number" value={newMap.priority} onChange={(e) => setNewMap({ ...newMap, priority: Number(e.target.value) })} className="w-24" />
            <Button variant="secondary" disabled={newMap.pattern.length < 2} onClick={() => run(() => api("/api/channel-mappings", { method: "POST", body: newMap }), "Regel angelegt")}>Hinzufügen</Button>
          </div>
        </Card>
      </div>
    </Shell>
  );
}
