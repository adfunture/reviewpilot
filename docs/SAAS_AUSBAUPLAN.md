# Phase 5: Ausbauplan zur mandantenfähigen Shopify-App

## Bereits vorbereitet

- Alle fachlichen Tabellen hängen an `shop_id`. Alle Admin-Abfragen filtern über den Shop des angemeldeten Benutzers. Ein Test prüft die Mandantentrennung.
- Zugangsdaten pro Shop liegen verschlüsselt in `shop_integrations` (AES-256-GCM).
- Einstellungen, Plattformen, Vorlagen und Kanal-Mapping sind pro Shop gespeichert.
- `shops.plan` ist als Feld für den Tarif angelegt. Die Shopify-Webhooks `app/uninstalled`, `customers/redact` und `shop/redact` werden verarbeitet.
- Die Job-Queue ist mehrinstanzfähig (SKIP LOCKED). Wiederkehrende Jobs werden pro Zeitfenster dedupliziert.

## Schritte

1. **Shopify OAuth / Token Exchange**: Shopify CLI-App mit eingebetteter Admin-Oberfläche (App Bridge). Tokens pro Shop in `shop_integrations` (`provider = "shopify"`). `ShopifyClient` dafür pro Shop instanziieren statt aus der Umgebung lesen.
2. **Webhooks pro Shop** über `shopify.app.toml` (app-spezifische Abos). Pflicht-Compliance-Webhooks sind schon da.
3. **Händler-Accounts**: Benutzer ↔ Shop als n:m (Tabelle `memberships`). Login über Shopify-Session-Token statt Passwort, wenn eingebettet.
4. **Tarife und Limits**: Tabelle `plans` (maximale Einladungen pro Monat, Anzahl Plattformen). Zähler aus `review_invitations`. `send-due` prüft das Limit vor dem Versand.
5. **Shopify App Billing** (`appSubscriptionCreate`, nutzungsbasiert über `appUsageRecordCreate`). Stripe nur für Abrechnungsmodelle, die Shopify außerhalb des App Stores zulässt.
6. **E-Mail-Versand pro Mandant**: eigene Absenderdomain je Händler (DKIM-Verifizierung) oder ein transaktionaler Anbieter mit Subaccounts. Bounce-Webhooks pro Mandant.
7. **App-Store-Anforderungen**: Datenschutzerklärung, GDPR-Webhooks, Performance-Vorgaben, Abrechnung nur über die Billing API, Prüfung der Anforderungen für geschützte Kundendaten (Protected Customer Data, Level 2 für E-Mail und Name).
8. **Rechtliches pro Mandant**: Rechtsgrundlage, Impressum und Widerspruchstext pro Shop konfigurierbar (heute: Shopname plus Standardtext).
9. **Skalierung**: Worker horizontal skalieren. Bei sehr vielen Shops `plan-campaigns` auf ereignisgesteuerte Planung umstellen; dafür gibt es die Webhooks schon.
