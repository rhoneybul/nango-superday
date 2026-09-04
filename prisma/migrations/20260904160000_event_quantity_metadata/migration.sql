-- Metering fields: how much usage an event represents, and free-form context for billing.
ALTER TABLE "events" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "events" ADD COLUMN "metadata" JSONB;
