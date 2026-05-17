import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../config/db';
import { authenticate, adminOrDispatcher } from '../../middleware/auth';
import { validate } from '../../middleware/errorHandler';
import { ok, created, notFound, paginate } from '../../utils/response';

export const customersRouter = Router();
customersRouter.use(authenticate, adminOrDispatcher);

// ── Schemas ───────────────────────────────────────────────────
const locationSchema = z.object({
  name: z.string().optional(),
  address_line1: z.string().min(1),
  address_line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  zip: z.string().min(1),
  lat: z.number().optional(),
  lng: z.number().optional(),
  access_notes: z.string().optional(),
  is_primary: z.boolean().default(true),
});

const createSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  phone_alt: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).default([]),
  source: z.string().optional(),
  location: locationSchema.optional(),
});

const updateSchema = createSchema.partial();

// ── GET /customers ─────────────────────────────────────────────
customersRouter.get('/', async (req: Request, res: Response) => {
  const { search, page = '1', limit = '25', tags } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const company_id = req.user!.company_id;

  let conditions = ['c.company_id = $1'];
  const params: any[] = [company_id];
  let idx = 2;

  if (search) {
    conditions.push(
      `to_tsvector('english', c.first_name || ' ' || c.last_name || ' ' || COALESCE(c.email,''))
       @@ plainto_tsquery('english', $${idx})`
    );
    params.push(search);
    idx++;
  }

  if (tags) {
    conditions.push(`c.tags @> $${idx}::text[]`);
    params.push(`{${tags}}`);
    idx++;
  }

  const where = conditions.join(' AND ');

  const [rows, count] = await Promise.all([
    query(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.tags, c.created_at,
              COUNT(j.id)::int AS job_count
       FROM customers c
       LEFT JOIN jobs j ON j.customer_id = c.id
       WHERE ${where}
       GROUP BY c.id
       ORDER BY c.last_name, c.first_name
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, parseInt(limit), offset]
    ),
    query(`SELECT COUNT(*)::int AS total FROM customers c WHERE ${where}`, params),
  ]);

  return ok(res, rows.rows, paginate(parseInt(page), parseInt(limit), count.rows[0].total));
});

// ── POST /customers ────────────────────────────────────────────
customersRouter.post('/', validate(createSchema), async (req: Request, res: Response) => {
  const { location, ...customerData } = req.body;
  const company_id = req.user!.company_id;

  const result = await withTransaction(async (client) => {
    const cust = await client.query(
      `INSERT INTO customers (company_id, first_name, last_name, email, phone, phone_alt, notes, tags, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [company_id, customerData.first_name, customerData.last_name, customerData.email,
       customerData.phone, customerData.phone_alt, customerData.notes,
       customerData.tags, customerData.source]
    );
    const customer = cust.rows[0];

    let loc = null;
    if (location) {
      const l = await client.query(
        `INSERT INTO service_locations (customer_id, name, address_line1, address_line2, city, state, zip, lat, lng, access_notes, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [customer.id, location.name, location.address_line1, location.address_line2,
         location.city, location.state, location.zip, location.lat, location.lng,
         location.access_notes, location.is_primary]
      );
      loc = l.rows[0];
    }

    return { ...customer, locations: loc ? [loc] : [] };
  });

  return created(res, result);
});

// ── GET /customers/:id ─────────────────────────────────────────
customersRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;

  const [custResult, locsResult] = await Promise.all([
    query('SELECT * FROM customers WHERE id = $1 AND company_id = $2', [id, company_id]),
    query('SELECT * FROM service_locations WHERE customer_id = $1 ORDER BY is_primary DESC', [id]),
  ]);

  if (!custResult.rows.length) return notFound(res, 'Customer');

  return ok(res, { ...custResult.rows[0], locations: locsResult.rows });
});

// ── PATCH /customers/:id ───────────────────────────────────────
customersRouter.patch('/:id', validate(updateSchema), async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;
  const fields = req.body;

  const allowed = ['first_name','last_name','email','phone','phone_alt','notes','tags','source'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return ok(res, { id });

  const setClause = updates.map(([k], i) => `${k} = $${i + 3}`).join(', ');
  const values = updates.map(([, v]) => v);

  const result = await query(
    `UPDATE customers SET ${setClause}, updated_at = NOW()
     WHERE id = $1 AND company_id = $2 RETURNING *`,
    [id, company_id, ...values]
  );

  if (!result.rows.length) return notFound(res, 'Customer');
  return ok(res, result.rows[0]);
});

// ── DELETE /customers/:id ──────────────────────────────────────
customersRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;
  // Soft delete — just mark inactive (no hard delete to preserve job history)
  const result = await query(
    `UPDATE customers SET tags = array_append(tags, 'archived'), updated_at = NOW()
     WHERE id = $1 AND company_id = $2 RETURNING id`,
    [id, company_id]
  );
  if (!result.rows.length) return notFound(res, 'Customer');
  return ok(res, { id, archived: true });
});

// ── GET /customers/:id/jobs ────────────────────────────────────
customersRouter.get('/:id/jobs', async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;
  const { page = '1', limit = '25' } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const result = await query(
    `SELECT j.*, sl.address_line1, sl.city, sl.state
     FROM jobs j
     JOIN service_locations sl ON sl.id = j.location_id
     WHERE j.customer_id = $1 AND j.company_id = $2
     ORDER BY j.created_at DESC
     LIMIT $3 OFFSET $4`,
    [id, company_id, parseInt(limit), offset]
  );

  return ok(res, result.rows);
});

// ── GET /customers/:id/invoices ────────────────────────────────
customersRouter.get('/:id/invoices', async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;

  const result = await query(
    `SELECT i.* FROM invoices i
     JOIN jobs j ON j.id = i.job_id
     WHERE j.customer_id = $1 AND j.company_id = $2
     ORDER BY i.created_at DESC`,
    [id, company_id]
  );

  return ok(res, result.rows);
});

// ── Service Locations sub-routes ───────────────────────────────
customersRouter.get('/:id/locations', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await query(
    'SELECT * FROM service_locations WHERE customer_id = $1 ORDER BY is_primary DESC',
    [id]
  );
  return ok(res, result.rows);
});

customersRouter.post('/:id/locations', validate(locationSchema), async (req: Request, res: Response) => {
  const { id } = req.params;
  const loc = req.body;

  const result = await query(
    `INSERT INTO service_locations (customer_id, name, address_line1, address_line2, city, state, zip, lat, lng, access_notes, is_primary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [id, loc.name, loc.address_line1, loc.address_line2, loc.city, loc.state,
     loc.zip, loc.lat, loc.lng, loc.access_notes, loc.is_primary]
  );
  return created(res, result.rows[0]);
});

customersRouter.patch('/:id/locations/:lid', async (req: Request, res: Response) => {
  const { lid } = req.params;
  const fields = req.body;
  const allowed = ['name','address_line1','address_line2','city','state','zip','lat','lng','access_notes','is_primary'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return ok(res, { id: lid });

  const setClause = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const values = updates.map(([, v]) => v);

  const result = await query(
    `UPDATE service_locations SET ${setClause}, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [lid, ...values]
  );
  if (!result.rows.length) return notFound(res, 'Location');
  return ok(res, result.rows[0]);
});

customersRouter.delete('/:id/locations/:lid', async (req: Request, res: Response) => {
  const { lid } = req.params;
  await query('DELETE FROM service_locations WHERE id = $1', [lid]);
  return ok(res, { id: lid, deleted: true });
});
