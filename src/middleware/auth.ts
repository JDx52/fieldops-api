import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload, UserRole, AuthUser } from '../types';
import { unauthorized, forbidden } from '../utils/response';
import { query } from '../config/db';

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return unauthorized(res, 'Missing or malformed Authorization header');
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    // Verify user still exists and is active
    const result = await query(
      'SELECT id, company_id, role, name, email FROM users WHERE id = $1 AND is_active = true',
      [payload.sub]
    );
    if (!result.rows.length) {
      return unauthorized(res, 'User not found or deactivated');
    }

    req.user = result.rows[0] as AuthUser;
    next();
  } catch (err) {
    return unauthorized(res, 'Invalid or expired token');
  }
}

export function requireRoles(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return unauthorized(res);
    if (!roles.includes(req.user.role)) {
      return forbidden(res, `Requires one of: ${roles.join(', ')}`);
    }
    next();
  };
}

// Shorthand guards
export const adminOnly = requireRoles('admin');
export const adminOrDispatcher = requireRoles('admin', 'dispatcher');
export const allStaff = requireRoles('admin', 'dispatcher', 'technician');
