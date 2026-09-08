-- Add a price to trial classes (the list price the frontend shows before booking)
-- and snapshot it onto each booking (the amount the mock payment "charged").

ALTER TABLE "trial_classes" ADD COLUMN "price_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bookings" ADD COLUMN "price_cents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "trial_classes" ADD CONSTRAINT "trial_classes_price_cents_nonneg" CHECK ("price_cents" >= 0);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_price_cents_nonneg" CHECK ("price_cents" >= 0);
