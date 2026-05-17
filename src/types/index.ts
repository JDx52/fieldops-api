export type UserRole = 'admin' | 'dispatcher' | 'technician' | 'customer';
export type JobStatus = 'unscheduled' | 'scheduled' | 'en_route' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled';
export type JobPriority = 'low' | 'normal' | 'high' | 'urgent';
export type EstimateStatus = 'draft' | 'sent' | 'approved' | 'declined' | 'expired';
export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'overdue' | 'voided';
export type PaymentMethod = 'cash' | 'check' | 'card' | 'ach' | 'other';
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';
export type BillingCycle = 'monthly' | 'quarterly' | 'annually';
export type AgreementStatus = 'active' | 'expired' | 'cancelled' | 'pending';
export type NotificationChannel = 'sms' | 'email' | 'push';
export type NotificationStatus = 'queued' | 'sent' | 'failed' | 'delivered';
export type LineItemParent = 'estimate' | 'invoice';

export interface JwtPayload {
  sub: string;        // user id
  company_id: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

export interface AuthUser {
  id: string;
  company_id: string;
  role: UserRole;
  name: string;
  email: string;
}

// Augment Express Request
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
