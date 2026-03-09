require('dotenv').config();
const prisma = require('../src/config/prisma');
async function run() {
  const rows = await prisma.$queryRaw`
    SELECT state_usps,
      COUNT(*)::int as rows,
      COUNT(DISTINCT brand_name)::int as providers,
      COUNT(DISTINCT LEFT(block_geoid,11))::int as tracts
    FROM fcc_broadband_records
    GROUP BY state_usps
  `;
  console.log('=== Data Summary ===');
  console.table(rows);

  const indexes = await prisma.$queryRaw`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'fcc_broadband_records'
  `;
  console.log('\n=== Indexes ===');
  console.table(indexes);
  await prisma.$disconnect();
}
run().catch(console.error);
