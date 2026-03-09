const express = require('express');
const cors = require('cors');
const config = require('./config/config');
const prisma = require('./config/prisma');

// Routes
const authRoutes = require('./routes/auth.routes');
const fccRoutes  = require('./routes/fcc.routes');

const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const response = require('./utils/apiResponse');

// Routes
app.get('/', (req, res) => {
  response.success(res, 'Welcome to Telnova API', { version: '1.0.0' });
});

app.get('/health', (req, res) => {
  response.success(res, 'OK', { timestamp: new Date().toISOString() });
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
  response.error(res, 'Route not found', 404);
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  response.error(res, err.message || 'Internal server error', 500);
});

// Start server
const PORT = process.env.PORT || config.port || 3000;
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
