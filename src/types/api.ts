/** Public contract of GET /api/health. Server responses remain untrusted input. */
export interface HealthResponse {
  status: 'ok';
  version: string;
  database: 'ok';
  installationId: string;
  createdAt: string;
  bootCount: number;
  serverTime: string;
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return row.status === 'ok' && row.database === 'ok'
    && typeof row.version === 'string'
    && typeof row.installationId === 'string'
    && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt))
    && typeof row.serverTime === 'string' && Number.isFinite(Date.parse(row.serverTime))
    && typeof row.bootCount === 'number' && Number.isSafeInteger(row.bootCount) && row.bootCount >= 1;
}
