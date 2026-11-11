"use client";
import { useEffect, useState } from "react";
import { PageTitle, Shell } from "@/components/Shell";
import { Button, Card, ErrorText, Input, Label, Select, Table, Td } from "@/components/ui";
import { api, fmtDate } from "@/lib/api";

interface Jobs {
  counts: Record<string, number>;
  dead: { id: string; type: string; lastError: string | null; finishedAt: string | null; attempts: number }[];
}
interface AuditRow {
  id: string;
  actor: string;
  action: string;
  entity: string | null;
  createdAt: string;
}
interface Suppression {
  id: string;
  email: string;
  reason: string;
  createdAt: string;
}

const REASON: Record<string, string> = { UNSUBSCRIBED: "ausgetragen (Link)", OBJECTION: "Widerspruch", HARD_BOUNCE: "unzustellbar", COMPLAINT: "Spam-Beschwerde", MANUAL: "manuell gesperrt" };

export default function SystemPage() {
  const [jobs, setJobs] = useState<Jobs | null>(null);
  const [auditRows, setAudit] = useState<AuditRow[]>([]);
  const [supp, setSupp] = useState<Suppression[]>([]);
  const [email, setEmail] = useState("");
  const [consentEmail, setConsentEmail] = useState("");
  const [consentStatus, setConsentStatus] = useState("GRANTED");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const [j, a, s] = await Promise.all([api<Jobs>("/api/jobs"), api<AuditRow[]>("/api/audit"), api<Suppression[]>("/api/suppressions")]);
    setJobs(j);
    setAudit(a);
    setSupp(s);
  }
  useEffect(() => {
    void load();
  }, []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function exportData() {
    await run(async () => {
      const data = await api(`/api/gdpr/export?email=${encodeURIComponent(email)}`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `datenauskunft-${Date.now()}.json`;
      a.click();
    }, "Export erstellt");
  }

  return (
    <Shell>
      <PageTitle title="Datenschutz & System" />
      {msg && <p className="mb-2 text-sm text-emerald-600">{msg}</p>}
      <ErrorText error={error} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Betroffenenrechte (DSGVO)" description="Auskunft (Art. 15) und Löschung (Art. 17) zu einer E-Mail-Adresse.">
          <Label>E-Mail-Adresse</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" disabled={!email} onClick={exportData}>Daten exportieren</Button>
            <Button variant="secondary" disabled={!email} onClick={() => run(() => api("/api/suppressions", { method: "POST", body: { email, reason: "OBJECTION" } }), "Widerspruch erfasst")}>Widerspruch erfassen</Button>
            <Button
              variant="danger"
              disabled={!email}
              onClick={() => window.confirm("Personenbezogene Daten dieser Adresse unwiderruflich löschen?") && run(() => api("/api/gdpr/delete", { method: "POST", body: { email, confirm: true } }), "Daten gelöscht")}
            >
              Daten löschen
            </Button>
          </div>
        </Card>

        <Card title="Einwilligung erfassen" description="Z. B. aus einer Checkout-Checkbox oder schriftlichen Einwilligung.">
          <div className="flex flex-wrap gap-2">
            <Input type="email" placeholder="E-Mail" value={consentEmail} onChange={(e) => setConsentEmail(e.target.value)} className="max-w-xs" />
            <Select value={consentStatus} onChange={(e) => setConsentStatus(e.target.value)}>
              <option value="GRANTED">erteilt</option>
              <option value="REVOKED">widerrufen</option>
            </Select>
            <Button variant="secondary" disabled={!consentEmail} onClick={() => run(() => api("/api/consents", { method: "POST", body: { email: consentEmail, status: consentStatus } }), "Einwilligung gespeichert")}>Speichern</Button>
          </div>
        </Card>

        <Card title="Hintergrundjobs" description="Persistente Queue in PostgreSQL. Endgültig fehlgeschlagene Jobs (Dead Letter) können erneut gestartet werden.">
          <p className="mb-3 text-sm">{jobs && Object.entries(jobs.counts).map(([k, v]) => `${k}: ${v}`).join(" · ")}</p>
          <Table head={["Typ", "Fehler", "Zeit", ""]}>
            {jobs?.dead.map((j) => (
              <tr key={j.id}>
                <Td>{j.type}</Td>
                <Td className="max-w-xs break-words text-xs">{j.lastError}</Td>
                <Td>{fmtDate(j.finishedAt, true)}</Td>
                <Td><Button variant="ghost" onClick={() => run(() => api(`/api/jobs/${j.id}/retry`, { method: "POST" }), "Job neu eingeplant")}>Erneut</Button></Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Sperrliste" description="Ausgetragene, widersprochene und unzustellbare Adressen – diese Kontakte werden dauerhaft ignoriert, auch bei neuen Bestellungen.">
          <Table head={["E-Mail", "Grund", "Seit"]}>
            {supp.slice(0, 50).map((s) => (
              <tr key={s.id}><Td>{s.email.startsWith("sha256:") ? <span className="text-muted">gelöschte Adresse (nur Hash gespeichert)</span> : s.email}</Td><Td>{REASON[s.reason] ?? s.reason}</Td><Td>{fmtDate(s.createdAt)}</Td></tr>
            ))}
          </Table>
        </Card>

        <Card title="Audit-Log" className="xl:col-span-2">
          <Table head={["Zeit", "Wer", "Aktion", "Objekt"]}>
            {auditRows.map((a) => (
              <tr key={a.id}><Td>{fmtDate(a.createdAt, true)}</Td><Td>{a.actor}</Td><Td>{a.action}</Td><Td>{a.entity ?? ""}</Td></tr>
            ))}
          </Table>
        </Card>
      </div>
    </Shell>
  );
}
