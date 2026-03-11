const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

// PrismaClient ko singleton pattern se use karein
// Ye multiple instances create hone se rokta hai

let prisma;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

const adapter = new PrismaPg(pool);

if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient({ adapter });
} else {
  // Development mein hot-reload ke waqt multiple instances na banein
  if (!global.prisma) {
    global.prisma = new PrismaClient({
      adapter,
      log: ['warn', 'error'],
    });
  }
  prisma = global.prisma;
}

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err.message);
});

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
  await pool.end();
});

module.exports = prisma;
