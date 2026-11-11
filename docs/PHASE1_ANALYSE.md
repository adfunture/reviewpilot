# Phase 1 – Technische Analyse & Integrationsmatrix

Stand: 11.11.2026. Grundlage: Shopify Admin GraphQL Schema (direkt per Schema-Abfrage geprüft),
Judge.me-Hilfecenter (judge.me/help, Artikel „Judge.me API“), Shopify-Community/Doku zu Google
Kundenrezensionen, Recherche zu idealo. Alles, was nicht offiziell belegt werden konnte, ist als
**offen** markiert und im Code nur als sicherer Fallback umgesetzt.

## 1. Integrationsmatrix

| Plattform | API verfügbar | Tarifbeschränkung | Bewertungslink | Bewertungsstatus abrufbar | Erinnerungen technisch möglich | Plattformregeln (Kurz) | Aufwand | Umsetzung in ReviewPilot |
|---|---|---|---|---|---|---|---|---|
| **Shopify** (Datenquelle) | Ja – Admin GraphQL (`Order`, `Fulfillment`, `FulfillmentEvent`, `customerJourneySummary`), Webhooks | – | – | – | – | Nur benötigte Scopes; HMAC-Prüfung | mittel | **Voll umgesetzt** (Sync, Webhooks, Zustellstatus, Attribution) |
| **Judge.me** | Ja – `GET https://api.judge.me/api/v1/reviews` (Filter `reviewer_email`), `POST https://judge.me/api/orders/send_manual_review_request`; Private Token unter *Settings → Integrations → View API tokens* | **Offen**: Die Hilfe nennt keine Tarifgrenze für die API. Ob Free die API nutzen darf, wird beim Verbindungstest real geprüft | Judge.me versendet selbst | Ja (Reviews per E-Mail filterbar) | Judge.me steuert eigene Erinnerungen | Keine Webhooks dokumentiert; versendete *Einladungen* sind nicht per API abrufbar | gering | **Lesend umgesetzt**: Abgleich vorhandener Bewertungen pro Kunden-E-Mail. Einladungs-Koordination **nicht möglich** → Warnhinweis im Dashboard |
| **Google Kundenrezensionen** (Merchant Center) | Kein Versand-API: Google verschickt die Umfrage selbst nach Opt-in auf der Bestellbestätigungsseite | Kostenlos | Nein (Google-eigene Umfrage) | Nein (nur aggregiert im Merchant Center) | Nein, steuert Google | Opt-in-Modul muss auf der Danke-Seite laufen, inkl. voraussichtlichem Lieferdatum | – (Shop-Einrichtung) | **Nicht als Versandkanal**: Anleitung in `docs/GOOGLE_KUNDENREZENSIONEN.md`. Laut Shopify-Community wird das Opt-in-Skript in Checkout Extensibility **nicht nativ unterstützt** – offen |
| **Google Unternehmensprofil** | Bewertungs-API nur für verifizierte Profile/Partner; für Einladungen nicht nötig | – | Ja – offizieller Link „Rezension schreiben“ aus dem Profil | Nein (nicht bestellbezogen) | Ja (eigene E-Mail) | Keine Anreize, kein Review-Gating, keine selektive Ansprache | gering | **Umgesetzt** als Link-Plattform, Klickmessung über eigenen Redirect |
| **idealo** | **Keine öffentliche Partner-API für Händlerbewertungs-Einladungen gefunden** | offen | **offen** – nur ein von idealo business bereitgestellter Link darf hinterlegt werden | Nein | nur per eigener E-Mail | offen; Bewertungen evtl. nur für über idealo vermittelte Käufe sinnvoll | gering | **Link-Fallback**: Plattform startet inaktiv ohne Link; Option „nur für idealo-Bestellungen“ standardmäßig an |
| **Trusted Shops** (optional) | Ja (kostenpflichtig, eigenes Einladungssystem) | kostenpflichtig | Ja | Ja (mit Abo) | Trusted Shops steuert | – | hoch | Nur als Link-Plattform vorbereitet, inaktiv |
| **Trustpilot** (optional) | Invitation API nur in bezahlten Plänen | kostenpflichtig | Ja (Profil-Link) | Nur mit API | Ja | Keine selektive Einladung (Trustpilot-Richtlinie) | mittel | Nur als Link-Plattform vorbereitet, inaktiv |

## 2. Shopify – geprüfte Felder (Admin GraphQL)

- `Order`: `id`, `name`, `createdAt`, `cancelledAt`, `displayFinancialStatus`, `displayFulfillmentStatus`,
  `email`, `customerLocale`, `totalPriceSet`, `totalRefundedSet`, `sourceName`, `customerAcceptsMarketing`,
  `customer { id firstName lastName defaultEmailAddress { marketingState } }`, `lineItems`, `shippingLines`,
  `fulfillments`, `customerJourneySummary { firstVisit lastVisit { source referrerUrl landingPage utmParameters { source medium campaign } } }`, `test`.
- `Fulfillment`: `status`, `displayStatus` (u. a. `DELIVERED`, `DELAYED`, `FAILURE`, `ATTEMPTED_DELIVERY`, `NOT_DELIVERED`, `IN_TRANSIT`, `OUT_FOR_DELIVERY`), `deliveredAt`, `inTransitAt`, `estimatedDeliveryAt`, `trackingInfo { company number url }`, `events { status happenedAt }`.
- Authentifizierung: Apps werden im **Dev Dashboard** angelegt (im Shopify-Admin erstellte Custom Apps können nicht mehr neu angelegt werden). Für den eigenen Shop: **Client Credentials Grant** → Token 24 h gültig, wird automatisch erneuert. Webhook-HMAC mit dem Client Secret.
- Scopes (minimal): `read_orders`, `read_customers`, `read_fulfillments`. (`read_all_orders` nur für Importe älter als 60 Tage – nicht nötig.)

## 3. Zustellstatus – Grundsatz

Nur `displayStatus = DELIVERED` bzw. ein `FulfillmentEvent` mit Status `DELIVERED` oder eine **manuelle**
Bestätigung im Dashboard gelten als Zustellung. „Versendet“/„Fulfilled“ ist **keine** Zustellung.
DHL/GLS: Die Shopify-Tracking-Events (von Shopify selbst über Carrier-Integrationen befüllt) werden genutzt.
Eigene DHL-/GLS-API-Anbindungen sind vorbereitet (Schnittstelle `TrackingProvider`), aber **nicht aktiv**, weil dafür
offizielle API-Zugänge (DHL Developer Portal – Shipment Tracking API; GLS Track & Trace API mit Kundenvertrag) nötig sind.

## 4. Rechtliche Leitplanken (Deutschland) – keine Rechtsberatung

- BGH, Urt. v. 10.07.2018 – VI ZR 225/17: Eine Bitte um Bewertung/Kundenzufriedenheitsbefragung per E-Mail ist
  **Werbung** – auch in einer Transaktions-E-Mail. Zulässig nur mit **ausdrücklicher Einwilligung** (§ 7 Abs. 2 Nr. 2 UWG)
  oder unter den engen Voraussetzungen des **§ 7 Abs. 3 UWG** (Bestandskunde, Adresse aus Verkauf, Hinweis auf
  Widerspruchsrecht bei Erhebung **und** in jeder E-Mail, kein Widerspruch).
- Umsetzung: Rechtsgrundlage pro Shop konfigurierbar (`NONE` = Standard, `CONSENT`, `UWG_7_3`). Ohne Konfiguration
  + ausdrückliche Freigabe wird **nichts** versendet. Jede E-Mail enthält einen Abmeldelink und Widerspruchshinweis.
- Keine Anreize, kein Review-Gating, keine Auswahl nach erwarteter Zufriedenheit (Plattformwahl ist deterministisch per Hash
  der Bestell-ID, unabhängig von Kundendaten).
- Die Einordnung von § 7 Abs. 3 UWG für Bewertungsanfragen ist umstritten – vor Aktivierung anwaltlich prüfen lassen.

## 5. Offene Punkte (vom Händler zu klären)

1. Judge.me: Ist der Private API Token im Free-Tarif nutzbar? → Verbindungstest im Dashboard zeigt das echte Ergebnis.
2. Google Kundenrezensionen: Wie wird das Opt-in auf der Danke-Seite eingebunden (Google & YouTube-App, Drittanbieter-App, Custom Pixel)? Lieferdatum für Speditionsware?
3. idealo: Offiziellen Bewertungslink und Bedingungen bei idealo business erfragen; dürfen Erinnerungen versendet werden?
4. Google-Unternehmensprofil: offiziellen „Rezension schreiben“-Link aus dem Profil kopieren.
5. Rechtsgrundlage: Einwilligung im Checkout (z. B. Checkbox) oder § 7 Abs. 3 UWG mit Hinweis in Datenschutzerklärung/Checkout.
6. SMTP-Absender (Domain mit SPF/DKIM/DMARC), Bounce-Postfach.
7. Spediteure: Welche Versandarten/Carrier-Namen kennzeichnen Speditionsware? (Mapping in den Einstellungen)
