import type { CookieOptions } from 'express';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeHost(host?: string): string | undefined {
  if (!host) return undefined;
  return host.split(':')[0].replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

export function isLoopbackHost(host?: string): boolean {
  const normalized = normalizeHost(host);
  return normalized !== undefined && LOOPBACK_HOSTS.has(normalized);
}

/**
 * Omit Domain on loopback / in development so cookies match the request host
 * (Postman, localhost:5000, 127.0.0.1:5000). Setting Domain=localhost breaks many clients.
 */
export function resolveCookieDomain(
  explicitDomain: string | undefined,
  requestHost?: string
): string | undefined {
  if (process.env.NODE_ENV === 'development') return undefined;
  if (isLoopbackHost(requestHost)) return undefined;

  const domain = explicitDomain?.trim();
  if (!domain) return undefined;

  const bare = domain.replace(/^\./, '').toLowerCase();
  if (LOOPBACK_HOSTS.has(bare)) return undefined;

  return domain;
}

export function resolveCookieSecure(
  explicitSecure: string | undefined,
  requestHost?: string
): boolean {
  if (explicitSecure === 'true') return true;
  if (explicitSecure === 'false') return false;
  if (process.env.NODE_ENV === 'development') return false;
  if (isLoopbackHost(requestHost)) return false;
  return process.env.NODE_ENV === 'production';
}

export function resolveCookieSameSite(
  explicitSameSite: string | undefined,
  secure: boolean
): 'lax' | 'strict' | 'none' {
  const v = (explicitSameSite || 'lax').toLowerCase();
  let sameSite: 'lax' | 'strict' | 'none' = 'lax';
  if (v === 'none' || v === 'strict' || v === 'lax') sameSite = v;
  if (sameSite === 'none' && !secure) return 'lax';
  return sameSite;
}

export interface BuildHttpOnlyCookieOptionsParams {
  requestHost?: string;
  explicitDomain?: string;
  explicitSecure?: string;
  explicitSameSite?: string;
  maxAge: number;
}

export function buildHttpOnlyCookieOptions(params: BuildHttpOnlyCookieOptionsParams): CookieOptions {
  const secure = resolveCookieSecure(params.explicitSecure, params.requestHost);
  const opts: CookieOptions = {
    httpOnly: true,
    secure,
    sameSite: resolveCookieSameSite(params.explicitSameSite, secure),
    path: '/',
    maxAge: params.maxAge,
  };

  const domain = resolveCookieDomain(params.explicitDomain, params.requestHost);
  if (domain) opts.domain = domain;

  return opts;
}
