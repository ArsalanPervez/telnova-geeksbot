# Telnova Backend

A Node.js backend application built with Express.js.

## Project Structure

```
Telnova/
├── src/
│   ├── config/          # Configuration files
│   ├── controllers/     # Route controllers
│   ├── middlewares/     # Custom middleware
│   ├── models/          # Data models
│   ├── routes/          # API routes
│   ├── utils/           # Utility functions
│   └── index.js         # Main application entry point
├── node_modules/        # Dependencies
├── .env                 # Environment variables (not in git)
├── .env.example         # Example environment variables
├── .gitignore           # Git ignore file
├── package.json         # Project dependencies and scripts
└── README.md           # This file
```

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm (comes with Node.js)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
   - Copy `.env.example` to `.env`
   - Update the values in `.env` as needed

### Running the Application

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

The server will start on the port specified in your `.env` file (default: 3000).

## Available Scripts

- `npm start` - Start the server in production mode
- `npm run dev` - Start the server in development mode with nodemon
- `npm test` - Run tests (not yet configured)

## API Endpoints

### Health Check
- `GET /` - Welcome message and API status
- `GET /health` - Health check endpoint

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| NODE_ENV | Environment (development/production) | development |
| PORT | Server port | 3000 |
| DB_HOST | Database host | localhost |
| DB_PORT | Database port | 5432 |
| DB_NAME | Database name | telnova |
| DB_USER | Database user | postgres |
| DB_PASSWORD | Database password | |
| JWT_SECRET | JWT secret key | your-secret-key |
| JWT_EXPIRES_IN | JWT expiration time | 24h |

## Next Steps

1. Add database connection (PostgreSQL, MongoDB, etc.)
2. Create API routes in `src/routes/`
3. Create controllers in `src/controllers/`
4. Add authentication middleware
5. Implement business logic
6. Add input validation
7. Set up logging
8. Add tests

## License

ISC
