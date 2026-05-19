import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { logger } from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

// Routers
import { authRouter } from './modules/auth/auth.router';
import { customersRouter } from './modules/customers/customers.router';
import { jobsRouter } from './modules/jobs/jobs.router';
import { estimatesRouter } from './modules/estimates/estimates.router';
import { invoicesRouter, invoicesGlobalRouter } from './modules/invoices/invoices.router';
import { webhooksRouter } from './modules/webhooks/webhooks.router';
import { workOrdersRouter } from './modules/workorders/workorders.router';
import {
  dispatchRouter,
  usersRouter,
  productsRouter,
  reportsRouter,
  companyRouter,
} from './modules/misc.routers';

const app = express();

// Trust Railway proxy
app.set("trust proxy", 1);

// ── Security ──────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: "*",
  credentials: true,
}));

// ── Stripe webhook (raw body BEFORE json parser) ───────────────
app.use('/v1/webhooks', express.raw({ type: 'application/json' }), webhooksRouter);

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: (req) => req.user?.company_id ?? req.ip ?? 'unknown',
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
});

app.use('/v1/auth', authLimiter);
app.use('/v1', apiLimiter);

// ── Request logging ───────────────────────────────────────────
app.use((req, _res, next) => {
  if (req.path !== '/health') {
    logger.debug(`${req.method} ${req.path}`);
  }
  next();
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API Routes ────────────────────────────────────────────────
const v1 = '/v1';

app.use(`${v1}/auth`, authRouter);
app.use(`${v1}/company`, companyRouter);
app.use(`${v1}/users`, usersRouter);
app.use(`${v1}/customers`, customersRouter);
app.use(`${v1}/jobs`, jobsRouter);
app.use(`${v1}/jobs/:jobId/estimates`, estimatesRouter);
app.use(`${v1}/jobs/:jobId/invoices`, invoicesRouter);
app.use(`${v1}/estimates`, estimatesRouter);
app.use(`${v1}/invoices`, invoicesGlobalRouter);
app.use(`${v1}/dispatch`, dispatchRouter);
app.use(`${v1}/products`, productsRouter);
app.use(`${v1}/reports`, reportsRouter);
app.use(`${v1}/work-orders`, workOrdersRouter);

// ── Error handling ────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3000');
app.listen(PORT, () => {
  logger.info(`FSM API running on port ${PORT} [${process.env.NODE_ENV ?? 'development'}]`);
});

export default app;
