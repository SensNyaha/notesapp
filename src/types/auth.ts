export interface User { id: string; login: string; role: 'admin' | 'user'; mustChangePassword: boolean; temporaryExpires: number | null }
export interface Account extends User { createdAt: number; credentialVersion: number }
export function isUser(value: unknown): value is User {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.login === 'string' && (row.role === 'admin' || row.role === 'user')
    && typeof row.mustChangePassword === 'boolean' && (row.temporaryExpires === null || typeof row.temporaryExpires === 'number');
}
