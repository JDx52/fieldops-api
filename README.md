# FSM API — Field Service Management Backend

Node.js + Express + PostgreSQL backend for your FSM app.

## Stack
- **Runtime**: Node.js 20+
- **Framework**: Express 4
- **Database**: PostgreSQL 15+
- **Auth**: JWT (access + refresh tokens)
- **Payments**: Stripe
- **SMS**: Twilio
- **Validation**: Zod
- **Language**: TypeScript

## Project Structure
```
src/
├── index.ts                  # App entry point, route mounting
├── config/
│   └── db.ts                 # PostgreSQL pool + helpers
├── middleware/
│   ├── auth.ts               # JWT verify + role guards
│   └── errorHandler.ts       # Zod validation + global errors
├── modules/
│   ├── auth/                 # Register, login, refresh, reset
│   ├── customers/            # CRM + service locations
│   ├── jobs/                 # Jobs, assignments, photos, time entries
│   ├── estimates/            # Estimates + line items + convert
│   ├── invoices/             # Invoices + payments (Stripe)
│   ├── webhooks/             # Stripe webhook receiver
│   └── misc.routers.ts       # Users, products, dispatch, reports, company
├── types/
│   └── index.ts              # Shared TypeScript types
└── utils/
    ├── logger.ts             # Winston logger
    └── response.ts           # Standardized API response helpers
```

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Create the database
```bash
# Create DB
createdb fsm_db

# Run the schema (from the SQL file generated earlier)
psql -U youruser -d fsm_db -f fsm_schema.sql
```

### 4. Run in development
```bash
npm run dev
```

### 5. Build for production
```bash
npm run build
npm start
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing access tokens |
| `REFRESH_TOKEN_SECRET` | Secret for refresh tokens |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number |
| `FRONTEND_URL` | Allowed CORS origin |

## API Overview

All responses follow this shape:
```json
{
  "data": {},
  "error": null,
  "meta": { "page": 1, "limit": 25, "total": 100 }
}
```

All protected endpoints require:
```
Authorization: Bearer <jwt_token>
```

### Key endpoints
```
POST /v1/auth/register     Create company + admin
POST /v1/auth/login        Get JWT tokens
GET  /v1/dispatch          Full dispatch board for a date
GET  /v1/jobs              List jobs (filterable)
POST /v1/jobs              Create job
GET  /v1/customers         Search customers
POST /v1/invoices/:id/payments  Collect payment
GET  /v1/reports/revenue   Revenue report
```

## Role Permissions

| Role | Access |
|------|--------|
| `admin` | Full access to everything |
| `dispatcher` | Jobs, customers, estimates, invoices (no billing/settings) |
| `technician` | Own assigned jobs, clock in/out, upload photos |

## Deployment

### Using Railway / Render / Fly.io
1. Connect your GitHub repo
2. Set environment variables in the dashboard
3. Set build command: `npm run build`
4. Set start command: `npm start`

### Using Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## TODOs for Production
- [ ] Add Redis for refresh token blocklist (logout)
- [ ] Wire up Twilio SMS in notifications module
- [ ] Wire up SendGrid for estimate/invoice emails
- [ ] Add S3 upload for job photos (multer-s3)
- [ ] Add equipment and service agreement routes
- [ ] Add pagination to remaining list endpoints
- [ ] Set up database migrations tool (e.g. node-pg-migrate)
- [ ] Add request ID tracing
- [ ] Set up automated tests (Jest + supertest)
