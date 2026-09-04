-- CreateTable
CREATE TABLE "events" (
    "id" BIGSERIAL NOT NULL,
    "account_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "events_account_id_timestamp_idx" ON "events"("account_id", "timestamp");

-- CreateIndex
CREATE INDEX "events_account_id_event_name_timestamp_idx" ON "events"("account_id", "event_name", "timestamp");

-- CreateIndex
CREATE INDEX "events_event_name_timestamp_idx" ON "events"("event_name", "timestamp");
