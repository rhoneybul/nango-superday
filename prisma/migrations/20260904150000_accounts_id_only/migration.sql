-- Accounts are identified by id only; name and main_contact were never read by the application.
ALTER TABLE "accounts" DROP COLUMN "name";
ALTER TABLE "accounts" DROP COLUMN "main_contact";
