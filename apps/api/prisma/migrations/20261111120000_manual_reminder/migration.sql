-- Manuell ausgelöste Erinnerungen
ALTER TABLE "review_invitations" ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false;
