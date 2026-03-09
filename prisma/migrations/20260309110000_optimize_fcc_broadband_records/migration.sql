-- Optimize fcc_broadband_records:
--   1. Drop surrogate `id` PK  → use (location_id, fcc_provider_id, technology) as PK
--   2. Add `tract_geoid` (first 11 chars of block_geoid) + index
--   3. Drop unused `h3_res8_id` column
--   4. Drop redundant `block_geoid` index
--   5. Add composite index on (state_usps, technology) for fast deleteMany

-- Step 1: add tract_geoid with a temporary default so existing rows are valid
ALTER TABLE "fcc_broadband_records"
  ADD COLUMN "tract_geoid" VARCHAR(11) NOT NULL DEFAULT '';

-- Step 2: backfill from existing block_geoid
UPDATE "fcc_broadband_records"
  SET "tract_geoid" = LEFT("block_geoid", 11);

-- Step 3: remove the temporary default
ALTER TABLE "fcc_broadband_records"
  ALTER COLUMN "tract_geoid" DROP DEFAULT;

-- Step 4: drop old primary key on id
ALTER TABLE "fcc_broadband_records" DROP CONSTRAINT "fcc_broadband_records_pkey";

-- Step 5: (unique constraint already promoted to PK in previous migration — skipped)

-- Step 6: PK already on (location_id, fcc_provider_id, technology) — skipped

-- Step 7: drop id column
ALTER TABLE "fcc_broadband_records" DROP COLUMN "id";

-- Step 8: drop unused h3_res8_id
ALTER TABLE "fcc_broadband_records" DROP COLUMN "h3_res8_id";

-- Step 9: drop the old block_geoid index (too broad for tract-level queries)
DROP INDEX IF EXISTS "fcc_broadband_records_block_geoid_idx";

-- Step 10: add tract_geoid index (used by ZIP lookup queries)
CREATE INDEX "fcc_broadband_records_tract_geoid_idx"
  ON "fcc_broadband_records" ("tract_geoid");

-- Step 11: add composite index for upload deleteMany (state + technology)
CREATE INDEX "fcc_broadband_records_state_tech_idx"
  ON "fcc_broadband_records" ("state_usps", "technology");
