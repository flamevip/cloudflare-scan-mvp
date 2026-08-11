import { HttpError } from '../response';

const FORBIDDEN_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',
]);

export function parseProjectScope(scopeJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scopeJson || '[]');
  } catch {
    throw new HttpError(500, 'project scope is invalid JSON');
  }
  if (!Array.isArray(parsed)) throw new HttpError(500, 'project scope must be an array');
  const roots = parsed.map((item) => normalizeTarget(String(item ?? '')));
  return [...new Set(roots)];
}

export function validateTargets(rawTargets: unknown, allowedRoots: string[]): string[] {
  if (!Array.isArray(rawTargets)) throw new HttpError(400, 'targets must be an array');
  const normalizedAllowedRoots = [...new Set(allowedRoots.map((root) => normalizeTarget(root)))];
  if (normalizedAllowedRoots.length === 0) throw new HttpError(403, 'project has no authorized target scope');
  const targets = rawTargets.map((item) => normalizeTarget(String(item ?? '')));
  const unique = [...new Set(targets)];
  if (unique.length === 0) throw new HttpError(400, 'targets is required');
  if (unique.length > 10) throw new HttpError(400, 'targets exceeds MVP limit of 10');
  for (const target of unique) {
    if (!isHostInScope(target, normalizedAllowedRoots)) throw new HttpError(403, `target is outside project scope: ${target}`);
  }
  return unique;
}

export function validateTargetUrls(rawUrls: unknown, allowedRoots: string[], taskRoots: string[]): string[] {
  if (rawUrls === undefined || rawUrls === null) return [];
  if (!Array.isArray(rawUrls)) throw new HttpError(400, 'target_urls must be an array');
  const normalizedAllowedRoots = [...new Set(allowedRoots.map((root) => normalizeTarget(root)))];
  const normalizedTaskRoots = [...new Set(taskRoots.map((root) => normalizeTarget(root)))];
  const urls = rawUrls.map((item) => normalizeTargetUrl(String(item ?? ''), normalizedAllowedRoots, normalizedTaskRoots));
  const unique = [...new Set(urls)];
  if (unique.length > 10) throw new HttpError(400, 'target_urls exceeds MVP limit of 10');
  return unique;
}

export function normalizeTarget(input: string): string {
  const target = input.trim().toLowerCase();
  if (!target) throw new HttpError(400, 'target cannot be empty');
  if (target.includes('/') || target.includes(':') || target.includes('@')) {
    throw new HttpError(400, `target must be a root domain: ${input}`);
  }
  assertHostAllowed(target, input);
  if (!isValidDomain(target)) throw new HttpError(400, `invalid domain target: ${input}`);
  return target;
}

export function assertAssetInScope(hostOrUrl: string, targets: string[]): void {
  const host = extractHost(hostOrUrl);
  assertHostAllowed(host, hostOrUrl);
  if (!isHostInScope(host, targets)) {
    throw new HttpError(400, `asset host is outside task scope: ${host}`);
  }
}

export function isHostInScope(host: string, roots: string[]): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return roots.some((root) => normalizedHost === root || normalizedHost.endsWith(`.${root}`));
}

function extractHost(value: string): string {
  try {
    if (value.startsWith('http://') || value.startsWith('https://')) return new URL(value).hostname.toLowerCase();
  } catch {
    throw new HttpError(400, `invalid asset url: ${value}`);
  }
  return value.trim().toLowerCase();
}

function normalizeTargetUrl(input: string, allowedRoots: string[], taskRoots: string[]): string {
  const trimmed = input.trim();
  if (!trimmed) throw new HttpError(400, 'target_urls cannot contain empty values');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(400, `invalid target url: ${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new HttpError(400, `target url scheme is not allowed: ${input}`);
  if (parsed.username || parsed.password) throw new HttpError(400, `target url credentials are not allowed: ${input}`);
  if (parsed.hash) throw new HttpError(400, `target url fragment is not allowed: ${input}`);
  const port = explicitPort(trimmed);
  if (!port) throw new HttpError(400, `target url must include an explicit port: ${input}`);
  const host = parsed.hostname.toLowerCase();
  assertHostAllowed(host, input);
  if (!isHostInScope(host, allowedRoots)) throw new HttpError(403, `target url is outside project scope: ${host}`);
  if (!isHostInScope(host, taskRoots)) throw new HttpError(403, `target url is outside task scope: ${host}`);
  return parsed.toString();
}

function explicitPort(value: string): number | null {
  const authority = value.match(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\/([^/?#]*)/)?.[1] ?? '';
  const portText = authority.match(/:(\d+)$/)?.[1];
  if (!portText) return null;
  const port = Number(portText);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function assertHostAllowed(host: string, original: string): void {
  if (FORBIDDEN_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.onion')) {
    throw new HttpError(400, `target is not allowed: ${original}`);
  }
  if (isIpAddress(host)) throw new HttpError(400, `raw IP targets are not allowed: ${original}`);
}

function isValidDomain(value: string): boolean {
  if (value.length > 253 || !value.includes('.')) return false;
  return value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function isIpAddress(value: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return true;
  if (value.includes(':')) return true;
  return false;
}
