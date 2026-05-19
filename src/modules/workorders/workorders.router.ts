import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { authenticate, allStaff, adminOrDispatcher } from '../../middleware/auth';
import { validate } from '../../middleware/errorHandler';
import { ok, created, notFound, badRequest } from '../../utils/response';

export const workOrdersRouter = Router();

// ── Schema ─────────────────────────────────────────────────────
const workOrderSchema = z.object({
  wo_number:           z.string().min(1).max(50),
  job_id:              z.string().uuid().optional().nullable(),
  customer_id:         z.string().uuid().optional().nullable(),
  date:                z.string().optional().nullable(),
  customer:            z.string().optional().nullable(),
  billing_address:     z.string().optional().nullable(),
  phone:               z.string().optional().nullable(),
  cell:                z.string().optional().nullable(),
  email:               z.string().optional().nullable(),
  complaint:           z.string().optional().nullable(),
  worked_by:           z.string().optional().nullable(),
  unit_address:        z.string().optional().nullable(),
  unit_phone:          z.string().optional().nullable(),
  unit_cell:           z.string().optional().nullable(),
  job_types:           z.array(z.string()).default([]),
  equipment:           z.array(z.any()).default([]),
  technician:          z.string().optional().nullable(),
  time_in:             z.string().optional().nullable(),
  time_out:            z.string().optional().nullable(),
  travel_time:         z.string().optional().nullable(),
  reg_hrs:             z.string().optional().nullable(),
  ot_hrs:              z.string().optional().nullable(),
  rate:                z.string().optional().nullable(),
  amount:              z.string().optional().nullable(),
  checklist:           z.array(z.string()).default([]),
  description_of_work: z.string().optional().nullable(),
  recommendations:     z.string().optional().nullable(),
  materials:           z.array(z.any()).default([]),
  service_type:        z.array(z.string()).default([]),
  total_amount:        z.string().optional().nullable(),
  print_name:          z.string().optional().nullable(),
  signature:           z.string().optional().nullable(),
  sign_date:           z.string().optional().nullable(),
});

// ── GET /work-orders ───────────────────────────────────────────
workOrdersRouter.get('/', authenticate, allStaff, async (req: Request, res: Response) => {
  const company_id = req.user!.company_id;
  const { customer_id, job_id, limit = '100', page = '1' } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const conditions = ['w.company_id = $1'];
  const params: any[] = [company_id];
  let idx = 2;

  if (customer_id) { conditions.push(`w.customer_id = $${idx++}`); params.push(customer_id); }
  if (job_id) { conditions.push(`w.job_id = $${idx++}`); params.push(job_id); }

  const where = conditions.join(' AND ');

  const result = await query(
    `SELECT w.*, u.name AS created_by_name
     FROM work_orders w
     LEFT JOIN users u ON u.id = w.created_by
     WHERE ${where}
     ORDER BY w.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, parseInt(limit), offset]
  );

  return ok(res, result.rows);
});

// ── GET /work-orders/:id ───────────────────────────────────────
workOrdersRouter.get('/:id', authenticate, allStaff, async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;

  const result = await query(
    `SELECT w.*, u.name AS created_by_name
     FROM work_orders w
     LEFT JOIN users u ON u.id = w.created_by
     WHERE w.id = $1 AND w.company_id = $2`,
    [id, company_id]
  );

  if (!result.rows.length) return notFound(res, 'Work Order');
  return ok(res, result.rows[0]);
});

// ── POST /work-orders ──────────────────────────────────────────
workOrdersRouter.post('/', authenticate, allStaff, validate(workOrderSchema),
  async (req: Request, res: Response) => {
    const company_id = req.user!.company_id;
    const created_by = req.user!.id;
    const b = req.body;

    // Check for duplicate WO number
    const existing = await query(
      `SELECT id FROM work_orders WHERE wo_number = $1 AND company_id = $2`,
      [b.wo_number, company_id]
    );
    if (existing.rows.length) {
      // Update instead of creating duplicate
      const updated = await query(
        `UPDATE work_orders SET
          job_id=$1, customer_id=$2, date=$3, customer=$4, billing_address=$5,
          phone=$6, cell=$7, email=$8, complaint=$9, worked_by=$10,
          unit_address=$11, unit_phone=$12, unit_cell=$13, job_types=$14,
          equipment=$15, technician=$16, time_in=$17, time_out=$18,
          travel_time=$19, reg_hrs=$20, ot_hrs=$21, rate=$22, amount=$23,
          checklist=$24, description_of_work=$25, recommendations=$26,
          materials=$27, service_type=$28, total_amount=$29,
          print_name=$30, signature=$31, sign_date=$32, updated_at=NOW()
         WHERE wo_number=$33 AND company_id=$34 RETURNING *`,
        [
          b.job_id ?? null, b.customer_id ?? null, b.date ?? null, b.customer ?? null,
          b.billing_address ?? null, b.phone ?? null, b.cell ?? null, b.email ?? null,
          b.complaint ?? null, b.worked_by ?? null, b.unit_address ?? null,
          b.unit_phone ?? null, b.unit_cell ?? null,
          JSON.stringify(b.job_types ?? []),
          JSON.stringify(b.equipment ?? []),
          b.technician ?? null, b.time_in ?? null, b.time_out ?? null,
          b.travel_time ?? null, b.reg_hrs ?? null, b.ot_hrs ?? null,
          b.rate ?? null, b.amount ?? null,
          JSON.stringify(b.checklist ?? []),
          b.description_of_work ?? null, b.recommendations ?? null,
          JSON.stringify(b.materials ?? []),
          JSON.stringify(b.service_type ?? []),
          b.total_amount ?? null, b.print_name ?? null, b.signature ?? null,
          b.sign_date ?? null, b.wo_number, company_id
        ]
      );
      return ok(res, updated.rows[0]);
    }

    const result = await query(
      `INSERT INTO work_orders (
        company_id, created_by, wo_number, job_id, customer_id, date, customer,
        billing_address, phone, cell, email, complaint, worked_by,
        unit_address, unit_phone, unit_cell, job_types, equipment,
        technician, time_in, time_out, travel_time, reg_hrs, ot_hrs, rate, amount,
        checklist, description_of_work, recommendations, materials, service_type,
        total_amount, print_name, signature, sign_date
       ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35
       ) RETURNING *`,
      [
        company_id, created_by, b.wo_number, b.job_id ?? null, b.customer_id ?? null,
        b.date ?? null, b.customer ?? null, b.billing_address ?? null,
        b.phone ?? null, b.cell ?? null, b.email ?? null, b.complaint ?? null,
        b.worked_by ?? null, b.unit_address ?? null, b.unit_phone ?? null,
        b.unit_cell ?? null,
        JSON.stringify(b.job_types ?? []),
        JSON.stringify(b.equipment ?? []),
        b.technician ?? null, b.time_in ?? null, b.time_out ?? null,
        b.travel_time ?? null, b.reg_hrs ?? null, b.ot_hrs ?? null,
        b.rate ?? null, b.amount ?? null,
        JSON.stringify(b.checklist ?? []),
        b.description_of_work ?? null, b.recommendations ?? null,
        JSON.stringify(b.materials ?? []),
        JSON.stringify(b.service_type ?? []),
        b.total_amount ?? null, b.print_name ?? null, b.signature ?? null,
        b.sign_date ?? null
      ]
    );

    return created(res, result.rows[0]);
  }
);

// ── DELETE /work-orders/:id ────────────────────────────────────
workOrdersRouter.delete('/:id', authenticate, adminOrDispatcher,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const company_id = req.user!.company_id;

    const result = await query(
      'DELETE FROM work_orders WHERE id = $1 AND company_id = $2 RETURNING id',
      [id, company_id]
    );
    if (!result.rows.length) return notFound(res, 'Work Order');
    return ok(res, { deleted: true });
  }
);
