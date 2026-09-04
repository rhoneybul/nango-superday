-- Idempotency key per event, unique per account. Existing rows get a generated one.
ALTER TABLE "events" ADD COLUMN "event_id" TEXT NOT NULL DEFAULT gen_random_uuid()::text;
CREATE UNIQUE INDEX "events_account_id_event_id_key" ON "events"("account_id", "event_id");
