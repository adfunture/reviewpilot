"use client";
import { useEffect, useState } from "react";
import { PageTitle, Shell } from "@/components/Shell";
import { Badge, Button, Card, ErrorText, Input, Label, Notice, Textarea } from "@/components/ui";
import { api, CHANNELS } from "@/lib/api";

interface Platform {
  id: string;
  key: string;
  name: string;
  active: boolean;
  reviewUrl: string | null;
  integrationType: "LINK" | "API" | "EXTERNAL_PROGRAM";
  apiAvailable: boolean;
  statusQueryAvailable: boolean;
  remindersAllowed: boolean;
  priority: number;
  targetShare: number;
  extraDelayDays: number;
  onlyForChannels: string[];
  notes: string | null;
}

const TYPE: Record<string, string> = { LINK: "Bewertungslink (eigener E-Mail-Versand)", API: "API", EXTERNAL_PROGRAM: "Plattform versendet selbst" };

function PlatformCard({ p, onSaved }: { p: Platform; onSaved: () => void }) {
  const [f, setF] = useState(p);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const external = p.integrationType === "EXTERNAL_PROGRAM";

  async function save() {
    setError(null);
    setMsg(null);
    try {
      await api(`/api/platforms/${p.id}`, {
        method: "PUT",
        body: { active: f.active, reviewUrl: f.reviewUrl || null, remindersAllowed: f.remindersAllowed, priority: f.priority, targetShare: f.targetShare, extraDelayDays: f.extraDelayDays, onlyForChannels: f.onlyForChannels, notes: f.notes },
      });
      setMsg("Gespeichert");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card
      title={p.name}
      description={TYPE[p.integrationType]}
      actions={
        <div className="flex gap-1">
          {p.statusQueryAvailable ? <Badge tone="green">Status abrufbar</Badge> : <Badge>Bewertungsstatus nicht abrufbar</Badge>}
          {p.active ? <Badge tone="green">aktiv</Badge> : <Badge>inaktiv</Badge>}
        </div>
      }
    >
      {p.notes && <p className="mb-4 text-sm text-muted">{p.notes}</p>}
      {external ? (
        <Notice tone="blue">Diese Plattform verschickt ihre Anfragen selbst. ReviewPilot sendet hierfür keine E-Mails und zählt sie nicht zur Verteilung.</Notice>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <label className="md:col-span-2">
            <Label hint="nur den offiziellen Link aus dem Händlerbereich der Plattform">Bewertungslink</Label>
            <div className="flex gap-2">
              <Input value={f.reviewUrl ?? ""} onChange={(e) => setF({ ...f, reviewUrl: e.target.value })} placeholder={p.key === "GOOGLE_BUSINESS" ? "https://g.page/r/…/review" : "https://…"} />
              <Button variant="secondary" disabled={!f.reviewUrl} onClick={() => window.open(f.reviewUrl!, "_blank", "noopener")}>Testlink öffnen</Button>
            </div>
            {p.key === "GOOGLE_BUSINESS" && (
              <p className="mt-1 text-xs text-muted">
                So findest du ihn: Google-Unternehmensprofil öffnen (Google-Suche nach „Adfunture“ als Inhaber angemeldet oder business.google.com) → „Rezensionen erhalten“ → Link kopieren. Erlaubt sind nur Links der Form g.page/r/…/review oder search.google.com/local/writereview?placeid=….
              </p>
            )}
          </label>
          <label>
            <Label hint="Prozent">Zielanteil</Label>
            <Input type="number" min={0} max={100} value={f.targetShare} onChange={(e) => setF({ ...f, targetShare: Number(e.target.value) })} />
          </label>
          <label>
            <Label hint="kleiner = höher">Priorität</Label>
            <Input type="number" min={0} value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })} />
          </label>
          <label>
            <Label hint="zusätzlich zur Versandregel">Versandverzögerung (Tage)</Label>
            <Input type="number" min={0} max={14} value={f.extraDelayDays} onChange={(e) => setF({ ...f, extraDelayDays: Number(e.target.value) })} />
          </label>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" checked={f.remindersAllowed} onChange={(e) => setF({ ...f, remindersAllowed: e.target.checked })} />
            Erinnerungen laut Plattformregeln erlaubt
          </label>
          <div className="md:col-span-2">
            <Label hint="leer = alle Bestellungen">Nur für Bestellungen aus</Label>
            <div className="flex flex-wrap gap-3 text-sm">
              {Object.entries(CHANNELS).map(([k, v]) => (
                <label key={k} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={f.onlyForChannels.includes(k)}
                    onChange={(e) => setF({ ...f, onlyForChannels: e.target.checked ? [...f.onlyForChannels, k] : f.onlyForChannels.filter((c) => c !== k) })}
                  />
                  {v}
                </label>
              ))}
            </div>
          </div>
          <label className="md:col-span-2">
            <Label>Notizen</Label>
            <Textarea rows={2} value={f.notes ?? ""} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            Plattform aktiv
          </label>
        </div>
      )}
      {!external && (
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={save}>Speichern</Button>
          {msg && <span className="text-sm text-emerald-600">{msg}</span>}
          <ErrorText error={error} />
        </div>
      )}
    </Card>
  );
}

export default function PlatformsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const load = () => api<Platform[]>("/api/platforms").then(setPlatforms);
  useEffect(() => {
    void load();
  }, []);
  const active = platforms.filter((p) => p.active && p.integrationType === "LINK");
  const sum = active.reduce((s, p) => s + p.targetShare, 0);

  return (
    <Shell>
      <PageTitle
        title="Bewertungsplattformen"
        description="Gewichtete Verteilung nur unter Plattformen, die eine Einladung technisch und nach ihren Regeln zulassen. Die Auswahl ist zufällig pro Bestellung – nie nach erwarteter Zufriedenheit."
      />
      {active.length > 0 && sum !== 100 && (
        <div className="mb-4">
          <Notice tone="blue">Die Zielanteile der aktiven Plattformen ergeben {sum} %. Sie werden anteilig umgerechnet.</Notice>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        {platforms.map((p) => (
          <PlatformCard key={p.id} p={p} onSaved={load} />
        ))}
      </div>
    </Shell>
  );
}
