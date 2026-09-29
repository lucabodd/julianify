import type { FastifyRequest } from 'fastify';
import type { UserRow } from './auth.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const forbidden = (message = 'Operazione non consentita') => new HttpError(403, message);
export const notFound = (message = 'Elemento non trovato') => new HttpError(404, message);

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
  }
}

export function requireUser(request: FastifyRequest): UserRow {
  if (!request.user) throw new HttpError(401, 'Accesso richiesto');
  return request.user;
}

export function requireAdmin(request: FastifyRequest): UserRow {
  const user = requireUser(request);
  if (user.is_admin !== 1) throw forbidden('Solo gli amministratori possono farlo');
  return user;
}

export function parseId(value: unknown): number {
  const id = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificativo non valido');
  return id;
}

export function body(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Corpo della richiesta non valido');
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown, field: string, maxLength = 300): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw badRequest(`Campo "${field}" non valido`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw badRequest(`Campo "${field}" troppo lungo`);
  return trimmed === '' ? null : trimmed;
}

export function requiredString(value: unknown, field: string, maxLength = 300): string {
  const result = optionalString(value, field, maxLength);
  if (!result) throw badRequest(`Campo "${field}" obbligatorio`);
  return result;
}

export function finiteNumber(value: unknown, field: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw badRequest(`Campo "${field}" non valido`);
  }
  return value;
}

export function integer(value: unknown, field: string, min = -Infinity, max = Infinity): number {
  const result = finiteNumber(value, field, min, max);
  if (!Number.isInteger(result)) throw badRequest(`Campo "${field}" non valido`);
  return result;
}
