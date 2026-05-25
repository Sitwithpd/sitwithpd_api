import type { CookieOptions, Response } from 'express';
import { buildHttpOnlyCookieOptions } from './cookieOptions';

export const ACCESS_TOKEN_COOKIE = process.env.JWT_COOKIE_NAME || 'access_token';

export function getCookieMaxAgeMs(): number {
  const raw = process.env.JWT_COOKIE_MAX_AGE_MS;
  if (raw) {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 7 * 24 * 60 * 60 * 1000;
}

/** Options for Set-Cookie (httpOnly JWT). */
export function authCookieOptions(requestHost?: string): CookieOptions {
  return buildHttpOnlyCookieOptions({
    requestHost,
    explicitDomain: process.env.JWT_COOKIE_DOMAIN,
    explicitSecure: process.env.JWT_COOKIE_SECURE,
    explicitSameSite: process.env.JWT_COOKIE_SAMESITE,
    maxAge: getCookieMaxAgeMs(),
  });
}

/** Same attributes as set (minus maxAge) so the browser clears the cookie. */
export function clearAuthCookie(res: Response, requestHost?: string): void {
  const { maxAge: _m, ...base } = authCookieOptions(requestHost);
  res.clearCookie(ACCESS_TOKEN_COOKIE, base);
}
