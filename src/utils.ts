/**
 * The client's parameters as strings: the query of a GET, or a JSON or form
 * body. Null for a body it cannot read. Nested values are dropped.
 */
export async function readParams(request: Request): Promise<Record<string, string> | null> {
  const raw: Record<string, unknown> = {};
  if (request.method === 'GET') {
    new URL(request.url).searchParams.forEach((value, key) => { raw[key] = value; });
  } else {
    const type = request.headers.get('Content-Type') || '';
    if (type.includes('application/json')) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return null;
      }
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        Object.assign(raw, body);
      }
    } else if (type.includes('application/x-www-form-urlencoded')) {
      (await request.formData()).forEach((value, key) => { raw[key] = value; });
    } else {
      return null;
    }
  }

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null && value !== undefined && typeof value !== 'object') {
      params[key] = String(value);
    }
  }
  return params;
}

/** A JSON response. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const windows = new Map<string, { count: number; resetAt: number }>();

/**
 * 30 requests a minute per IP, counted in memory. Every isolate keeps its own
 * count and Cloudflare runs many, so this slows one busy client down; it is
 * not a quota. Chilpa paces itself.
 */
export function rateLimit(request: Request): { allowed: true } | { allowed: false; retryAfter: number } {
  const client = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();

  if (windows.size > 10_000) {
    for (const [key, window] of windows) {
      if (now > window.resetAt) {
        windows.delete(key);
      }
    }
  }

  const window = windows.get(client);
  if (!window || now > window.resetAt) {
    windows.set(client, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }
  if (window.count >= MAX_PER_WINDOW) {
    return { allowed: false, retryAfter: Math.ceil((window.resetAt - now) / 1000) };
  }
  window.count++;
  return { allowed: true };
}

/**
 * One line per request for `wrangler tail`. No IP: the method and the
 * country are enough to follow a problem.
 */
export function logRequest(request: Request): void {
  console.log(JSON.stringify({
    method: request.method,
    path: new URL(request.url).pathname,
    userAgent: request.headers.get('User-Agent'),
    country: request.headers.get('CF-IPCountry')
  }));
}

/** MD5 as hex, for Last.fm signatures. Workers support MD5 in crypto.subtle. */
export async function md5(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
