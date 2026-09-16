ALTER TABLE "therapists" ADD COLUMN IF NOT EXISTS "price" integer;--> statement-breakpoint
UPDATE "therapists"
SET "price" = CASE
  WHEN lower("tier") = 'classic' THEN 999
  WHEN lower("tier") = 'luxury' THEN 4999
  ELSE 2499
END
WHERE "price" IS NULL;--> statement-breakpoint
ALTER TABLE "therapists" ALTER COLUMN "price" SET DEFAULT 2499;--> statement-breakpoint
ALTER TABLE "therapists" ALTER COLUMN "price" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "therapists" ADD CONSTRAINT "chk_therapists_price_nonneg" CHECK ("price" >= 0);
