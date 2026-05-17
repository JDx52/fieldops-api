import { Request, Response, NextFunction } from 'express';
import { ZodError, ZodSchema } from 'zod';
import { badRequest, serverError } from '../utils/response';
import { logger } from '../utils/logger';

// Zod schema validation middleware
export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      return badRequest(res, 'Request body is invalid', errors);
    }
    req.body = result.data;
    next();
  };
}

// Global error handler — must be last middleware
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (err instanceof ZodError) {
    return badRequest(res, 'Validation error', err.errors);
  }

  // PostgreSQL unique violation
  if (err.code === '23505') {
    return res.status(409).json({
      data: null,
      error: { code: 'CONFLICT', message: 'Duplicate record', detail: err.detail },
    });
  }

  // PostgreSQL foreign key violation
  if (err.code === '23503') {
    return res.status(422).json({
      data: null,
      error: { code: 'REFERENCE_ERROR', message: 'Referenced record does not exist' },
    });
  }

  logger.error('Unhandled error', { err, path: req.path, method: req.method });
  return serverError(res);
}

// 404 handler for unknown routes
export function notFoundHandler(req: Request, res: Response) {
  return res.status(404).json({
    data: null,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
  });
}
