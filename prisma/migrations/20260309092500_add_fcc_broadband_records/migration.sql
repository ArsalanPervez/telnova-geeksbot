-- CreateTable
CREATE TABLE "fcc_broadband_records" (
    "id" TEXT NOT NULL,
    "frn" TEXT NOT NULL,
    "fcc_provider_id" TEXT NOT NULL,
    "brand_name" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "technology" INTEGER NOT NULL,
    "max_advertised_download_speed" INTEGER NOT NULL,
    "max_advertised_upload_speed" INTEGER NOT NULL,
    "low_latency" BOOLEAN NOT NULL,
    "business_residential_code" TEXT NOT NULL,
    "state_usps" TEXT NOT NULL,
    "block_geoid" TEXT NOT NULL,
    "h3_res8_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fcc_broadband_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fcc_broadband_records_state_usps_idx" ON "fcc_broadband_records"("state_usps");

-- CreateIndex
CREATE INDEX "fcc_broadband_records_block_geoid_idx" ON "fcc_broadband_records"("block_geoid");

-- CreateIndex
CREATE UNIQUE INDEX "fcc_broadband_records_location_id_fcc_provider_id_technolog_key" ON "fcc_broadband_records"("location_id", "fcc_provider_id", "technology");
