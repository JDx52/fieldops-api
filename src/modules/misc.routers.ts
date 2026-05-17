import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { query } from '../config/db';
import { authenticate, adminOnly, adminOrDispatcher, allStaff } from '../middleware/auth';
import { validate } from '../middleware/errorHandler';
import { ok, created, notFound, conflict } from '../utils/response';

// ════════════════════════════════════════════
//  DISPATCH BOARD
// ════════════════════════════════════════════
export const dispatchRouter = Router();
dispatchRouter.use(authenticate, adminOrDispatcher);

dispatchRouter.get('/', async (req: Request, res: Response) => {
  const company_id = req.user!.company_id;
  const { date = new Date().toISOString().slice(0,10) } = req.query as Record<string,string>;

  const techs = await query(
    `SELECT id, name, phone FROM users WHERE company_id = $1 AND role = 'technician' AND is_active = true ORDER BY name`,
    [company_id]
  );

  const jobs = await query(
    `SELECT j.id, j.job_number, j.title, j.status, j.priority,
            j.scheduled_start, j.scheduled_end,
            c.first_name || ' ' || c.last_name AS customer_name,
            sl.address_line1, sl.city, sl.state,
            ja.technician_id
     FROM jobs j
     JOIN customers c ON c.id = j.customer_id
     JOIN service_locations sl ON sl.id = j.location_id
     JOIN job_assignments ja ON ja.job_id = j.id
     WHERE j.company_id = $1
       AND j.scheduled_start::date = $2::date
     ORDER BY j.scheduled_start ASC`,
    [company_id, date]
  );

  // Group jobs by technician
  const jobsByTech = jobs.rows.reduce((acc: Record<string,any[]>, job: any) => {
    if (!acc[job.technician_id]) acc[job.technician_id] = [];
    acc[job.technician_id].push(job);
    return acc;
  }, {});

  const result = techs.rows.map((tech: any) => ({
    ...tech,
    jobs: jobsByTech[tech.id] ?? [],
  }));

  // Also include unassigned jobs for the day
  const unassigned = await query(
    `SELECT j.id, j.job_number, j.title, j.status, j.priority,
            j.scheduled_start, j.scheduled_end,
            c.first_name || ' ' || c.last_name AS customer_name,
            sl.address_line1, sl.city, sl.state
     FROM jobs j
     JOIN customers c ON c.id = j.customer_id
     JOIN service_locations sl ON sl.id = j.location_id
     LEFT JOIN job_assignments ja ON ja.job_id = j.id
     WHERE j.company_id = $1
       AND j.scheduled_start::date = $2::date
       AND ja.id IS NULL`,
    [company_id, date]
  );

  return ok(res, { date, technicians: result, unassigned: unassigned.rows });
});

// ════════════════════════════════════════════
//  USERS
// ════════════════════════════════════════════
export const usersRouter = Router();
usersRouter.use(authenticate);

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional(),
  role: z.enum(['admin','dispatcher','technician']),
  password: z.string().min(8).optional(), // optional: can send invite email instead
});

usersRouter.get('/', adminOrDispatcher, async (req: Request, res: Response) => {
  const company_id = req.user!.company_id;
  const { role } = req.query as Record<string,string>;

  let sql = `SELECT id, name, email, phone, role, is_active, last_login_at, created_at
             FROM users WHERE company_id = $1`;
  const params: any[] = [company_id];
  if (role) { sql += ` AND role = $2`; params.push(role); }
  sql += ' ORDER BY name';

  const result = await query(sql, params);
  return ok(res, result.rows);
});

usersRouter.post('/', adminOnly, validate(createUserSchema), async (req: Request, res: Response) => {
  const company_id = req.user!.company_id;
  const { name, email, role, phone, password } = req.body;

  const existing = await query(
    'SELECT id FROM users WHERE company_id = $1 AND email = $2',
    [company_id, email]
  );
  if (existing.rows.length) return conflict(res, 'Email already in use');

  const hash = await bcrypt.hash(password ?? Math.random().toString(36), 12);

  const result = await query(
    `INSERT INTO users (company_id, name, email, password_hash, role, phone)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, role, phone, created_at`,
    [company_id, name, email, hash, role, phone]
  );
  // TODO: send invite email if no password provided
  return created(res, result.rows[0]);
});

usersRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;
  // Only admin or self
  if (req.user!.role !== 'admin' && req.user!.id !== id) {
    return notFound(res, 'User');
  }
  const result = await query(
    `SELECT id, name, email, phone, role, is_active, avatar_url, last_login_at, created_at
     FROM users WHERE id = $1 AND company_id = $2`,
    [id, company_id]
  );
  if (!result.rows.length) return notFound(res, 'User');
  return ok(res, result.rows[0]);
});

usersRouter.patch('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;
  if (req.user!.role !== 'admin' && req.user!.id !== id) {
    return notFound(res, 'User');
  }
  const allowed = ['name','phone','avatar_url'];
  if (req.user!.role === 'admin') allowed.push('role','is_active');

  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return ok(res, { id });

  const setClause = updates.map(([k], i) => `${k} = $${i+3}`).join(', ');
  const result = await query(
    `UPDATE users SET ${setClause}, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING id,name,email,role,phone`,
    [id, company_id, ...updates.map(([,v]) => v)]
  );
  if (!result.rows.length) return notFound(res, 'User');
  return ok(res, result.rows[0]);
});

usersRouter.delete('/:id', adminOnly, async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;
  await query(`UPDATE users SET is_active=false, updated_at=NOW() WHERE id=$1 AND company_id=$2`, [id, company_id]);
  return ok(res, { id, deactivated: true });
});

usersRouter.get('/:id/schedule', adminOrDispatcher, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { date_from, date_to } = req.query as Record<string,string>;
  const result = await query(
    `SELECT j.id, j.job_number, j.title, j.status, j.scheduled_start, j.scheduled_end,
            c.first_name || ' ' || c.last_name AS customer_name,
            sl.address_line1, sl.city
     FROM job_assignments ja
     JOIN jobs j ON j.id = ja.job_id
     JOIN customers c ON c.id = j.customer_id
     JOIN service_locations sl ON sl.id = j.location_id
     WHERE ja.technician_id = $1
       AND ($2::date IS NULL OR j.scheduled_start >= $2::date)
       AND ($3::date IS NULL OR j.scheduled_start <= $3::date)
     ORDER BY j.scheduled_start ASC`,
    [id, date_from ?? null, date_to ?? null]
  );
  return ok(res, result.rows);
});

// ════════════════════════════════════════════
//  PRODUCTS (PRICE BOOK)
// ════════════════════════════════════════════
export const productsRouter = Router();
productsRouter.use(authenticate);

const productSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  sku: z.string().optional(),
  unit_cost: z.number().min(0).default(0),
  unit_price: z.number().min(0).default(0),
  unit_of_measure: z.string().default('each'),
  qty_on_hand: z.number().int().default(0),
  qty_low_alert: z.number().int().default(5),
  is_service: z.boolean().default(false),
});

productsRouter.get('/', allStaff, async (req: Request, res: Response) => {
  const company_id = req.user!.company_id;
  const { search, is_service, page = '1', limit = '50' } = req.query as Record<string,string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const conditions = ['company_id = $1', 'is_active = true'];
  const params: any[] = [company_id];
  let idx = 2;

  if (search) {
    conditions.push(`name ILIKE $${idx++}`);
    params.push(`%${search}%`);
  }
  if (is_service !== undefined) {
    conditions.push(`is_service = $${idx++}`);
    params.push(is_service === 'true');
  }

  const result = await query(
    `SELECT * FROM products WHERE ${conditions.join(' AND ')} ORDER BY name LIMIT $${idx} OFFSET $${idx+1}`,
    [...params, parseInt(limit), offset]
  );
  return ok(res, result.rows);
});

productsRouter.post('/', adminOnly, validate(productSchema), async (req: Request, res: Response) => {
  const company_id = req.user!.company_id;
  const f = req.body;
  const result = await query(
    `INSERT INTO products (company_id, name, description, sku, unit_cost, unit_price,
      unit_of_measure, qty_on_hand, qty_low_alert, is_service)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [company_id, f.name, f.description, f.sku, f.unit_cost, f.unit_price,
     f.unit_of_measure, f.qty_on_hand, f.qty_low_alert, f.is_service]
  );
  return created(res, result.rows[0]);
});

productsRouter.get('/:id', allStaff, async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await query('SELECT * FROM products WHERE id = $1 AND company_id = $2', [id, req.user!.company_id]);
  if (!result.rows.length) return notFound(res, 'Product');
  return ok(res, result.rows[0]);
});

productsRouter.patch('/:id', adminOnly, async (req: Request, res: Response) => {
  const { id } = req.params;
  const allowed = ['name','description','sku','unit_cost','unit_price','unit_of_measure','qty_on_hand','qty_low_alert','is_service'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return ok(res, { id });
  const setClause = updates.map(([k], i) => `${k} = $${i+3}`).join(', ');
  const result = await query(
    `UPDATE products SET ${setClause}, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
    [id, req.user!.company_id, ...updates.map(([,v]) => v)]
  );
  if (!result.rows.length) return notFound(res, 'Product');
  return ok(res, result.rows[0]);
});

productsRouter.delete('/:id', adminOnly, async (req: Request, res: Response) => {
  await query(`UPDATE products SET is_active=false, updated_at=NOW() WHERE id=$1`, [req.params.id]);
  return ok(res, { deleted: true });
});

// ════════════════════════════════════════════
//  REPORTS
// ════════════════════════════════════════════
export const reportsRouter = Router();
reportsRouter.use(authenticate, adminOnly);

reportsRouter.get('/revenue', async (req: Request, res: Response) => {
  const company_id = req.user!.company_id;
  const { from, to, group_by = 'month' } = req.query as Record<string,string>;

  const trunc = group_by === 'day' ? 'day' : group_by === 'week' ? 'week' : 'month';
  const result = await query(
    `SELECT DATE_TRUNC($1, p.paid_at) AS period,
            COUNT(DISTINCT p.id)::int AS payment_count,
            SUM(p.amount)::numeric AS revenue
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id
     JOIN jobs j ON j.id = i.job_id
     WHERE j.company_id = $2
       AND p.status = 'succeeded'
       AND ($3::date IS NULL OR p.paid_at >= $3::date)
       AND ($4::date IS NULL OR p.paid_at <= $4::date)
     GROUP BY period ORDER BY period ASC`,
    [trunc, company_id, from ?? null, to ?? null]
  );
  return ok(res, result.rows);
});

reportsRouter.get('/jobs', async (req: Request, res: Response) => {
  const company_id = req.user!.company_id;
  const { from, to } = req.query as Record<string,string>;
  const result = await query(
    `SELECT status, COUNT(*)::int AS count FROM jobs
     WHERE company_id = $1
       AND ($2::date IS NULL OR created_at >= $2::date)
       AND ($3::date IS NULL OR created_at <= $3::date)
     GROUP BY status`,
    [company_id, from ?? null, to ?? null]
  );
  return ok(res, result.rows);
});

reportsRouter.get('/technicians', async (req: Request, res: Response) => {
  const company_id = req.user!.company_id;
  const result = await query(
    `SELECT u.id, u.name,
            COUNT(DISTINCT ja.job_id)::int AS jobs_assigned,
            COUNT(DISTINCT CASE WHEN j.status = 'completed' THEN j.id END)::int AS jobs_completed,
            COALESCE(SUM(EXTRACT(EPOCH FROM (te.clock_out - te.clock_in))/3600), 0)::numeric AS hours_worked
     FROM users u
     LEFT JOIN job_assignments ja ON ja.technician_id = u.id
     LEFT JOIN jobs j ON j.id = ja.job_id AND j.company_id = $1
     LEFT JOIN time_entries te ON te.user_id = u.id AND te.clock_out IS NOT NULL
     WHERE u.company_id = $1 AND u.role = 'technician'
     GROUP BY u.id, u.name ORDER BY jobs_completed DESC`,
    [company_id]
  );
  return ok(res, result.rows);
});

reportsRouter.get('/invoices', async (req: Request, res: Response) => {
  const company_id = req.user!.company_id;
  // Aging report: 0-30, 31-60, 61-90, 90+ days
  const result = await query(
    `SELECT
       COUNT(CASE WHEN NOW() - due_date <= INTERVAL '30 days' THEN 1 END)::int AS "0_30",
       COUNT(CASE WHEN NOW() - due_date BETWEEN INTERVAL '31 days' AND INTERVAL '60 days' THEN 1 END)::int AS "31_60",
       COUNT(CASE WHEN NOW() - due_date BETWEEN INTERVAL '61 days' AND INTERVAL '90 days' THEN 1 END)::int AS "61_90",
       COUNT(CASE WHEN NOW() - due_date > INTERVAL '90 days' THEN 1 END)::int AS "over_90",
       SUM(balance_due)::numeric AS total_outstanding
     FROM invoices i
     JOIN jobs j ON j.id = i.job_id
     WHERE j.company_id = $1 AND i.status IN ('sent','partial','overdue')`,
    [company_id]
  );
  return ok(res, result.rows[0]);
});

// ════════════════════════════════════════════
//  COMPANY
// ════════════════════════════════════════════
export const companyRouter = Router();
companyRouter.use(authenticate);

companyRouter.get('/', async (req: Request, res: Response) => {
  const result = await query(
    'SELECT id, name, slug, phone, email, address, city, state, zip, timezone, logo_url FROM companies WHERE id = $1',
    [req.user!.company_id]
  );
  return ok(res, result.rows[0]);
});

companyRouter.patch('/', adminOnly, async (req: Request, res: Response) => {
  const allowed = ['name','phone','email','address','city','state','zip','timezone','logo_url'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return ok(res, req.user!.company_id);
  const setClause = updates.map(([k], i) => `${k} = $${i+2}`).join(', ');
  const result = await query(
    `UPDATE companies SET ${setClause}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.user!.company_id, ...updates.map(([,v]) => v)]
  );
  return ok(res, result.rows[0]);
});

companyRouter.get('/stats', adminOrDispatcher, async (req: Request, res: Response) => {
  const cid = req.user!.company_id;
  const today = new Date().toISOString().slice(0,10);

  const [jobsToday, jobsWeek, openInvoices, revenueMonth, activeTechs] = await Promise.all([
    query(`SELECT COUNT(*)::int AS cnt FROM jobs WHERE company_id=$1 AND scheduled_start::date=$2`, [cid, today]),
    query(`SELECT COUNT(*)::int AS cnt FROM jobs WHERE company_id=$1 AND scheduled_start >= NOW() - INTERVAL '7 days'`, [cid]),
    query(`SELECT COALESCE(SUM(balance_due),0)::numeric AS total FROM invoices i JOIN jobs j ON j.id=i.job_id WHERE j.company_id=$1 AND i.status IN ('sent','partial','overdue')`, [cid]),
    query(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN jobs j ON j.id=i.job_id WHERE j.company_id=$1 AND p.paid_at >= DATE_TRUNC('month',NOW()) AND p.status='succeeded'`, [cid]),
    query(`SELECT COUNT(*)::int AS cnt FROM users WHERE company_id=$1 AND role='technician' AND is_active=true`, [cid]),
  ]);

  return ok(res, {
    jobs_today: jobsToday.rows[0].cnt,
    jobs_this_week: jobsWeek.rows[0].cnt,
    open_invoices_total: parseFloat(openInvoices.rows[0].total),
    revenue_this_month: parseFloat(revenueMonth.rows[0].total),
    technicians_active: activeTechs.rows[0].cnt,
  });
});
