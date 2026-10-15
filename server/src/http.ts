import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth/sessions.js';
import { SESSION_COOKIE, SESSION_TTL_MS } from './auth/sessions.js';
import { badRequest, unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
  }
  interface FastifyInstance {
    /** PUBLIC_URL is https: session cookies are Secure even when the proxy omits X-Forwarded-Proto. */
    orielSecureCookies: boolean;
  }
}

const secureCookie = (req: FastifyRequest): boolean => req.protocol === 'https' || req.server.orielSecureCookies === true;

z.config(z.locales.fr());

/** Validates `data` against a zod schema; failures → 400 `validation` with a French message. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length ? ` (${issue.path.join('.')})` : '';
  throw badRequest(`Requête invalide${where} : ${issue?.message ?? 'données incorrectes'}.`);
}

export function requireAuth(req: FastifyRequest): Auth {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: secureCookie(req),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: secureCookie(req) });
}

/** Route params are opaque ids: bounded strings only. */
export const idParam = z.string().min(1).max(128);
