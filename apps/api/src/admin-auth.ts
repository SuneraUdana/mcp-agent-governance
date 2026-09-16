import type { FastifyRequest } from 'fastify';

export function requireAdminToken(request: FastifyRequest, configuredToken: string | undefined): { statusCode: number; error: string } | undefined {
  if (!configuredToken) return { statusCode: 503, error: 'administrative API is not configured' };
  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${configuredToken}`) return { statusCode: 401, error: 'valid administrative bearer token is required' };
  return undefined;
}
