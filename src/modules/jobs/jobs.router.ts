import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../config/db';
import { authenticate, adminOrDispatcher, allStaff } from '../../middleware/auth';
import { validate } from '../../middleware/errorHandler';
import { ok, created, notFound, unprocessable, badRequest, paginate } from '../../utils/response';
import { JobStatus } from '../../types';

export const jobsRouter = Router();

// ── Schemas ───────────────────────────────────────────────────
const createJobSchema = z.object({
  customer_id: z.string().uuid(),
  location_id: z.string().uuid(),
  agreement_id: z.string().uuid().optional().nullable(),
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  priority: z.enum(['low','normal','high','urgent']).default('normal'),
  scheduled_start: z.string().datetime().optional(),
  scheduled_end: z.string().datetime().optional(),
  technician_ids: z.array(z.string().uuid()).default([]),
  internal_notes: z.string().optional(),
});

const updateJobSchema = createJobSchema.partial();

const statusSchema = z.object({
  status: z.enum(['unscheduled','scheduled','en_route','in_progress','on_hold','completed','cancelled']),
});

const assignSchema = z.object({
  technician_ids: z.array(z.string().uuid()).min(1),
  is_lead: z.string().uuid().optional(),  // which tech is lead
});

const timeEntrySchema = z.object({
  action: z.enum(['clock_in','clock_out']),
  notes: z.string().optional(),
});

// Valid job status transitions
const STATUS_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  unscheduled: ['scheduled', 'cancelled'],
  scheduled:   ['unscheduled', 'en_route', 'cancelled'],
  en_route:    ['in_progress', 'scheduled', 'cancelled'],
  in_progress: ['completed', 'on_hold', 'cancelled'],
  on_hold:     ['in_progress', 'cancelled'],
  completed:   [],
  cancelled:   [],
};

async function generateJobNumber(companyId: string, client: any): Promise<string> {
  const result = await client.query(
    `SELECT COUNT(*)::int AS cnt FROM jobs WHERE company_id = $1`,
    [companyId]
  );
  const num = String(result.rows[0].cnt + 1).padStart(5, '0');
  return `JOB-${num}`;
}

// ── GET /jobs ──────────────────────────────────────────────────
jobsRouter.get('/', authenticate, adminOrDispatcher, async (req: Request, res: Response) => {
  const {
    status, tech_id, date_from, date_to,
    page = '1', limit = '50', priority,
  } = req.query as Record<string, string>;

  const company_id = req.user!.company_id;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const conditions = ['j.company_id = $1'];
  const params: any[] = [company_id];
  let idx = 2;

  if (status) { conditions.push(`j.status = $${idx++}`); params.push(status); }
  if (priority) { conditions.push(`j.priority = $${idx++}`); params.push(priority); }
  if (date_from) { conditions.push(`j.scheduled_start >= $${idx++}`); params.push(date_from); }
  if (date_to) { conditions.push(`j.scheduled_start <= $${idx++}`); params.push(date_to); }
  if (tech_id) {
    conditions.push(`EXISTS (SELECT 1 FROM job_assignments ja WHERE ja.job_id = j.id AND ja.technician_id = $${idx++})`);
    params.push(tech_id);
  }

  const where = conditions.join(' AND ');

  const [rows, count] = await Promise.all([
    query(
      `SELECT j.*,
              c.first_name || ' ' || c.last_name AS customer_name,
              sl.address_line1, sl.city, sl.state,
              COALESCE(
                json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY ja.is_lead DESC)
                FILTER (WHERE u.id IS NOT NULL), '[]'
              ) AS technicians
       FROM jobs j
       JOIN customers c ON c.id = j.customer_id
       JOIN service_locations sl ON sl.id = j.location_id
       LEFT JOIN job_assignments ja ON ja.job_id = j.id
       LEFT JOIN users u ON u.id = ja.technician_id
       WHERE ${where}
       GROUP BY j.id, c.first_name, c.last_name, sl.address_line1, sl.city, sl.state
       ORDER BY j.scheduled_start ASC NULLS LAST, j.priority DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, parseInt(limit), offset]
    ),
    query(`SELECT COUNT(DISTINCT j.id)::int AS total FROM jobs j WHERE ${where}`, params),
  ]);

  return ok(res, rows.rows, paginate(parseInt(page), parseInt(limit), count.rows[0].total));
});

// ── POST /jobs ─────────────────────────────────────────────────
jobsRouter.post('/', authenticate, adminOrDispatcher, validate(createJobSchema),
  async (req: Request, res: Response) => {
    const company_id = req.user!.company_id;
    const { technician_ids, ...jobData } = req.body;

    const result = await withTransaction(async (client) => {
      const job_number = await generateJobNumber(company_id, client);
      const status = jobData.scheduled_start ? 'scheduled' : 'unscheduled';

      const jobResult = await client.query(
        `INSERT INTO jobs (company_id, customer_id, location_id, agreement_id, job_number, title,
          description, priority, status, scheduled_start, scheduled_end, internal_notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [company_id, jobData.customer_id, jobData.location_id, jobData.agreement_id ?? null,
         job_number, jobData.title, jobData.description, jobData.priority, status,
         jobData.scheduled_start ?? null, jobData.scheduled_end ?? null,
         jobData.internal_notes ?? null, req.user!.id]
      );
      const job = jobResult.rows[0];

      // Assign technicians
      for (const [i, techId] of technician_ids.entries()) {
        await client.query(
          `INSERT INTO job_assignments (job_id, technician_id, is_lead)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [job.id, techId, i === 0]
        );
      }

      return job;
    });

    return created(res, result);
  }
);

// ── GET /jobs/:id ──────────────────────────────────────────────
jobsRouter.get('/:id', authenticate, allStaff, async (req: Request, res: Response) => {
  const { id } = req.params;
  const company_id = req.user!.company_id;

  // Technicians can only see their own jobs
  let techFilter = '';
  const params: any[] = [id, company_id];
  if (req.user!.role === 'technician') {
    techFilter = `AND EXISTS (
      SELECT 1 FROM job_assignments ja
      WHERE ja.job_id = j.id AND ja.technician_id = $3
    )`;
    params.push(req.user!.id);
  }

  const jobResult = await query(
    `SELECT j.*,
            c.first_name || ' ' || c.last_name AS customer_name,
            c.phone AS customer_phone, c.email AS customer_email,
            sl.address_line1, sl.address_line2, sl.city, sl.state, sl.zip,
            sl.lat, sl.lng, sl.access_notes
     FROM jobs j
     JOIN customers c ON c.id = j.customer_id
     JOIN service_locations sl ON sl.id = j.location_id
     WHERE j.id = $1 AND j.company_id = $2 ${techFilter}`,
    params
  );

  if (!jobResult.rows.length) return notFound(res, 'Job');
  const job = jobResult.rows[0];

  const [techs, photos, timeEntries, estimates, invoices] = await Promise.all([
    query(
      `SELECT u.id, u.name, u.phone, u.email, ja.is_lead
       FROM job_assignments ja JOIN users u ON u.id = ja.technician_id
       WHERE ja.job_id = $1`,
      [id]
    ),
    query('SELECT * FROM job_photos WHERE job_id = $1 ORDER BY taken_at DESC', [id]),
    query(
      `SELECT te.*, u.name AS technician_name
       FROM time_entries te JOIN users u ON u.id = te.user_id
       WHERE te.job_id = $1 ORDER BY te.clock_in DESC`,
      [id]
    ),
    query('SELECT id, estimate_number, status, total FROM estimates WHERE job_id = $1', [id]),
    query('SELECT id, invoice_number, status, total, balance_due FROM invoices WHERE job_id = $1', [id]),
  ]);

  return ok(res, {
    ...job,
    technicians: techs.rows,
    photos: photos.rows,
    time_entries: timeEntries.rows,
    estimates: estimates.rows,
    invoices: invoices.rows,
  });
});

// ── PATCH /jobs/:id ────────────────────────────────────────────
jobsRouter.patch('/:id', authenticate, adminOrDispatcher, validate(updateJobSchema),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const company_id = req.user!.company_id;
    const { technician_ids, ...fields } = req.body;

    const allowed = ['title','description','priority','scheduled_start','scheduled_end',
                     'internal_notes','location_id','agreement_id'];
    const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));

    if (updates.length) {
      const setClause = updates.map(([k], i) => `${k} = $${i + 3}`).join(', ');
      await query(
        `UPDATE jobs SET ${setClause}, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
        [id, company_id, ...updates.map(([, v]) => v)]
      );
    }

    // Update technicians if provided
    if (technician_ids) {
      await withTransaction(async (client) => {
        await client.query('DELETE FROM job_assignments WHERE job_id = $1', [id]);
        for (const [i, techId] of technician_ids.entries()) {
          await client.query(
            `INSERT INTO job_assignments (job_id, technician_id, is_lead) VALUES ($1,$2,$3)`,
            [id, techId, i === 0]
          );
        }
      });
    }

    const result = await query('SELECT * FROM jobs WHERE id = $1', [id]);
    if (!result.rows.length) return notFound(res, 'Job');
    return ok(res, result.rows[0]);
  }
);

// ── PATCH /jobs/:id/status ─────────────────────────────────────
jobsRouter.patch('/:id/status', authenticate, allStaff, validate(statusSchema),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const company_id = req.user!.company_id;
    const { status: newStatus } = req.body;

    const result = await query(
      'SELECT status FROM jobs WHERE id = $1 AND company_id = $2',
      [id, company_id]
    );
    if (!result.rows.length) return notFound(res, 'Job');

    const currentStatus = result.rows[0].status as JobStatus;
    if (!STATUS_TRANSITIONS[currentStatus].includes(newStatus)) {
      return unprocessable(
        res,
        `Cannot transition from '${currentStatus}' to '${newStatus}'`
      );
    }

    const extraFields: Record<string, string> = {};
    if (newStatus === 'in_progress' && !result.rows[0].actual_start) {
      extraFields['actual_start'] = 'NOW()';
    }
    if (newStatus === 'completed') {
      extraFields['actual_end'] = 'NOW()';
    }

    const extraSql = Object.entries(extraFields)
      .map(([k, v]) => `, ${k} = ${v}`)
      .join('');

    const updated = await query(
      `UPDATE jobs SET status = $1 ${extraSql}, updated_at = NOW()
       WHERE id = $2 AND company_id = $3 RETURNING *`,
      [newStatus, id, company_id]
    );

    return ok(res, updated.rows[0]);
  }
);

// ── POST /jobs/:id/assignments ─────────────────────────────────
jobsRouter.post('/:id/assignments', authenticate, adminOrDispatcher, validate(assignSchema),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { technician_ids, is_lead } = req.body;

    await withTransaction(async (client) => {
      for (const techId of technician_ids) {
        await client.query(
          `INSERT INTO job_assignments (job_id, technician_id, is_lead)
           VALUES ($1,$2,$3) ON CONFLICT (job_id, technician_id) DO NOTHING`,
          [id, techId, techId === is_lead]
        );
      }
    });

    const result = await query(
      `SELECT u.id, u.name, u.phone, ja.is_lead FROM job_assignments ja
       JOIN users u ON u.id = ja.technician_id WHERE ja.job_id = $1`,
      [id]
    );
    return ok(res, result.rows);
  }
);

// ── DELETE /jobs/:id/assignments/:uid ──────────────────────────
jobsRouter.delete('/:id/assignments/:uid', authenticate, adminOrDispatcher,
  async (req: Request, res: Response) => {
    const { id, uid } = req.params;
    await query('DELETE FROM job_assignments WHERE job_id = $1 AND technician_id = $2', [id, uid]);
    return ok(res, { removed: true });
  }
);

// ── Photos ─────────────────────────────────────────────────────
jobsRouter.get('/:id/photos', authenticate, allStaff, async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await query(
    `SELECT p.*, u.name AS uploaded_by_name FROM job_photos p
     JOIN users u ON u.id = p.uploaded_by
     WHERE p.job_id = $1 ORDER BY p.taken_at DESC`,
    [id]
  );
  return ok(res, result.rows);
});

jobsRouter.post('/:id/photos', authenticate, allStaff, async (req: Request, res: Response) => {
  // In production: use multer middleware + upload to S3, then save URL
  const { id } = req.params;
  const { url, thumbnail_url, caption } = req.body;

  if (!url) return badRequest(res, 'url is required');

  const result = await query(
    `INSERT INTO job_photos (job_id, uploaded_by, url, thumbnail_url, caption)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, req.user!.id, url, thumbnail_url, caption]
  );
  return created(res, result.rows[0]);
});

jobsRouter.delete('/:id/photos/:pid', authenticate, adminOrDispatcher,
  async (req: Request, res: Response) => {
    const { pid } = req.params;
    await query('DELETE FROM job_photos WHERE id = $1', [pid]);
    return ok(res, { deleted: true });
  }
);

// ── Time Entries ───────────────────────────────────────────────
jobsRouter.get('/:id/time-entries', authenticate, adminOrDispatcher,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const result = await query(
      `SELECT te.*, u.name AS technician_name,
              EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in))/60 AS minutes_elapsed
       FROM time_entries te JOIN users u ON u.id = te.user_id
       WHERE te.job_id = $1 ORDER BY te.clock_in DESC`,
      [id]
    );
    return ok(res, result.rows);
  }
);

jobsRouter.post('/:id/time-entries', authenticate, allStaff, validate(timeEntrySchema),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { action, notes } = req.body;
    const user_id = req.user!.id;

    if (action === 'clock_in') {
      // Check not already clocked in
      const open = await query(
        'SELECT id FROM time_entries WHERE job_id = $1 AND user_id = $2 AND clock_out IS NULL',
        [id, user_id]
      );
      if (open.rows.length) return unprocessable(res, 'Already clocked in on this job');

      const result = await query(
        `INSERT INTO time_entries (job_id, user_id, clock_in)
         VALUES ($1,$2,NOW()) RETURNING *`,
        [id, user_id]
      );
      return created(res, result.rows[0]);
    } else {
      // Clock out
      const open = await query(
        'SELECT id FROM time_entries WHERE job_id = $1 AND user_id = $2 AND clock_out IS NULL',
        [id, user_id]
      );
      if (!open.rows.length) return unprocessable(res, 'Not currently clocked in');

      const result = await query(
        `UPDATE time_entries SET clock_out = NOW(), notes = $3
         WHERE id = $1 AND user_id = $2 RETURNING *`,
        [open.rows[0].id, user_id, notes]
      );
      return ok(res, result.rows[0]);
    }
  }
);

// ── Signature ──────────────────────────────────────────────────
jobsRouter.post('/:id/signature', authenticate, allStaff, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { signature } = req.body; // base64 PNG
  if (!signature) return badRequest(res, 'signature is required');

  await query(
    `UPDATE jobs SET customer_signature = $1, updated_at = NOW() WHERE id = $2`,
    [signature, id]
  );
  return ok(res, { saved: true });
});
// ── Job Notes ──────────────────────────────────────────────────
jobsRouter.get('/:id/notes', authenticate, allStaff, async (req: Request, res: Response) => {
  const { id } = req.params;
  const notes = await query(
    `SELECT n.*, u.name AS author_name FROM job_notes n
     LEFT JOIN users u ON u.id = n.created_by
     WHERE n.job_id = $1 ORDER BY n.created_at DESC`,
    [id]
  );
  return ok(res, notes.rows);
});

jobsRouter.post('/:id/notes', authenticate, allStaff, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { content, note_type = 'general' } = req.body;
  if (!content) return badRequest(res, 'content is required');

  const result = await query(
    `INSERT INTO job_notes (job_id, created_by, content, note_type)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, req.user!.id, co
