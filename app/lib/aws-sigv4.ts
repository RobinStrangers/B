const encoder = new TextEncoder();

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

type SignRequestOptions = {
  url: string;
  method: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  headers?: HeadersInit;
  body?: string;
  now?: Date;
};

function hex(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', ownedArrayBuffer(bytes)));
}

async function hmac(key: Uint8Array, value: string) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    ownedArrayBuffer(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, ownedArrayBuffer(encoder.encode(value))),
  );
}

function awsEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function lexical(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalQuery(url: URL) {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      lexical(leftKey, rightKey) || lexical(leftValue, rightValue),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function canonicalPath(pathname: string) {
  if (!pathname) return '/';
  return pathname
    .split('/')
    .map((segment) => {
      try {
        return awsEncode(decodeURIComponent(segment));
      } catch {
        return awsEncode(segment);
      }
    })
    .join('/');
}

function timestamp(now: Date) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function normalizedHeaderValue(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Signs a request with Signature Version 4 using Web Crypto only, so the same
 * implementation runs inside a Cloudflare Worker without Node crypto shims.
 */
export async function signAwsRequest(options: SignRequestOptions) {
  const url = new URL(options.url);
  const body = options.body ?? '';
  const payloadHash = hex(await sha256(body));
  const now = options.now ?? new Date();
  const amzDate = timestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const headers = new Headers(options.headers);

  headers.set('host', url.host);
  headers.set('x-amz-content-sha256', payloadHash);
  headers.set('x-amz-date', amzDate);
  if (options.credentials.sessionToken) {
    headers.set('x-amz-security-token', options.credentials.sessionToken);
  }

  const signedHeaderEntries = [...headers.entries()]
    .map(([key, value]) => [key.toLowerCase(), normalizedHeaderValue(value)] as const)
    .sort(([left], [right]) => lexical(left, right));
  const canonicalHeaders = `${signedHeaderEntries.map(([key, value]) => `${key}:${value}`).join('\n')}\n`;
  const signedHeaders = signedHeaderEntries.map(([key]) => key).join(';');
  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hex(await sha256(canonicalRequest)),
  ].join('\n');
  const dateKey = await hmac(encoder.encode(`AWS4${options.credentials.secretAccessKey}`), dateStamp);
  const regionKey = await hmac(dateKey, options.region);
  const serviceKey = await hmac(regionKey, options.service);
  const signingKey = await hmac(serviceKey, 'aws4_request');
  const signature = hex(await hmac(signingKey, stringToSign));

  headers.set(
    'authorization',
    `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  return headers;
}
