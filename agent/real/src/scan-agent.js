import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const SAFE_NUCLEI_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
const SAFE_NUCLEI_EXCLUDE_TAGS = ['dos', 'bruteforce', 'brute-force', 'fuzz', 'fuzzing', 'intrusive', 'destructive'];
const DEFAULT_MODULES = ['subdomain', 'http_probe', 'nuclei'];
const BAKED_NUCLEI_TEMPLATES = '/usr/local/share/nuclei-templates';
const FORBIDDEN_ADDRESSES = buildForbiddenAddressList();
const IPV4_MAPPED_ADDRESSES = buildIpv4MappedAddressList();

if (isMain()) {
  runAgent().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeErr(`scan-agent failed: ${message}\n`);
    try {
      const env = readEnv();
      await callback(env, '/api/agent/fail', basePayload(env, { error_message: message }));
    } catch (callbackError) {
      writeErr(`failed to notify worker: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}\n`);
    }
    process.exitCode = 1;
  });
}

export async function runAgent(env = readEnv()) {
  env = normalizeRuntimeEnv(env);
  const [config, targetsText, candidatesText] = await Promise.all([
    getJson(env, '/api/agent/config'),
    getText(env, '/api/agent/targets'),
    getOptionalText(env, '/api/agent/candidates'),
  ]);
  const targets = parseLines(targetsText);
  if (targets.length === 0) throw new Error('no targets downloaded');
  const modules = resolveModules(env, config);
  const candidates = mergeCandidates(targets, candidatesText).slice(0, env.MAX_CANDIDATES);

  await callback(env, '/api/agent/heartbeat', basePayload(env, {
    phase: 'downloaded_inputs',
    target_count: targets.length,
    candidate_count: candidates.length,
    modules,
    scan_mode: env.SCAN_MODE,
  }));

  const stopHeartbeat = startHeartbeatLoop(env);
  try {
    assertWithinDeadline(env);
    const result = await executeScanMode(env, { config, targets, modules, candidates });
    assertWithinDeadline(env);
    await callback(env, '/api/agent/ingest', {
      ...basePayload(env),
      assets: result.assets,
      findings: result.findings,
      artifacts: result.artifacts,
    });

    await stopHeartbeat();
    await callback(env, '/api/agent/complete', basePayload(env, { exit_code: 0 }));
    writeOut(`scan-agent completed task ${env.TASK_ID} mode=${env.SCAN_MODE} assets=${result.assets.length} findings=${result.findings.length}\n`);
    return result;
  } finally {
    await stopHeartbeat();
  }
}

async function executeScanMode(env, input) {
  if (env.SCAN_MODE === 'mock') return runMockMode(input.targets, input.candidates, input.modules);
  if (env.SCAN_MODE === 'http_probe') return runHttpProbeMode(env, input.targets, input.candidates, input.modules);
  if (env.SCAN_MODE === 'real_toolchain') return runRealToolchainMode(env, input.targets, input.candidates, input.modules);
  throw new Error(`unsupported SCAN_MODE: ${env.SCAN_MODE}`);
}

function runMockMode(targets, candidates, modules) {
  const urls = candidates.length ? candidates : targets.map((target) => normalizeCandidate(`https://www.${target}`, targets)).filter(Boolean);
  const httpxJsonl = urls.map((candidate) => JSON.stringify({
    url: candidate.url,
    host: candidate.host,
    port: candidate.port,
    scheme: candidate.scheme,
    title: `Agent mock ${candidate.host}`,
    status_code: 200,
    tech: ['scan-agent', 'mock'],
  })).join('\n') + '\n';
  const assets = parseHttpxJsonl(httpxJsonl, targets);
  const findings = assets.map((asset) => ({
    unique_key: `${asset.asset_key}:agent-info`,
    asset_key: asset.asset_key,
    severity: 'info',
    title: `Agent observed ${asset.host}`,
    template_id: 'agent-info',
    matched_at: asset.url,
  }));
  return buildIngestResult({ mode: 'mock', modules, targets, httpxJsonl, nucleiJsonl: '', assets, findings });
}

async function runHttpProbeMode(env, targets, candidates, modules) {
  const initial = candidates.length ? candidates : targets.map((target) => normalizeCandidate(`https://www.${target}`, targets)).filter(Boolean);
  const urls = await filterSafeCandidates(initial.slice(0, env.MAX_CANDIDATES));
  const records = [];
  for (const candidate of urls) {
    assertWithinDeadline(env);
    records.push(await fetchProbe(env, candidate));
  }
  const httpxJsonl = records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
  const assets = parseHttpxJsonl(httpxJsonl, targets);
  const findings = assets.map((asset) => ({
    unique_key: `${asset.asset_key}:agent-info`,
    asset_key: asset.asset_key,
    severity: 'info',
    title: `Agent observed ${asset.host}`,
    template_id: 'agent-info',
    matched_at: asset.url,
  }));
  return buildIngestResult({ mode: 'http_probe', modules, targets, httpxJsonl, nucleiJsonl: '', assets, findings });
}

async function runRealToolchainMode(env, targets, initialCandidates, modules) {
  const required = [];
  if (modules.includes('subdomain')) required.push('subfinder');
  if (modules.includes('http_probe')) required.push('httpx');
  if (modules.includes('nuclei')) required.push('nuclei');
  await assertRequiredBinaries(required);

  const workdir = await mkdtemp(join(tmpdir(), 'scan-agent-'));
  try {
    let candidates = await filterSafeCandidates([...initialCandidates].slice(0, env.MAX_CANDIDATES));
    if (modules.includes('subdomain')) {
      const discovered = await runSubfinder(env, workdir, targets);
      candidates = await filterSafeCandidates(mergeCandidates(targets, [...candidates.map((candidate) => candidate.url), ...discovered].join('\n')).slice(0, env.MAX_CANDIDATES));
    }
    let httpxJsonl = '';
    let assets = [];
    if (modules.includes('http_probe')) {
      httpxJsonl = await runHttpx(env, workdir, candidates);
      assets = parseHttpxJsonl(httpxJsonl, targets);
    } else {
      assets = candidates.map(candidateToAsset);
    }

    let nucleiJsonl = '';
    let findings = [];
    if (modules.includes('nuclei') && assets.length > 0) {
      nucleiJsonl = await runNuclei(env, workdir, assets.map((asset) => asset.url).filter(Boolean));
      findings = parseNucleiJsonl(nucleiJsonl, targets);
    }
    return buildIngestResult({ mode: 'real_toolchain', modules, targets, httpxJsonl, nucleiJsonl, assets, findings });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function fetchProbe(env, candidate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(env.HTTP_TIMEOUT_MS, remainingMs(env)));
  try {
    const response = await fetch(candidate.url, { signal: controller.signal, redirect: 'manual' });
    const text = await response.text();
    const title = text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || response.headers.get('server') || candidate.host;
    return {
      url: response.url || candidate.url,
      host: new URL(response.url || candidate.url).hostname,
      port: candidate.port,
      scheme: candidate.scheme,
      title,
      status_code: response.status,
      tech: ['scan-agent', 'fetch'],
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runSubfinder(env, workdir, targets) {
  const output = [];
  for (const target of targets) {
    assertWithinDeadline(env);
    const result = await runCommand('subfinder', ['-silent', '-all', '-rl', String(env.RATE_LIMIT), '-d', target], { cwd: workdir, timeoutMs: Math.min(env.TOOL_TIMEOUT_MS, remainingMs(env)) });
    output.push(...parseLines(result.stdout));
    if (output.length >= env.MAX_CANDIDATES) break;
  }
  return output.slice(0, env.MAX_CANDIDATES);
}

async function runHttpx(env, workdir, candidates) {
  const inputFile = join(workdir, 'httpx-input.txt');
  await writeFile(inputFile, candidates.map((candidate) => candidate.url).join('\n') + '\n');
  const result = await runCommand('httpx', [
    '-json',
    '-silent',
    '-follow-host-redirects',
    '-rate-limit', String(env.RATE_LIMIT),
    '-timeout', String(Math.max(1, Math.min(30, Math.floor(env.HTTP_TIMEOUT_MS / 1000)))),
    '-l', inputFile,
  ], { cwd: workdir, timeoutMs: Math.min(env.TOOL_TIMEOUT_MS, remainingMs(env)) });
  return result.stdout;
}

async function runNuclei(env, workdir, urls) {
  const inputFile = join(workdir, 'nuclei-input.txt');
  await writeFile(inputFile, urls.join('\n') + '\n');
  const args = [
    '-jsonl',
    '-silent',
    '-rate-limit', String(env.RATE_LIMIT),
    '-severity', SAFE_NUCLEI_SEVERITIES.join(','),
    '-exclude-tags', SAFE_NUCLEI_EXCLUDE_TAGS.join(','),
    '-disable-update-check',
    '-disable-unsigned-templates',
    '-l', inputFile,
  ];
  if (env.NUCLEI_TEMPLATES) args.push('-templates', env.NUCLEI_TEMPLATES);
  const result = await runCommand('nuclei', args, { cwd: workdir, timeoutMs: Math.min(env.TOOL_TIMEOUT_MS, remainingMs(env)) });
  return result.stdout;
}

async function filterSafeCandidates(candidates) {
  const safe = [];
  for (const candidate of candidates) {
    try {
      const addresses = await lookup(candidate.host, { all: true, verbatim: true });
      if (!addresses.length || addresses.some((entry) => isForbiddenIp(entry.address))) {
        writeErr(`candidate rejected by resolved IP policy: ${candidate.host}\n`);
        continue;
      }
      safe.push(candidate);
    } catch (error) {
      writeErr(`candidate DNS resolution failed: ${candidate.host}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return safe;
}

export function isForbiddenIp(address) {
  const version = isIP(address);
  if (version === 0) return true;
  if (version === 6 && IPV4_MAPPED_ADDRESSES.check(address, 'ipv6')) return true;
  return FORBIDDEN_ADDRESSES.check(address, version === 4 ? 'ipv4' : 'ipv6');
}

function buildForbiddenAddressList() {
  const blockList = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ]) blockList.addSubnet(network, prefix, 'ipv4');
  for (const [network, prefix] of [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96],
    ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ]) blockList.addSubnet(network, prefix, 'ipv6');
  return blockList;
}

function buildIpv4MappedAddressList() {
  const blockList = new BlockList();
  blockList.addSubnet('::ffff:0.0.0.0', 96, 'ipv6');
  return blockList;
}

export function mergeCandidates(targets, candidateText) {
  const downloaded = dedupeCandidates(parseLines(candidateText || '').map((line) => normalizeCandidate(line, targets)).filter(Boolean));
  if (downloaded.length) return downloaded;
  return dedupeCandidates(targets.map((target) => normalizeCandidate(`https://${target}`, targets)).filter(Boolean));
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    if (!seen.has(candidate.url)) {
      seen.add(candidate.url);
      deduped.push(candidate);
    }
  }
  return deduped;
}

export function normalizeCandidate(value, targets) {
  try {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return null;
    const parsed = new URL(trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    if (!hostInScope(host, targets)) return null;
    const scheme = parsed.protocol.replace(':', '') || 'https';
    const port = Number(parsed.port || (scheme === 'http' ? 80 : 443));
    return { url: parsed.toString(), host, port, scheme };
  } catch {
    return null;
  }
}

export function parseHttpxJsonl(jsonl, targets) {
  const assets = [];
  for (const record of parseJsonl(jsonl)) {
    const url = firstString(record.url, record.input, record.host);
    const candidate = normalizeCandidate(url, targets);
    if (!candidate) continue;
    const scheme = firstString(record.scheme) ?? candidate.scheme;
    const port = firstNumber(record.port) ?? candidate.port;
    const assetKey = `${scheme}:${candidate.host}:${port}`;
    assets.push({
      asset_key: assetKey,
      url: candidate.url,
      host: candidate.host,
      ip: firstString(record.host_ip, record.a, record.ip) ?? null,
      port,
      scheme,
      title: firstString(record.title, record.web_title) ?? candidate.host,
      status_code: firstNumber(record.status_code, record.status_code_string),
      technologies: normalizeTechnologies(record.tech, record.technologies),
    });
  }
  return dedupeBy(assets, (asset) => asset.asset_key);
}

export function parseNucleiJsonl(jsonl, targets) {
  const findings = [];
  for (const record of parseJsonl(jsonl)) {
    const matchedAt = firstString(record['matched-at'], record.matched_at, record.host, record.url);
    const candidate = normalizeCandidate(matchedAt, targets);
    if (!candidate) continue;
    const templateId = firstString(record['template-id'], record.template_id) ?? 'nuclei-finding';
    const info = typeof record.info === 'object' && record.info !== null ? record.info : {};
    const severity = firstString(info.severity, record.severity) ?? 'info';
    const title = firstString(info.name, record.name) ?? templateId;
    findings.push({
      unique_key: `${candidate.scheme}:${candidate.host}:${candidate.port}:${templateId}:${matchedAt}`,
      asset_key: `${candidate.scheme}:${candidate.host}:${candidate.port}`,
      severity,
      title,
      template_id: templateId,
      matched_at: matchedAt ?? candidate.url,
      metadata: record,
    });
  }
  return dedupeBy(findings, (finding) => finding.unique_key);
}

export function buildIngestResult({ mode, modules, targets, httpxJsonl, nucleiJsonl, assets, findings }) {
  const toolchainMetadata = collectToolchainMetadata();
  const rawContent = [
    JSON.stringify({ source: 'scan-agent-toolchain', toolchain_metadata: toolchainMetadata }),
    httpxJsonl ? `{"source":"httpx"}\n${httpxJsonl}` : '',
    nucleiJsonl ? `{"source":"nuclei"}\n${nucleiJsonl}` : '',
  ].filter(Boolean).join('\n');
  const searchContent = buildSearchMarkdown({ mode, modules, targets, assets, findings, toolchainMetadata });
  return {
    assets,
    findings,
    artifacts: [{
      type: mode === 'real_toolchain' ? 'agent_real_toolchain_raw' : mode === 'http_probe' ? 'http_probe_raw' : 'agent_mock_raw',
      raw_content: rawContent || assets.map((asset) => JSON.stringify(asset)).join('\n') + (assets.length ? '\n' : ''),
      search_content: searchContent,
      sha256: sha256(rawContent || searchContent),
      size: (rawContent || searchContent).length,
      toolchain_metadata: toolchainMetadata,
    }],
  };
}

function buildSearchMarkdown({ mode, modules, targets, assets, findings, toolchainMetadata }) {
  const lines = [`# Scan agent results`, '', `Mode: ${mode}`, `Modules: ${modules.join(', ')}`, `Targets: ${targets.join(', ')}`, `Toolchain: ${JSON.stringify(toolchainMetadata)}`, ''];
  for (const asset of assets) {
    lines.push(`## Asset ${asset.host}`, '', `URL: ${asset.url ?? ''}`, `Status: ${asset.status_code ?? ''}`, `Title: ${asset.title ?? ''}`, `Technologies: ${(asset.technologies ?? []).join(', ')}`, '');
  }
  for (const finding of findings) {
    lines.push(`## Finding ${finding.title}`, '', `Severity: ${finding.severity}`, `Template: ${finding.template_id ?? ''}`, `Matched: ${finding.matched_at ?? ''}`, '');
  }
  return lines.join('\n');
}

function collectToolchainMetadata() {
  const manifestPath = process.env.TOOLCHAIN_MANIFEST_PATH || '/usr/local/share/scan-agent/toolchain.json';
  const shaPath = process.env.TOOLCHAIN_SHA256_PATH || '/usr/local/share/scan-agent/toolchain-sha256.txt';
  const metadata = {
    status: 'unavailable',
    manifest_path: manifestPath,
    sha256_path: shaPath,
    manifest: null,
    binary_sha256: {},
  };
  try {
    if (existsSync(manifestPath)) {
      metadata.manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      metadata.status = 'available';
    }
    if (existsSync(shaPath)) {
      for (const line of readFileSync(shaPath, 'utf8').split(/\r?\n/)) {
        const match = line.trim().match(/^([a-fA-F0-9]{64})\s+(.+)$/);
        if (match) metadata.binary_sha256[match[2].split('/').pop()] = match[1].toLowerCase();
      }
      metadata.status = metadata.manifest ? 'available' : 'checksums_only';
    }
  } catch (error) {
    metadata.status = 'unavailable';
    metadata.error = error instanceof Error ? error.message : String(error);
  }
  return metadata;
}

function candidateToAsset(candidate) {
  return {
    asset_key: `${candidate.scheme}:${candidate.host}:${candidate.port}`,
    url: candidate.url,
    host: candidate.host,
    ip: null,
    port: candidate.port,
    scheme: candidate.scheme,
    title: candidate.host,
    status_code: null,
    technologies: ['scan-agent', 'candidate'],
  };
}

function resolveModules(env, config) {
  if (env.MODULES) return normalizeModules(env.MODULES.split(','));
  if (env.MODULES_JSON) return normalizeModules(JSON.parse(env.MODULES_JSON));
  if (Array.isArray(config.modules)) return normalizeModules(config.modules);
  return DEFAULT_MODULES;
}

function normalizeModules(value) {
  const modules = value.map((item) => String(item).trim()).filter(Boolean);
  return modules.length ? [...new Set(modules)] : DEFAULT_MODULES;
}

function readEnv() {
  const input = {
    TASK_ID: process.env.TASK_ID ?? '',
    SHARD_ID: process.env.SHARD_ID ?? '',
    AGENT_RUN_ID: process.env.AGENT_RUN_ID ?? '',
    CALLBACK_BASE_URL: (process.env.CALLBACK_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, ''),
    CALLBACK_TOKEN: process.env.CALLBACK_TOKEN ?? '',
    CONFIG_URL: process.env.CONFIG_URL || '/api/agent/config',
    TARGETS_URL: process.env.TARGETS_URL || '/api/agent/targets',
    CANDIDATES_URL: process.env.CANDIDATES_URL || '/api/agent/candidates',
    MODULES: process.env.MODULES || '',
    MODULES_JSON: process.env.MODULES_JSON || '',
    RATE_LIMIT: clampNumber(process.env.RATE_LIMIT, 50, 1, 1000),
    TIMEOUT_MINUTES: clampNumber(process.env.TIMEOUT_MINUTES, 30, 1, 240),
    SCAN_MODE: process.env.SCAN_MODE ?? 'mock',
    HTTP_TIMEOUT_MS: clampNumber(process.env.HTTP_TIMEOUT_MS, 5000, 500, 30000),
    TOOL_TIMEOUT_MS: clampNumber(Number(process.env.TIMEOUT_MINUTES ?? '30') * 60 * 1000, 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000),
    HEARTBEAT_INTERVAL_SECONDS: clampNumber(process.env.AGENT_HEARTBEAT_INTERVAL_SECONDS, 30, 5, 300),
    MAX_CANDIDATES: clampNumber(process.env.AGENT_MAX_CANDIDATES, 500, 1, 500),
    NUCLEI_TEMPLATES: resolveNucleiTemplates(process.env.NUCLEI_TEMPLATES),
  };
  for (const key of ['TASK_ID', 'SHARD_ID', 'AGENT_RUN_ID', 'CALLBACK_TOKEN']) {
    if (!input[key]) throw new Error(`${key} is required`);
  }
  if (!['mock', 'http_probe', 'real_toolchain'].includes(input.SCAN_MODE)) throw new Error(`unsupported SCAN_MODE: ${input.SCAN_MODE}`);
  return input;
}

function resolveNucleiTemplates(value) {
  const configured = String(value || BAKED_NUCLEI_TEMPLATES).trim();
  if (configured !== BAKED_NUCLEI_TEMPLATES) throw new Error('custom Nuclei template paths are disabled; use the templates baked into the signed image');
  return BAKED_NUCLEI_TEMPLATES;
}

function normalizeRuntimeEnv(env) {
  const timeoutMinutes = clampNumber(env.TIMEOUT_MINUTES, 30, 1, 240);
  return {
    ...env,
    TIMEOUT_MINUTES: timeoutMinutes,
    HEARTBEAT_INTERVAL_SECONDS: clampNumber(env.HEARTBEAT_INTERVAL_SECONDS, 30, 5, 300),
    MAX_CANDIDATES: clampNumber(env.MAX_CANDIDATES, 500, 1, 500),
    DEADLINE_AT: Number(env.DEADLINE_AT) || Date.now() + timeoutMinutes * 60 * 1000,
  };
}

function startHeartbeatLoop(env) {
  let stopped = false;
  let sequence = 0;
  let inFlight = null;
  const tick = () => {
    if (stopped || inFlight) return;
    let remainingSeconds;
    try {
      remainingSeconds = Math.max(0, Math.floor(remainingMs(env) / 1000));
    } catch {
      return;
    }
    sequence += 1;
    inFlight = callback(env, '/api/agent/heartbeat', basePayload(env, {
      phase: 'running',
      sequence,
      remaining_seconds: remainingSeconds,
    })).catch((error) => {
      writeErr(`heartbeat ${sequence} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => {
      inFlight = null;
    });
  };
  const timer = setInterval(tick, env.HEARTBEAT_INTERVAL_SECONDS * 1000);
  timer.unref?.();
  return async () => {
    if (!stopped) {
      stopped = true;
      clearInterval(timer);
    }
    if (inFlight) await inFlight;
  };
}

function remainingMs(env) {
  const remaining = Number(env.DEADLINE_AT) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error(`task exceeded timeout of ${env.TIMEOUT_MINUTES} minute(s)`);
  return remaining;
}

function assertWithinDeadline(env) {
  remainingMs(env);
}

function basePayload(env, extra = {}) {
  return {
    task_id: env.TASK_ID,
    shard_id: env.SHARD_ID,
    agent_run_id: env.AGENT_RUN_ID,
    ...extra,
  };
}

async function getJson(env, path) {
  const response = await authedFetch(env, path);
  return response.json();
}

async function getText(env, path) {
  const response = await authedFetch(env, path);
  return response.text();
}

async function getOptionalText(env, path) {
  try {
    return await getText(env, path);
  } catch {
    return '';
  }
}

async function callback(env, path, body) {
  const response = await authedFetch(env, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  writeOut(`${path}: ${response.status} ${text}\n`);
  return text;
}

async function authedFetch(env, path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${env.CALLBACK_TOKEN}`);
  const controller = new AbortController();
  const deadlineCap = Number.isFinite(Number(env.DEADLINE_AT)) ? remainingMs(env) : 30_000;
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(30_000, deadlineCap)));
  try {
    const response = await fetch(resolveAgentUrl(env, path), { ...init, headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveAgentUrl(env, path) {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${env.CALLBACK_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

async function assertRequiredBinaries(binaries) {
  const missing = [];
  for (const binary of binaries) {
    if (!(await binaryExists(binary))) missing.push(binary);
  }
  if (missing.length) {
    throw new Error(`real_toolchain requires missing binaries: ${missing.join(', ')}. Install subfinder/httpx/nuclei or run SCAN_MODE=mock/http_probe for local dry-run.`);
  }
}

async function binaryExists(binary) {
  const paths = String(process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of paths) {
    try {
      await access(join(dir, binary), fsConstants.X_OK);
      return true;
    } catch {
      // Continue checking PATH entries.
    }
  }
  return false;
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
      forceKill.unref?.();
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${truncate(stderr || stdout)}`));
    });
  });
}

function parseJsonl(jsonl) {
  const records = [];
  for (const line of parseLines(jsonl)) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Ignore malformed tool lines rather than failing the whole ingest.
    }
  }
  return records;
}

function parseLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function hostInScope(host, targets) {
  const normalized = host.toLowerCase();
  return targets.some((target) => normalized === target || normalized.endsWith(`.${target}`));
}

function normalizeTechnologies(...values) {
  const tech = [];
  for (const value of values) {
    if (Array.isArray(value)) tech.push(...value.map(String));
    else if (typeof value === 'string' && value.trim()) tech.push(...value.split(',').map((item) => item.trim()));
  }
  return [...new Set(tech.filter(Boolean))];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(item);
    }
  }
  return output;
}

function clampNumber(value, fallback, min, max) {
  const num = Number(value ?? fallback);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function truncate(value, max = 1000) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function isMain() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(fileURLToPath(pathToFileURL(process.argv[1]))).href;
}

function writeOut(message) {
  process.stdout.write(message);
}

function writeErr(message) {
  process.stderr.write(message);
}
