const express = require('express');
const cors = require('cors');
const config = require('./config/config');
const prisma = require('./config/prisma');

// Routes
const authRoutes = require('./routes/auth.routes');
const fccRoutes  = require('./routes/fcc.routes');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to Telnova API',
    version: '1.0.0',
    status: 'running'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString()
  });
});

// Database connection test endpoint with Prisma
app.get('/db-test', async (req, res) => {
  try {
    // Test Prisma connection
    await prisma.$connect();
    const result = await prisma.$queryRaw`SELECT NOW() as current_time, version() as db_version`;
    res.json({
      status: 'Prisma database connected',
      data: result[0]
    });
  } catch (error) {
    res.status(500).json({
      status: 'Database connection failed',
      error: error.message
    });
  }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/fcc',  fccRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
const PORT = config.port;
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${config.env}`);

  // Test Prisma database connection on startup
  try {
    await prisma.$connect();
    console.log('✓ Prisma connected to PostgreSQL successfully');
  } catch (error) {
    console.error('✗ Prisma connection failed:', error.message);
  }
});

module.exports = app;
