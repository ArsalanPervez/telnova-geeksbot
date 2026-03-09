require('dotenv').config();
const prisma = require('../src/config/prisma');
async function run() {
  const cols = await prisma.$queryRaw`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'fcc_broadband_records'
    ORDER BY ordinal_position
  `;
  console.log('=== Columns ===');
  console.table(cols);
  await prisma.$disconnect();
}
run().catch(console.error);
