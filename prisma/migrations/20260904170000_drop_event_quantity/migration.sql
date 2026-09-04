-- Usage amounts live in `metadata` for now; the dedicated column is not needed yet.
ALTER TABLE "events" DROP COLUMN "quantity";
