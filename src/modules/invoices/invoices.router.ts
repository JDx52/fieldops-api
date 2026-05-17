import { Router, Request, Response } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { query, withTransaction } from '../../config/db';
import { authenticate, adminOrDispatcher } from '../../middleware/auth';
import { validate } from '../../middleware/errorHandler';
import { ok, created, notFound, unprocessable, paginate } from '../../utils/response';

export const invoicesRouter = Router({ mergeParams: true });
invoicesRouter.use(authenticate, adminOrDispatcher);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2023-10-16' });

// ── Schemas ───────────────────────────────────────────────────
const paymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['cash','check','card','ach','other']),
  reference_number: z.string().optional(),
  stripe_payment_method_id: z.string().optional(),
  notes: z.string().optional(),
});

// ── GET /invoices (global) ─────────────────────────────────────
export const invoicesGlobalRouter = Router();
invoicesGlobalRouter.use(authenticate, adminOrDispatcher);

invoicesGlobalRouter.get('/', async (req: Request, res: Response) => {
  const { status, customer_id, page = '1', limit = '25' } = req.query as Record<string,string>;
  const company_id = req.user!.company_id;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const conditions = ['j.company_id = $1'];
  const params: any[] = [company_id];
  let idx = 2;

  if (status) { conditions.push(`i.status = $${idx++}`); params.push(status); }
  if (customer_id) { conditions.push(`j.customer_id = $${idx++}`); params.push(customer_id); }

  const where = conditions.join(' AND ');

  const [rows, count] = await Promise.all([
    query(
      `SELECT i.*, c.first_name || ' ' || c.last_name AS customer_name
       FROM invoices i
       JOIN jobs j ON j.id = i.job_id
       JOIN customers c ON c.id = j.customer_id
       WHERE ${where}
       ORDER BY i.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, parseInt(limit), offset]
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM invoices i JOIN jobs j ON j.id = i.job_id WHERE ${where}`,
      params
    ),
  ]);

  return ok(res, rows.rows, paginate(parseInt(page), parseInt(limit), count.rows[0].total));
});

// ── GET /jobs/:jobId/invoices ──────────────────────────────────
invoicesRouter.get('/', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const result = await query(
    'SELECT * FROM invoices WHERE job_id = $1 ORDER BY created_at DESC',
    [jobId]
  );
  return ok(res, result.rows);
});

// ── POST /jobs/:jobId/invoices ─────────────────────────────────
invoicesRouter.post('/', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const company_id = req.user!.company_id;
  const { line_items = [], tax_rate = 0, notes, internal_notes, due_date } = req.body;

  const jobCheck = await query('SELECT id FROM jobs WHERE id = $1 AND company_id = $2', [jobId, company_id]);
  if (!jobCheck.rows.length) return notFound(res, 'Job');

  const invoice = await withTransaction(async (client) => {
    const countResult = await client.query(
      `SELECT COUNT(i.*)::int AS cnt FROM invoices i
       JOIN jobs j ON j.id = i.job_id WHERE j.company_id = $1`,
      [company_id]
    );
    const invNumber = `INV-${String(countResult.rows[0].cnt + 1).padStart(5, '0')}`;

    const subtotal = line_items.reduce((sum: number, item: any) =>
      sum + (item.unit_price * item.quantity * (1 - (item.discount_pct ?? 0) / 100)), 0);
    const tax_amount = subtotal * tax_rate;
    const total = subtotal + tax_amount;

    const inv = await client.query(
      `INSERT INTO invoices (job_id, invoice_number, status, subtotal, tax_rate,
        tax_amount, total, amount_paid, notes, internal_notes, due_date)
       VALUES ($1,$2,'draft',$3,$4,$5,$6,0,$7,$8,$9) RETURNING *`,
      [jobId, invNumber, Math.round(subtotal*100)/100, tax_rate,
       Math.round(tax_amount*100)/100, Math.round(total*100)/100,
       notes, internal_notes, due_date ?? null]
    );
    const invoice = inv.rows[0];

    for (const item of line_items) {
      const itemTotal = item.unit_price * item.quantity * (1 - (item.discount_pct ?? 0) / 100);
      await client.query(
        `INSERT INTO line_items (parent_id, parent_type, product_id, name, description,
          quantity, unit_price, discount_pct, total, sort_order)
         VALUES ($1,'invoice',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [invoice.id, item.product_id ?? null, item.name, item.description ?? null,
         item.quantity, item.unit_price, item.discount_pct ?? 0,
         Math.round(itemTotal*100)/100, item.sort_order ?? 0]
      );
    }

    return invoice;
  });

  return created(res, invoice);
});

// ── GET /invoices/:id ──────────────────────────────────────────
invoicesGlobalRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;

  const [invResult, items, payments] = await Promise.all([
    query(
      `SELECT i.*, j.company_id, c.first_name || ' ' || c.last_name AS customer_name,
              c.email AS customer_email
       FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN customers c ON c.id = j.customer_id
       WHERE i.id = $1`,
      [id]
    ),
    query('SELECT * FROM line_items WHERE parent_id = $1 AND parent_type = $2 ORDER BY sort_order', [id, 'invoice']),
    query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC', [id]),
  ]);

  if (!invResult.rows.length || invResult.rows[0].company_id !== company_id) {
    return notFound(res, 'Invoice');
  }

  return ok(res, { ...invResult.rows[0], line_items: items.rows, payments: payments.rows });
});

// ── POST /invoices/:id/send ────────────────────────────────────
invoicesGlobalRouter.post('/:id/send', async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: generate PDF and email to customer
  const result = await query(
    `UPDATE invoices SET status='sent', sent_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND status='draft' RETURNING *`,
    [id]
  );
  if (!result.rows.length) return unprocessable(res, 'Invoice must be in draft status');
  return ok(res, result.rows[0]);
});

// ── POST /invoices/:id/payments ────────────────────────────────
invoicesGlobalRouter.post('/:id/payments', validate(paymentSchema), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { amount, method, reference_number, stripe_payment_method_id, notes } = req.body;

  const invResult = await query(
    `SELECT i.*, j.customer_id FROM invoices i JOIN jobs j ON j.id = i.job_id WHERE i.id = $1`,
    [id]
  );
  if (!invResult.rows.length) return notFound(res, 'Invoice');
  const invoice = invResult.rows[0];

  if (['paid', 'voided'].includes(invoice.status)) {
    return unprocessable(res, 'Invoice is already paid or voided');
  }

  let stripe_payment_id: string | null = null;
  let stripe_receipt_url: string | null = null;

  // Stripe card payment
  if (method === 'card' && stripe_payment_method_id) {
    const custResult = await query(
      'SELECT stripe_customer_id FROM customers WHERE id = $1',
      [invoice.customer_id]
    );
    const stripeCustomerId = custResult.rows[0]?.stripe_customer_id;

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // cents
      currency: 'usd',
      customer: stripeCustomerId ?? undefined,
      payment_method: stripe_payment_method_id,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { invoice_id: id },
    });

    if (intent.status !== 'succeeded') {
      return unprocessable(res, 'Payment was not successful');
    }

    stripe_payment_id = intent.id;
    const charge = intent.latest_charge as Stripe.Charge | null;
    stripe_receipt_url = charge?.receipt_url ?? null;
  }

  const payment = await withTransaction(async (client) => {
    const pay = await client.query(
      `INSERT INTO payments (invoice_id, amount, method, status, stripe_payment_id,
        stripe_receipt_url, reference_number, notes, paid_at)
       VALUES ($1,$2,$3,'succeeded',$4,$5,$6,$7,NOW()) RETURNING *`,
      [id, amount, method, stripe_payment_id, stripe_receipt_url, reference_number, notes]
    );

    // Update invoice amount_paid and status
    const newAmountPaid = parseFloat(invoice.amount_paid) + amount;
    const newStatus = newAmountPaid >= parseFloat(invoice.total) ? 'paid' : 'partial';

    await client.query(
      `UPDATE invoices SET amount_paid=$1, status=$2, paid_at=CASE WHEN $2='paid' THEN NOW() ELSE paid_at END,
       updated_at=NOW() WHERE id=$3`,
      [Math.round(newAmountPaid*100)/100, newStatus, id]
    );

    return pay.rows[0];
  });

  return created(res, payment);
});

// ── GET /invoices/:id/payments ─────────────────────────────────
invoicesGlobalRouter.get('/:id/payments', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await query(
    'SELECT * FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC',
    [id]
  );
  return ok(res, result.rows);
});
