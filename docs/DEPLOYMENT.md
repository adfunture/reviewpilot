# Deployment auf Railway & Go-live

## 1. Voraussetzungen (vom Händler zu beschaffen)

| Was | Wo | Variable |
|---|---|---|
| Shopify-App (Dev Dashboard) mit Scopes `read_orders`, `read_customers`, `read_fulfillments`, im Shop installiert | dev.shopify.com → Apps → App erstellen → Version mit Scopes → installieren | `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_SHOP_DOMAIN=2zd4sv-jw.myshopify.com` |
| SMTP-Postfach mit SPF/DKIM/DMARC für die Absenderdomain | z. B. Strato (smtp.strato.de, 465) oder ein transaktionaler Anbieter | `SMTP_*`, `EMAIL_FROM` |
| Offizieller Google-Bewertungslink | ✅ liegt vor: `https://g.page/r/CQuEv013N0m2EBM/review` | `cli set-review-link` oder Dashboard |
| idealo-Bewertungslink und Regeln | idealo business / Partner-Support | im Dashboard (Plattformen) |
| Judge.me Private API Token (optional, für den Abgleich) | Judge.me → Settings → Integrations → View API tokens | im Dashboard (Einstellungen) |
| Rechtsgrundlage (Einwilligung oder § 7 Abs. 3 UWG), Datenschutzerklärung ergänzt | Rechtsberatung | im Dashboard (Einstellungen) |

**Hinweis Shopify:** Custom Apps, die direkt im Shopify-Admin erstellt werden, kann man nicht mehr neu anlegen. Eine Dev-Dashboard-App im eigenen Shop holt ihr Token selbst über den *Client Credentials Grant* (24 Stunden gültig, wird automatisch erneuert). Shopify signiert die Webhooks mit dem Client Secret.

Der Client Credentials Grant funktioniert nur, wenn App und Shop in derselben Shopify-Organisation liegen.

## 2. Railway einrichten

1. GitHub-Repo anlegen (z. B. `adfunture/reviewpilot`) und pushen. `REPO` in `.railway/railway.ts` bei Bedarf anpassen.
2. Railway-Projekt anlegen und die **Standardregion zuerst auf EU West** stellen. Sonst landet Postgres in den USA, wie bei früheren Projekten passiert.
3. Aus **PowerShell** mit gesetztem `$env:_` (Pfad zu `railway.exe`):

```bash
npm install
```

```bash
npm run railway:plan
```

Den Plan durchsehen, dann:

```bash
npm run railway:apply
```

4. Im Railway-Dashboard die Secrets setzen (alle `preserve()`-Variablen):
   - `ENCRYPTION_KEY`: mit `node dist/cli.js generate-key` erzeugen, **zusätzlich offline sichern**.
   - `SESSION_SECRET`: mindestens 32 zufällige Zeichen.
   - `PUBLIC_BASE_URL`: die öffentliche HTTPS-Domain des Service `web`.
   - `ALLOW_CUSTOMER_EMAILS`: **noch nicht** setzen.
5. Der erste Deploy führt `prisma migrate deploy` und `cli seed` aus (preDeploy). Den Healthcheck `/health` prüfen.
6. Den ersten Benutzer im Service `web` per Railway-Shell anlegen:

```bash
node dist/cli.js create-admin inhaber@adfunture.de OWNER
```

Das Passwort wird nur einmal ausgegeben.

7. Google-Bewertungslink hinterlegen und Google aktivieren. Der Link ist geprüft: Er führt zu „Thule Partner Shop – Adfunture Outdoor GmbH“ auf Google Maps im Bewertungsmodus.

```bash
node dist/cli.js set-review-link GOOGLE_BUSINESS https://g.page/r/CQuEv013N0m2EBM/review
```

8. Im Dashboard unter Einstellungen → Integrationen nacheinander: **Shopify testen**, **Webhooks registrieren**, dann unter Bestellungen **„Shopify jetzt synchronisieren“** (Erstimport der letzten 60 Tage).

## 3. Go-live-Checkliste (Dashboard → Einstellungen & Freigabe)

Die Freigabe ist nur möglich, wenn alle Pflichtpunkte grün sind:

1. Rechtsgrundlage festgelegt
2. `EMAIL_TRANSPORT=smtp` und SMTP konfiguriert
3. `ALLOW_CUSTOMER_EMAILS=true` gesetzt. Das ist die harte serverseitige Sicherung.
4. `PUBLIC_BASE_URL` beginnt mit https
5. Mindestens eine aktive Plattform mit offiziellem Link
6. Vorlagen für alle Stufen vorhanden
7. Testempfänger hinterlegt und Test-E-Mail versendet (geht nur an Testempfänger, nie an Kundenadressen)

Danach gibt der **Inhaber** (Rolle OWNER) den Versand frei. Bei § 7 Abs. 3 UWG muss er zusätzlich bestätigen, dass Kunden bei der Bestellung auf ihr Widerspruchsrecht hingewiesen werden. Das gehört in den Checkout bzw. die Datenschutzerklärung, und zwar **bevor** freigegeben wird. Dafür muss er „VERSAND FREIGEBEN“ eintippen und den Judge.me-Parallelhinweis bestätigen.

**Nach der Freigabe gilt:**
- Nur Einladungen, die künftig fällig werden, gehen raus. Was älter als 48 Stunden ist, wird nicht nachgeholt.
- Ein Wechsel der Rechtsgrundlage sperrt den Versand automatisch wieder.
- Not-Aus: **Versand stoppen** im Dashboard oder `ALLOW_CUSTOMER_EMAILS` entfernen.

## 4. Betrieb

| Job | Intervall | Zweck |
|---|---|---|
| send-due | 1 min | fällige Einladungen versenden (Versandfenster, Tageslimit) |
| recover-stuck | 10 min | hängende Jobs freigeben, unklare Versände als Fehler markieren |
| sync-orders | 15 min | inkrementeller Shopify-Sync (Sicherheitsnetz zusätzlich zu den Webhooks) |
| plan-campaigns | 30 min | offene Kampagnen neu bewerten |
| sync-reviews | 6 h | Judge.me-Bewertungen abgleichen (nur mit erfolgreich getesteter Verbindung) |
| cleanup | täglich | Aufbewahrungsfristen anwenden |

- Logs sind strukturiertes JSON (pino). E-Mail-Adressen und Tokens werden maskiert.
- Dead Letters sind unter „Datenschutz & System“ sichtbar und lassen sich dort neu starten.
- **Bounces:** Synchrone SMTP-Ablehnungen (5xx) werden automatisch erkannt und gesperrt. Asynchrone Bounces kommen entweder über `POST /webhooks/email-bounce` mit Header `X-ReviewPilot-Secret` und JSON `{email, type: "hard"|"soft"|"complaint"}` herein oder werden manuell erfasst.

## 5. Kosten

Mehrere hundert bis mehrere tausend Bestellungen pro Monat sind für diese Architektur wenig Last.

- **web + worker:** je etwa 80–120 MB RAM und kaum CPU.
- **Postgres:** wenige 100 MB.
- **Erwartung:** im Rahmen des Railway-Hobby- oder Pro-Grundbetrags, grob 5–10 $ pro Monat. Das ist eine Schätzung, abhängig vom Railway-Tarif.
- **Weiter sparen:** den Worker-Service entfernen und `RUN_WORKER_IN_WEB=true` setzen.

## 6. Backup-Konzept

1. **Railway Postgres Backups** (im Postgres-Service → Backups) aktivieren: täglich, Aufbewahrung mindestens 7 Tage.
2. **Zusätzlich wöchentlich** einen `pg_dump` außerhalb von Railway ablegen, z. B. lokal oder in einen EU-Bucket. Wichtig: `pg_dump` muss mindestens die Major-Version des Servers haben.

```bash
pg_dump "$DATABASE_URL" --format=custom --file=reviewpilot-$(date +%F).dump
```

3. **Wiederherstellung** in eine leere Datenbank, danach `prisma migrate deploy`:

```bash
pg_restore --clean --no-owner -d "$DATABASE_URL" reviewpilot-JJJJ-MM-TT.dump
```

4. `ENCRYPTION_KEY` und `SESSION_SECRET` getrennt vom Dump sichern (Passwortmanager). Ohne `ENCRYPTION_KEY` lässt sich der gespeicherte Judge.me-Token nicht mehr entschlüsseln.
5. **Nie** `prisma migrate reset` oder `migrate dev` gegen Produktion ausführen.

## 7. Datenschutz

- Datenminimierung: Gespeichert werden nur die für Planung, Versand und Nachweis nötigen Felder.
- Aufbewahrung (`src/services/gdpr.ts`): Webhook-Rohdaten 30 Tage, erledigte Jobs 14 Tage, E-Mail-Ereignisse 2 Jahre, Audit-Log 3 Jahre. Personenbezogene Bestelldaten werden 1 Jahr nach Kampagnenabschluss pseudonymisiert.
- Auskunft und Löschung: Dashboard → Datenschutz & System. Die Shopify-Webhooks `customers/redact` und `shop/redact` werden ebenfalls verarbeitet.
- Deinstallation (`app/uninstalled`): Der Versand wird sofort gesperrt und der Shop als deinstalliert markiert.
- AV-Verträge mit Railway und dem SMTP-Anbieter abschließen. Railway in der EU-Region betreiben.
