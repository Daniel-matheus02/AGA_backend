export type AppRole = 'CLIENT' | 'MERCHANT' | 'ADMIN' | 'SUPPORT' | 'FINANCE' | 'TRACKING_OPERATOR';

export interface AuthenticatedUser {
  sub: string;
  tenantId: string;
  role: AppRole;
  merchantId?: string | null;
  sessionId: string;
  email: string;
}
