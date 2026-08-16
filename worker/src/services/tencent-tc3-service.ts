export interface TencentTc3Endpoint {
  host: string;
  service: string;
  version: string;
}

export interface TencentSignedRequest {
  headers: Record<string, string>;
  body: string;
}

export async function buildTencentTc3ServiceRequest(
  action: string,
  payload: unknown,
  region: string,
  secretId: string,
  secretKey: string,
  endpoint: TencentTc3Endpoint,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<TencentSignedRequest> {
  const body = JSON.stringify(payload);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${endpoint.host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedPayload = await sha256Hex(body);
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const credentialScope = `${date}/${endpoint.service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const secretDate = await hmacSha256Bytes(new TextEncoder().encode(`TC3${secretKey}`), date);
  const secretService = await hmacSha256Bytes(secretDate, endpoint.service);
  const secretSigning = await hmacSha256Bytes(secretService, 'tc3_request');
  const signature = bytesToHex(await hmacSha256Bytes(secretSigning, stringToSign));
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    body,
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      Host: endpoint.host,
      'X-TC-Action': action,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': endpoint.version,
    },
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Bytes(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const rawKey = Uint8Array.from(keyBytes).buffer;
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
