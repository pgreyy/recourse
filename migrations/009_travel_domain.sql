-- A second domain: hotel stays (demo merchant Tidewell Stays). Additive only.
-- merchants.domain separates retail (Stride & Co) from travel; a hotel rate is a listing with one variant whose
-- structured stay data (hotel, stars, city, dates, nights, refund policy) lives in merchant_variants.stay. A rate
-- with no refund policy has none in that object: missing merchant data stays visible, as with sizes.
ALTER TABLE merchants ADD COLUMN domain text NOT NULL DEFAULT 'retail' CHECK (domain IN ('retail', 'travel'));
ALTER TABLE merchant_variants ALTER COLUMN size DROP NOT NULL;
ALTER TABLE merchant_variants ADD COLUMN stay jsonb;
-- Travel has no shipment to track; the merchant's booking confirmation number is the evidence instead.
ALTER TABLE orders ADD COLUMN booking_ref text;
