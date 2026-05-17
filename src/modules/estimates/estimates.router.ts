import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../config/db';
import { authenticate, adminOrDispatcher } from '../../middleware/auth';
import { validate } from '../../middleware/errorHandler';
import { ok, created, notFound, unprocessable } from '../../utils/response';

export const estimatesRouter = Router({ mergeParams: true });
estimatesRouter.use(authenticate, adminOrDispatcher);

// ── Schemas ───────────────────────────────────────────────────
const lineItemSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  product_id: z.string().uuid().optional().nullable(),
  quantity: z.number().positive().default(1),
  unit_price: z.number().min(0),
  discount_pct: z.number().min(0).max(100).default(0),
  sort_order: z.number().int().default(0),
});

const createSchema = z.object({
  notes: z.string().optional(),
  internal_notes: z.string().optional(),
  tax_rate: z.number().min(0).max(1).default(0),
  expires_at: z.string().datetime().optional(),
  line_items: z.array(lineItemSchema).min(1),
});

function calcTotals(items: any[], taxRate: number) {
  const subtotal = items.reduce((sum, item) => {
    const discounted = item.unit_price * item.quantity * (1 - item.discount_pct / 100);
    return sum + discounted;
  }, 0);
  const tax_amount = subtotal * taxRate;
  const total = subtotal + tax_amount;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax_amount: Math.round(tax_amount * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

async function getEstimateNumber(companyId: string, client: any): Promise<string> {
  const result = await client.query(
    `SELECT COUNT(e.*)::int AS cnt FROM estimates e
     JOIN jobs j ON j.id = e.job_id WHERE j.company_id = $1`,
    [companyId]
  );
  return `EST-${String(result.rows[0].cnt + 1).padStart(5, '0')}`;
}

// ── GET /jobs/:jobId/estimates ─────────────────────────────────
estimatesRouter.get('/', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const result = await query(
    'SELECT * FROM estimates WHERE job_id = $1 ORDER BY created_at DESC',
    [jobId]
  );
  return ok(res, result.rows);
});

// ── POST /jobs/:jobId/estimates ────────────────────────────────
estimatesRouter.post('/', validate(createSchema), async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const { line_items, tax_rate, ...estimateData } = req.body;
  const company_id = req.user!.company_id;

  // Verify job belongs to company
  const jobCheck = await query('SELECT id FROM jobs WHERE id = $1 AND company_id = $2', [jobId, company_id]);
  if (!jobCheck.rows.length) return notFound(res, 'Job');

  const totals = calcTotals(line_items, tax_rate);

  const result = await withTransaction(async (client) => {
    const estNum = await getEstimateNumber(company_id, client);

    const est = await client.query(
      `INSERT INTO estimates (job_id, estimate_number, notes, internal_notes, tax_rate,
        subtotal, tax_amount, total, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [jobId, estNum, estimateData.notes, estimateData.internal_notes,
       tax_rate, totals.subtotal, totals.tax_amount, totals.total,
       estimateData.expires_at ?? null]
    );
    const estimate = est.rows[0];

    for (const item of line_items) {
      const itemTotal = item.unit_price * item.quantity * (1 - item.discount_pct / 100);
      await client.query(
        `INSERT INTO line_items (parent_id, parent_type, product_id, name, description,
          quantity, unit_price, discount_pct, total, sort_order)
         VALUES ($1,'estimate',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [estimate.id, item.product_id ?? null, item.name, item.description,
         item.quantity, item.unit_price, item.discount_pct,
         Math.round(itemTotal * 100) / 100, item.sort_order]
      );
    }

    const items = await client.query(
      'SELECT * FROM line_items WHERE parent_id = $1 ORDER BY sort_order',
      [estimate.id]
    );
    return { ...estimate, line_items: items.rows };
  });

  return created(res, result);
});

// ── GET /estimates/:id ─────────────────────────────────────────
estimatesRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const [est, items] = await Promise.all([
    query('SELECT * FROM estimates WHERE id = $1', [id]),
    query('SELECT * FROM line_items WHERE parent_id = $1 AND parent_type = $2 ORDER BY sort_order', [id, 'estimate']),
  ]);
  if (!est.rows.length) return notFound(res, 'Estimate');
  return ok(res, { ...est.rows[0], line_items: items.rows });
});

// ── PATCH /estimates/:id ───────────────────────────────────────
estimatesRouter.patch('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await query('SELECT * FROM estimates WHERE id = $1', [id]);
  if (!existing.rows.length) return notFound(res, 'Estimate');
  if (['approved','declined'].includes(existing.rows[0].status)) {
    return unprocessable(res, 'Cannot edit an approved or declined estimate');
  }

  const { line_items, tax_rate, ...fields } = req.body;
  const allowed = ['notes','internal_notes','expires_at'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));

  if (line_items) {
    const newTaxRate = tax_rate ?? existing.rows[0].tax_rate;
    const totals = calcTotals(line_items, newTaxRate);

    await withTransaction(async (client) => {
      await client.query(
        'DELETE FROM line_items WHERE parent_id = $1 AND parent_type = $2',
        [id, 'estimate']
      );
      for (const item of line_items) {
        const itemTotal = item.unit_price * item.quantity * (1 - item.discount_pct / 100);
        await client.query(
          `INSERT INTO line_items (parent_id, parent_type, product_id, name, description,
            quantity, unit_price, discount_pct, total, sort_order)
           VALUES ($1,'estimate',$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, item.product_id ?? null, item.name, item.description,
           item.quantity, item.unit_price, item.discount_pct,
           Math.round(itemTotal * 100) / 100, item.sort_order]
        );
      }
      await client.query(
        `UPDATE estimates SET tax_rate=$1, subtotal=$2, tax_amount=$3, total=$4, updated_at=NOW() WHERE id=$5`,
        [newTaxRate, totals.subtotal, totals.tax_amount, totals.total, id]
      );
    });
  }

  if (updates.length) {
    const setClause = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    await query(
      `UPDATE estimates SET ${setClause}, updated_at=NOW() WHERE id=$1`,
      [id, ...updates.map(([, v]) => v)]
    );
  }

  const result = await query('SELECT * FROM estimates WHERE id = $1', [id]);
  return ok(res, result.rows[0]);
});

// ── POST /estimates/:id/send ───────────────────────────────────
estimatesRouter.post('/:id/send', async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: generate PDF and email to customer
  const result = await query(
    `UPDATE estimates SET status='sent', sent_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND status='draft' RETURNING *`,
    [id]
  );
  if (!result.rows.length) return unprocessable(res, 'Estimate is not in draft status');
  return ok(res, result.rows[0]);
});

// ── POST /estimates/:id/approve ────────────────────────────────
estimatesRouter.post('/:id/approve', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await query(
    `UPDATE estimates SET status='approved', approved_at=NOW(), updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id]
  );
  if (!result.rows.length) return notFound(res, 'Estimate');
  return ok(res, result.rows[0]);
});

// ── POST /estimates/:id/convert ────────────────────────────────
estimatesRouter.post('/:id/convert', async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;

  const estResult = await query(
    `SELECT e.*, j.company_id FROM estimates e JOIN jobs j ON j.id = e.job_id WHERE e.id = $1`,
    [id]
  );
  if (!estResult.rows.length) return notFound(res, 'Estimate');
  const est = estResult.rows[0];
  if (est.company_id !== company_id) return notFound(res, 'Estimate');
  if (est.status !== 'approved') return unprocessable(res, 'Only approved estimates can be converted');

  const items = await query(
    'SELECT * FROM line_items WHERE parent_id = $1 AND parent_type = $2',
    [id, 'estimate']
  );

  const invoice = await withTransaction(async (client) => {
    const countResult = await client.query(
      `SELECT COUNT(i.*)::int AS cnt FROM invoices i
       JOIN jobs j ON j.id = i.job_id WHERE j.company_id = $1`,
      [company_id]
    );
    const invNumber = `INV-${String(countResult.rows[0].cnt + 1).padStart(5, '0')}`;

    const inv = await client.query(
      `INSERT INTO invoices (job_id, estimate_id, invoice_number, status, subtotal,
        tax_rate, tax_amount, total, amount_paid)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,0) RETURNING *`,
      [est.job_id, id, invNumber, est.subtotal, est.tax_rate, est.tax_amount, est.total]
    );
    const invoice = inv.rows[0];

    for (const item of items.rows) {
      await client.query(
        `INSERT INTO line_items (parent_id, parent_type, product_id, name, description,
          quantity, unit_price, discount_pct, total, sort_order)
         VALUES ($1,'invoice',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [invoice.id, item.product_id, item.name, item.description,
         item.quantity, item.unit_price, item.discount_pct, item.total, item.sort_order]
      );
    }

    return invoice;
  });

  return created(res, invoice);
});
