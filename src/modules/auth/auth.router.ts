import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query, withTransaction } from '../../config/db';
import { validate } from '../../middleware/errorHandler';
import { authenticate } from '../../middleware/auth';
import { ok, created, badRequest, unauthorized, conflict } from '../../utils/response';

export const authRouter = Router();

// ── Schemas ──────────────────────────────────────────────────
const registerSchema = z.object({
  company_name: z.string().min(2).max(255),
  timezone: z.string().default('America/Chicago'),
  name: z.string().min(2).max(255),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const forgotSchema = z.object({ email: z.string().email() });

const resetSchema = z.object({
  token: z.string(),
  password: z.string().min(8),
});

// ── Helpers ───────────────────────────────────────────────────
function generateSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function signTokens(userId: string, companyId: string, role: string) {
  const token = jwt.sign(
    { sub: userId, company_id: companyId, role },
    process.env.JWT_SECRET as string,
    { expiresIn: '24h' } as jwt.SignOptions
  );
  const refresh_token = jwt.sign(
    { sub: userId, type: 'refresh' },
    process.env.REFRESH_TOKEN_SECRET as string,
    { expiresIn: '30d' } as jwt.SignOptions
  );
  return { token, refresh_token };
}

// ── POST /auth/register ───────────────────────────────────────
authRouter.post('/register', validate(registerSchema), async (req: Request, res: Response) => {
  const { company_name, timezone, name, email, password } = req.body;

  // Check email not already used
  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length) return conflict(res, 'Email already registered');

  const result = await withTransaction(async (client) => {
    // Create company
    let slug = generateSlug(company_name);
    const slugCheck = await client.query('SELECT id FROM companies WHERE slug = $1', [slug]);
    if (slugCheck.rows.length) slug = `${slug}-${Date.now()}`;

    const comp = await client.query(
      `INSERT INTO companies (name, slug, timezone)
       VALUES ($1, $2, $3) RETURNING id, name, slug`,
      [company_name, slug, timezone]
    );
    const company = comp.rows[0];

    // Create admin user
    const hash = await bcrypt.hash(password, 12);
    const usr = await client.query(
      `INSERT INTO users (company_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin') RETURNING id, name, email, role`,
      [company.id, name, email, hash]
    );
    const user = usr.rows[0];

    return { company, user };
  });

  const { token, refresh_token } = signTokens(result.user.id, result.company.id, 'admin');
  return created(res, { company: result.company, user: result.user, token, refresh_token });
});

// ── POST /auth/login ──────────────────────────────────────────
authRouter.post('/login', validate(loginSchema), async (req: Request, res: Response) => {
  const { email, password } = req.body;

  const result = await query(
    'SELECT id, company_id, name, email, role, password_hash FROM users WHERE email = $1 AND is_active = true',
    [email]
  );
  if (!result.rows.length) return unauthorized(res, 'Invalid email or password');

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return unauthorized(res, 'Invalid email or password');

  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  const { token, refresh_token } = signTokens(user.id, user.company_id, user.role);
  const { password_hash, ...safeUser } = user;
  return ok(res, { token, refresh_token, user: safeUser });
});

// ── POST /auth/refresh ────────────────────────────────────────
authRouter.post('/refresh', async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return badRequest(res, 'refresh_token is required');

  try {
    const payload = jwt.verify(refresh_token, process.env.REFRESH_TOKEN_SECRET!) as any;
    if (payload.type !== 'refresh') throw new Error('Invalid token type');

    const result = await query(
      'SELECT id, company_id, role FROM users WHERE id = $1 AND is_active = true',
      [payload.sub]
    );
    if (!result.rows.length) return unauthorized(res, 'User not found');

    const user = result.rows[0];
    const tokens = signTokens(user.id, user.company_id, user.role);
    return ok(res, tokens);
  } catch {
    return unauthorized(res, 'Invalid or expired refresh token');
  }
});

// ── POST /auth/logout ─────────────────────────────────────────
authRouter.post('/logout', authenticate, async (req: Request, res: Response) => {
  // In production, add refresh token to a blocklist (Redis)
  return ok(res, { message: 'Logged out successfully' });
});

// ── POST /auth/forgot-password ────────────────────────────────
authRouter.post('/forgot-password', validate(forgotSchema), async (req: Request, res: Response) => {
  const { email } = req.body;
  const result = await query('SELECT id, name FROM users WHERE email = $1', [email]);

  // Always return success to prevent email enumeration
  if (result.rows.length) {
    const user = result.rows[0];
    const resetToken = jwt.sign(
      { sub: user.id, type: 'password_reset' },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' } as jwt.SignOptions
    );
    // TODO: send email with resetToken
    // await sendPasswordResetEmail(email, user.name, resetToken);
  }

  return ok(res, { message: 'If that email exists, a reset link has been sent' });
});

// ── POST /auth/reset-password ─────────────────────────────────
authRouter.post('/reset-password', validate(resetSchema), async (req: Request, res: Response) => {
  const { token, password } = req.body;

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
    if (payload.type !== 'password_reset') throw new Error();

    const hash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, payload.sub]);

    return ok(res, { message: 'Password updated successfully' });
  } catch {
    return badRequest(res, 'Invalid or expired reset token');
  }
});
