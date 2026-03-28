-- AlterTable: Add signature and auto-forward fields to MailboxAccount
ALTER TABLE "MailboxAccount" ADD COLUMN IF NOT EXISTS "signature" TEXT;
ALTER TABLE "MailboxAccount" ADD COLUMN IF NOT EXISTS "signatureHtml" TEXT;
ALTER TABLE "MailboxAccount" ADD COLUMN IF NOT EXISTS "autoForwardTo" TEXT;
