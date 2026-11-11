# Google Kundenrezensionen (Merchant Center) – Einrichtung

**Wichtig:** Google Kundenrezensionen (Google Customer Reviews, GCR) sind etwas anderes als selbst verschickte Google-Bewertungslinks.

- **GCR:** Google verschickt die Umfrage selbst, nachdem der Kunde auf der Bestellbestätigungsseite eingewilligt hat (Opt-in). ReviewPilot verschickt dafür **keine** E-Mails. Der Bewertungsstatus ist nicht pro Bestellung abrufbar.
- **Google-Unternehmensprofil:** Das ist der Link „Rezension schreiben“, den ReviewPilot per E-Mail versenden kann. Er ist als eigene Plattform angelegt.

## Schritte

1. Im Google Merchant Center das Programm „Google Kundenrezensionen“ aktivieren und den Bedingungen zustimmen.
2. Das Opt-in-Modul muss auf der Bestellbestätigungsseite laufen. Es braucht Merchant-ID, Bestellnummer, Kunden-E-Mail, Lieferland und **voraussichtliches Lieferdatum**.
3. **Shopify-Einschränkung:** Laut Shopify-Community wird das Opt-in-Skript in Checkout Extensibility (Danke-Seite) derzeit **nicht nativ** unterstützt, und das alte Feld „Zusätzliche Skripte“ entfällt. Mögliche Wege, die jeweils geprüft werden müssen:
   - eine Shopify-App, die das GCR-Opt-in für Checkout Extensibility anbietet (kostenpflichtig, Anbieterangaben selbst prüfen)
   - ein Button auf der Danke-Seite, der zu einer eigenen Opt-in-Seite führt (zusätzlicher Klick, geringere Opt-in-Quote)
4. Lieferdatum: Bei Speditionsware (Thule-Dachboxen) die tatsächliche Laufzeit plus Puffer einrechnen. Google versendet die Umfrage nach dem angegebenen Datum.

## Koordination mit ReviewPilot

- Unter Plattformen ist „Google Kundenrezensionen“ als *externes Programm* angelegt und nimmt nicht an der E-Mail-Verteilung teil.
- Erhält ein Kunde eine GCR-Umfrage und zusätzlich eine ReviewPilot-Anfrage für das Unternehmensprofil, sind das zwei Anfragen. Wer das vermeiden will, setzt den Zielanteil von „Google Unternehmensprofil“ niedriger oder nutzt nur GCR.

## Offene Punkte

- Merchant-Center-ID
- Entscheidung über den Opt-in-Weg (App oder eigene Seite)
- Lieferzeiten je Versandart
