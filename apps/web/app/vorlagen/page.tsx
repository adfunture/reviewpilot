"use client";
import { useEffect, useState } from "react";
import { PageTitle, Shell } from "@/components/Shell";
import { Button, Card, ErrorText, Input, Label, Notice, Select, Textarea } from "@/components/ui";
import { api } from "@/lib/api";

interface Template {
  id: string;
  scope: string;
  step: number;
  subject: string;
  bodyText: string;
}

const STEP_LABEL = ["", "Erste Anfrage", "Erste Erinnerung", "Letzte Erinnerung"];
const SCOPE_LABEL: Record<string, string> = { default: "Standard (alle Plattformen)", GOOGLE_BUSINESS: "Google-Unternehmensprofil", IDEALO: "idealo", TRUSTED_SHOPS: "Trusted Shops", TRUSTPILOT: "Trustpilot" };

function Editor({ t, onSaved }: { t: Template; onSaved: () => void }) {
  const [subject, setSubject] = useState(t.subject);
  const [body, setBody] = useState(t.bodyText);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card title={`Stufe ${t.step} – ${STEP_LABEL[t.step]}`} description={t.scope === "default" ? "Wird genutzt, wenn eine Plattform keine eigene Vorlage hat" : `Nur für ${SCOPE_LABEL[t.scope] ?? t.scope}`}>
      <label className="block">
        <Label>Betreff</Label>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="mt-3 block">
        <Label hint="Platzhalter: {{first_name}}, {{review_link}}, {{order_name}}, {{shop_name}}">Text</Label>
        <Textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className="mt-2 text-xs text-muted">Abmeldelink, Widerspruchshinweis und Absender werden automatisch angehängt.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => run(async () => { await api("/api/templates", { method: "PUT", body: { scope: t.scope, step: t.step, subject, bodyText: body } }); onSaved(); }, "Gespeichert")}>Speichern</Button>
        <Button variant="secondary" onClick={() => run(async () => setPreview(await api("/api/templates/preview", { method: "POST", body: { subject, bodyText: body } })), "")}>Vorschau</Button>
        <Input placeholder="Testempfänger" value={testTo} onChange={(e) => setTestTo(e.target.value)} className="w-56" />
        <Button variant="secondary" disabled={!testTo} onClick={() => run(() => api("/api/test-email", { method: "POST", body: { to: testTo, step: t.step } }), "Test-E-Mail verschickt (gespeicherte Version)")}>
          Test-E-Mail
        </Button>
        {msg && <span className="text-sm text-emerald-600">{msg}</span>}
      </div>
      <ErrorText error={error} />
      {preview && (
        <div className="mt-4 rounded-md border border-border">
          <p className="border-b border-border px-3 py-2 text-sm font-medium">{preview.subject}</p>
          <iframe title="Vorschau" sandbox="" srcDoc={preview.html} className="h-96 w-full bg-white" />
        </div>
      )}
    </Card>
  );
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [scope, setScope] = useState("GOOGLE_BUSINESS");
  const load = () => api<Template[]>("/api/templates").then(setTemplates);
  useEffect(() => {
    void load();
  }, []);
  const scopes = Array.from(new Set(["default", ...templates.map((t) => t.scope)]));
  const shown = templates.filter((t) => t.scope === scope);

  return (
    <Shell>
      <PageTitle title="E-Mail-Vorlagen" description="Keine Anreize (Gutscheine, Gewinnspiele) und keine Bitte um positive Bewertungen – solche Formulierungen werden beim Speichern abgelehnt. Plattform-Vorlagen haben Vorrang vor der Standardvorlage." />
      <div className="mb-4 flex items-center gap-2">
        <Label>Vorlagensatz</Label>
        <Select value={scope} onChange={(e) => setScope(e.target.value)}>
          {scopes.map((s) => (
            <option key={s} value={s}>{SCOPE_LABEL[s] ?? s}</option>
          ))}
        </Select>
      </div>
      <div className="mb-4">
        <Notice tone="blue">Test-E-Mails gehen nur an Adressen, die unter „Einstellungen → Testempfänger“ hinterlegt sind – nie an Kundenadressen.</Notice>
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        {shown.map((t) => (
          <Editor key={t.id} t={t} onSaved={load} />
        ))}
      </div>
    </Shell>
  );
}
