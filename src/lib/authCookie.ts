import type { CookieOptions, Response } from 'express';

export const ACCESS_TOKEN_COOKIE = process.env.JWT_COOKIE_NAME || 'access_token';

export function getCookieMaxAgeMs(): number {
  const raw = process.env.JWT_COOKIE_MAX_AGE_MS;
  if (raw) {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 7 * 24 * 60 * 60 * 1000;
}

function resolveSecure(): boolean {
  if (process.env.JWT_COOKIE_SECURE === 'true') return true;
  if (process.env.JWT_COOKIE_SECURE === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

function resolveSameSite(): 'lax' | 'strict' | 'none' {
  const v = (process.env.JWT_COOKIE_SAMESITE || 'lax').toLowerCase();
  if (v === 'none' || v === 'strict' || v === 'lax') return v;
  return 'lax';
}

/** Options for Set-Cookie (httpOnly JWT). */
export function authCookieOptions(): CookieOptions {
  const opts: CookieOptions = {
    httpOnly: true,
    secure: resolveSecure(),
    sameSite: resolveSameSite(),
    path: '/',
    maxAge: getCookieMaxAgeMs(),
  };
  const domain = process.env.JWT_COOKIE_DOMAIN?.trim();
  if (domain) opts.domain = domain;
  return opts;
}

/** Same attributes as set (minus maxAge) so the browser clears the cookie. */
export function clearAuthCookie(res: Response): void {
  const { maxAge: _m, ...base } = authCookieOptions();
  res.clearCookie(ACCESS_TOKEN_COOKIE, base);
}
