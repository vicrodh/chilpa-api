/**
 * Signatures from Chilpa's builds. The same file is in chilpa-lyrics-service.
 *
 * A build that carries a key signs every request with
 * `Authorization: Chilpa-Signature t=<time>, v1=<hex>`: the time in seconds
 * since 1970 and the HMAC-SHA256 in hex of
 * `chilpa-service-v1\n{METHOD}\n{host}\n{path}\n{time}`, the path without
 * its query (crates/chilpa-api/src/service_signature.rs in Chilpa). Being an
 * authorization, it does not follow a redirect.
 *
 * The keys are the `SERVICE_KEYS` secret: `name:hex` pairs separated by
 * spaces, one per channel of builds (`ci`, `dev`, `flathub`). A signature
 * does not say which key made it; each is tried, and the one that matches
 * names the channel. This is not authentication, since a key travels inside
 * every binary that carries it: it keeps copies of Chilpa's source from
 * using the service by default.
 */

/** How far a signature's time may stray from this clock, either way. */
export const WINDOW_S = 15 * 60;

/** This clock in seconds, on every reply; a build signs its next request by it. */
export const TIME_HEADER = 'X-Chilpa-Time';
const SIGNED = /^Chilpa-Signature t=(\d{1,12}), v1=([0-9a-f]{64})$/;

/** What a build without a valid signature is told once unsigned requests are refused. */
export const REFUSAL = {
  error: 'This service answers official Chilpa builds only',
  detail: 'Requests must be signed by a Chilpa build made with its key. A fork or a build of your own can run its own service and point to it.',
  see: 'https://github.com/vicrodh/chilpa-api#forks'
};

interface Key { name: string; key: CryptoKey }

let keysFrom: string | undefined;
let keys: Promise<Key[]> = Promise.resolve([]);

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/** The keys of the secret, imported once per isolate. A pair of another shape is left out and said. */
function keysOf(secret: string | undefined): Promise<Key[]> {
  if (secret === keysFrom) {
    return keys;
  }
  keysFrom = secret;
  const pairs = (secret ?? '').split(/\s+/).filter(Boolean);
  keys = Promise.all(pairs.flatMap(pair => {
    const match = /^([a-z0-9-]{1,32}):([0-9a-f]{64})$/i.exec(pair);
    if (!match) {
      console.error('SERVICE_KEYS: a pair is not name:<64 hex>; it is left out');
      return [];
    }
    const name = match[1]!;
    return [crypto.subtle.importKey('raw', bytes(match[2]!.toLowerCase()), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
      .then(key => ({ name, key }))];
  }));
  return keys;
}

/** The channel whose key signed `request`, or undefined when none did. */
export async function signedBy(request: Request, secret: string | undefined, now = Date.now()): Promise<string | undefined> {
  const match = SIGNED.exec(request.headers.get('Authorization') ?? '');
  if (!match) {
    return undefined;
  }
  const time = match[1]!;
  const signature = match[2]!;
  if (Math.abs(Number(time) - Math.floor(now / 1_000)) > WINDOW_S) {
    return undefined;
  }
  const url = new URL(request.url);
  const host = url.hostname.replace(/\.$/, '');
  const message = new TextEncoder().encode(`chilpa-service-v1\n${request.method}\n${host}\n${url.pathname}\n${time}`);
  const mac = bytes(signature);
  for (const { name, key } of await keysOf(secret)) {
    if (await crypto.subtle.verify('HMAC', key, mac, message)) {
      return name;
    }
  }
  return undefined;
}

/**
 * Whether a request nobody signed is still answered: until `until`, an ISO
 * date such as 2026-12-31, and always when it is not set. A date that does
 * not parse keeps the service open and is said.
 */
export function unsignedAnswered(until: string | undefined, now = Date.now()): boolean {
  if (!until) {
    return true;
  }
  const end = Date.parse(until);
  if (Number.isNaN(end)) {
    console.error('UNSIGNED_UNTIL is not a date; unsigned requests are still answered');
    return true;
  }
  return now < end;
}

/** The reply with this clock in it. */
export function withTime(response: Response, now = Date.now()): Response {
  const out = new Response(response.body, response);
  out.headers.set(TIME_HEADER, String(Math.floor(now / 1_000)));
  return out;
}
