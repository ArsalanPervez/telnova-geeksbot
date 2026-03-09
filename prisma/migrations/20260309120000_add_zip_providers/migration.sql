-- Drop raw records table (replaced by preprocessed zip_providers)
DROP TABLE IF EXISTS "fcc_broadband_records";

-- Create preprocessed ZIP-level provider table
CREATE TABLE "zip_providers" (
  "zip"          TEXT    NOT NULL,
  "brand_name"   TEXT    NOT NULL,
  "technology"   TEXT    NOT NULL,
  "max_dl_speed" INTEGER NOT NULL,
  "max_ul_speed" INTEGER NOT NULL,
  "low_latency"  BOOLEAN NOT NULL,
  "service_type" TEXT    NOT NULL,
  "state_usps"   TEXT    NOT NULL,
  "city"         TEXT    NOT NULL,

  CONSTRAINT "zip_providers_pkey" PRIMARY KEY ("zip", "brand_name", "technology")
);

CREATE INDEX "zip_providers_state_usps_idx" ON "zip_providers" ("state_usps");
