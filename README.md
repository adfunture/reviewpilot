# ReviewPilot

ReviewPilot verwaltet Bewertungsanfragen für Shopify-Händler über mehrere Kanäle. Es ist zuerst für **Adfunture** gebaut und als mandantenfähige SaaS-App vorbereitet.

ReviewPilot synchronisiert Bestellungen aus Shopify und ermittelt den echten Zustellstatus. Daraus plant es höchstens **eine** Bewertungskampagne pro Bestellung mit maximal drei Kontaktversuchen. Die Einladungen versendet es über einen offiziellen Bewertungslink, zum Beispiel Google-Unternehmensprofil oder idealo. Ohne Rechtsgrundlage und ausdrückliche Freigabe verschickt es nichts.

## Stand

| Bereich | Status |
|---|---|
| Phase 1: Analyse & Integrationsmatrix | ✅ [docs/PHASE1_ANALYSE.md](docs/PHASE1_ANALYSE.md) |
| Shopify-Sync (GraphQL 2026-10), Webhooks (HMAC, idempotent) | ✅ Abfrage gegen das Live-Schema des Shops geprüft |
| Zustellstatus, Versandregeln A/B, Speditionen | ✅ |
| Kampagnen-Engine, Stoppbedingungen, Erinnerungs-Gating | ✅ |
| E-Mail-Service (SMTP/Log), Vorlagen, Abmeldung, Bounces, Testversand | ✅ |
| Dashboard (deutsch) | ✅ |
| Judge.me (Bewertungen lesen) | ✅ – Einladungen **nicht** synchronisierbar (keine API) |
| Google Kundenrezensionen | 📄 Einrichtungsanleitung (Google versendet selbst) |
| Google-Unternehmensprofil | ✅ **Hauptkanal** (100 %), eine Anfrage pro Bestellung, Link hinterlegt (`g.page/r/CQuEv013N0m2EBM/review`) |
| idealo | ✅ Shop-Bewertungsformular (`ShopRatingForm/336477`), nur für über idealo vermittelte Bestellungen – diese bekommen idealo **statt** Google, mit Bestellnummer in der Mail |
| Tests | ✅ 83 automatisierte Tests (Fachlogik + Integration gegen echtes Postgres) |
| Railway | ✅ Dockerfile + IaC, **noch nicht deployt** |

## Architektur

```
apps/api   Node 22 · TypeScript · Fastify 5 · Prisma 6 · Zod · Nodemailer
  src/domain     reine Fachlogik (Versandregeln, Zustellstatus, Kanalerkennung, Plattformwahl)
  src/shopify    Client (Client Credentials Grant), Abfragen, Mapper, Sync, Webhook-Prüfung
  src/campaigns  Kampagnen-Engine (Planung) und Versand (Sender)
  src/jobs       persistente Job-Queue in PostgreSQL (SKIP LOCKED, Backoff, Dead Letter)
  src/routes     Login, Dashboard-API, öffentliche Links (/r, /u), Webhooks
apps/web   Next.js 16 (statischer Export) · React 19 · Tailwind 4 · Recharts – wird von der API ausgeliefert
```

- **Ein Image, zwei Prozesse**: `web` (API und Dashboard) und `worker` (Scheduler und Queue). Für minimale Kosten kann der Worker mit `RUN_WORKER_IN_WEB=true` im Web-Prozess laufen.
- **Keine externen Dienste außer Postgres und SMTP.** Kein Redis und keine Tracking-Drittanbieter.
- **Idempotenz**: Unique-Constraints auf Kampagne pro Bestellung, Einladung pro Stufe, Webhook-ID und Job-`dedupeKey`.
- **Keine Doppel-Mails**: Eine Einladung wird vor dem Versand atomar auf `SENDING` gesetzt. Hängt sie nach einem Neustart, wird sie als `FAILED` markiert und **nicht** automatisch erneut gesendet.

## Versandlogik (Kurzfassung)

| Fall | 1. Anfrage | 2./3. Anfrage |
|---|---|---|
| A: bestätigte Zustellung (Shopify `DELIVERED` oder manuell) | Zustellung + 4 Tage (3–5 einstellbar) | jeweils +3 Tage |
| B: keine Zustellbestätigung (Spedition, kein Tracking, Tracking bleibt „unterwegs“) | Bestellung + 14 Tage, frühestens 7 Tage nach Versand | +3 Tage |

- Erinnerungen gehen nur raus, wenn **nachweislich** keine Bewertung vorliegt. Bei unbekanntem Status sind sie standardmäßig aus. Für Link-Plattformen wie Google gibt es deshalb im Normalfall genau **eine** Anfrage.
- Ein Versand ist keine Zustellung. Trifft vor der ersten Anfrage eine Zustellbestätigung ein, plant ReviewPilot von B auf A um.
- Keine rückwirkende Massenversendung: Eine Stufe, die mehr als 48 Stunden überfällig ist, wird übersprungen.
- Die Plattformwahl ist gewichtet und deterministisch über einen Hash der Bestell-ID. Sie hängt nie von der erwarteten Zufriedenheit ab.
- Stoppgründe: Bewertung, Widerspruch oder Abmeldung, widerrufene Einwilligung, Storno, Vollerstattung, Retoure, harter Bounce, Sperre. Verzögerung und Fehlzustellung **pausieren** die Kampagne nur.

Beobachtung im Live-Shop: Deutsche-Post-Sendungen (`dpag`) bleiben in Shopify oft dauerhaft auf `IN_TRANSIT`. Diese Bestellungen laufen deshalb über Variante B, solange keine Zustellbestätigung eintrifft.

## Google-Unternehmensprofil (Hauptkanal)

- **Link:** Google-Unternehmensprofil öffnen → „Rezensionen erhalten“ → Link kopieren. Akzeptiert werden nur `https://g.page/r/…/review` und `https://search.google.com/local/writereview?placeid=…`. Ein Maps-Teilen-Link wird abgelehnt.
- **Vorlagen:** ReviewPilot verwendet eigene Google-Vorlagen (Vorlagensatz „Google-Unternehmensprofil“). Sie sind neutral formuliert: „ganz gleich, wie sie ausgefallen ist“, mit dem Hinweis, dass ein Google-Konto nötig ist.
- **Inhaltsprüfung:** Beim Speichern werden Anreize (Gutschein, Rabatt, Gewinnspiel, Belohnung) und Aufforderungen zu „5 Sternen“ bzw. positiven Bewertungen abgelehnt. Grundlage sind Googles Richtlinien gegen Fake-Engagement und das UWG.
- **Anzahl Anfragen:** Entscheidung Adfunture: automatisch genau **eine** Anfrage pro Bestellung. Bei Google sind automatische Erinnerungen ausgeschaltet; das gilt auch dann, wenn die globale Einstellung „Erinnerungen bei unbekanntem Status“ eingeschaltet wird.
- **Manuelle Erinnerung:** In der Bestellansicht kann ein Admin eine Erinnerung einplanen, nachdem er bestätigt hat, dass der Kunde noch nicht bewertet hat. Dabei gilt:
  - Die Erinnerung geht frühestens 3 Tage nach der letzten E-Mail raus, im Versandfenster.
  - Pro Bestellung sind insgesamt höchstens 3 Kontakte möglich.
  - Abmeldung, Storno, Erstattung, Rechtsgrundlage und Freigabe werden vor dem Versand erneut geprüft.
  - Jede manuelle Erinnerung steht im Audit-Log. Betrachter (Rolle VIEWER) dürfen keine auslösen.
- **Klicks:** Klicks auf den Link werden gezählt. Bewertungen auf Google lassen sich nicht automatisch einer Bestellung zuordnen; das ist nur über die manuelle Bestätigung möglich.

## Anfrage an jede Bestellung (Entscheidung Adfunture, 11.11.2026)

Eine Analyse von 100 echten Bestellungen (28.10.–03.11.2026) ergab: Nur 1 % der Kunden hat eine Marketing-Einwilligung. Damit **jede** versendete Bestellung eine Anfrage bekommt, gilt deshalb:

- **Rechtsgrundlage:** § 7 Abs. 3 UWG ist voreingestellt. Kunden, die widersprochen oder sich abgemeldet haben, bekommen trotzdem nie eine Anfrage; das ist gesetzlich zwingend.
  - Bei der Freigabe muss der Inhaber bestätigen, dass im Checkout bzw. in der Datenschutzerklärung auf das Widerspruchsrecht hingewiesen wird.
  - **Rechtliche Prüfung empfohlen:** Ob Bewertungsanfragen unter § 7 Abs. 3 UWG fallen („Werbung für eigene ähnliche Waren“), ist in der Rechtsprechung nicht abschließend geklärt.
- **Erstattete und retournierte Bestellungen** werden ebenfalls angefragt, weil der Kunde die Ware erhalten hat. Das lässt sich in den Einstellungen abschalten. Es vermeidet, unzufriedene Kunden gezielt auszulassen, was Google als Review-Gating untersagt.
- **Keine Anfrage gibt es nur bei:**
  - Stornierung
  - nicht versendeten Bestellungen; sie werden angefragt, sobald sie versendet sind
  - fehlender E-Mail-Adresse
  - Testbestellungen
  - Abmeldung, Widerspruch oder unzustellbarer Adresse
  - manueller Sperre
- **Pausiert** werden Bestellungen mit gemeldeter Lieferverzögerung oder Fehlzustellung, bis die Zustellung erfolgt.
- **Versandzeitpunkt:** Mit DHL-Zustellbestätigung 4 Tage nach Zustellung. Bei GLS (in Shopify ohne Zustellstatus), Deutsche Post und Spedition 14 Tage nach Bestellung.
- **Start:** Beim Start werden nur Bestellungen angeschrieben, deren Termin noch kommt. Ältere Bestellungen werden nicht rückwirkend in einer Massenaktion angeschrieben.

## Lokal starten

Voraussetzungen: Node 22 oder neuer. Docker ist nicht nötig, die Datenbank läuft über PGlite.

```bash
npm run install:all
```

```bash
npm test
```

Für das lokale Dashboard die Datei `apps/api/.env` anlegen (siehe `.env.example`, `DATABASE_URL` auf Port 54331). Dann nacheinander:

```bash
node tools/testdb/node_modules/@electric-sql/pglite-socket/dist/scripts/server.js --port=54331 --db=.localdb
```

```bash
cd apps/api && npx prisma migrate deploy && npm run dev:cli -- seed && npm run dev:cli -- create-admin du@example.com OWNER
```

```bash
npm run build --prefix apps/web && npm run dev --prefix apps/api
```

Das Dashboard läuft dann unter http://localhost:8080.

## Weitere Dokumente

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Railway, Zugangsdaten, Go-live-Checkliste, Backups
- [docs/GOOGLE_KUNDENREZENSIONEN.md](docs/GOOGLE_KUNDENREZENSIONEN.md)
- [docs/SAAS_AUSBAUPLAN.md](docs/SAAS_AUSBAUPLAN.md)
