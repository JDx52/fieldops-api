import { Response } from 'express';

export function ok(res: Response, data: any, meta?: any) {
  return res.status(200).json({ data, error: null, meta: meta ?? null });
}

export function created(res: Response, data: any) {
  return res.status(201).json({ data, error: null, meta: null });
}

export function noContent(res: Response) {
  return res.status(204).send();
}

export function badRequest(res: Response, message: string, errors?: any[]) {
  return res.status(400).json({
    data: null,
    error: { code: 'VALIDATION_ERROR', message, errors: errors ?? [] },
  });
}

export function unauthorized(res: Response, message = 'Unauthorized') {
  return res.status(401).json({
    data: null,
    error: { code: 'UNAUTHORIZED', message },
  });
}

export function forbidden(res: Response, message = 'Forbidden') {
  return res.status(403).json({
    data: null,
    error: { code: 'FORBIDDEN', message },
  });
}

export function notFound(res: Response, resource = 'Resource') {
  return res.status(404).json({
    data: null,
    error: { code: 'NOT_FOUND', message: `${resource} not found` },
  });
}

export function conflict(res: Response, message: string) {
  return res.status(409).json({
    data: null,
    error: { code: 'CONFLICT', message },
  });
}

export function unprocessable(res: Response, message: string) {
  return res.status(422).json({
    data: null,
    error: { code: 'UNPROCESSABLE', message },
  });
}

export function serverError(res: Response, message = 'Internal server error') {
  return res.status(500).json({
    data: null,
    error: { code: 'SERVER_ERROR', message },
  });
}

export function paginate(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
  };
}
