-- Anfrage an jede Bestellung: Erstattete/retournierte Bestellungen einschließen, UWG-Hinweis dokumentieren
ALTER TABLE "review_rules" ADD COLUMN "include_refunded_orders" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "review_rules" ADD COLUMN "uwg_notice_confirmed_at" TIMESTAMP(3);
