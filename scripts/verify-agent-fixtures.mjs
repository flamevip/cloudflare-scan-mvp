import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIngestResult,
  isForbiddenIp,
  mergeCandidates,
  parseHttpxJsonl,
  parseNucleiJsonl,
} from '../agent/real/src/scan-agent.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentSource = readFileSync(resolve(root, 'agent/real/src/scan-agent.js'), 'utf8');

for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe']) {
  assert.equal(isForbiddenIp(address), true, `${address} must be denied`);
}
for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
  assert.equal(isForbiddenIp(address), false, `${address} must be public`);
}

const targets = ['example.com'];
const candidates = mergeCandidates(targets, 'https://api.example.com/login\nhttps://evil.com/\nnot a host\n');
assert.deepEqual(candidates.map((candidate) => candidate.url), ['https://example.com/', 'http://example.com/', 'https://api.example.com/login']);
const fallbackCandidates = mergeCandidates(targets, 'https://evil.com/\nnot a host\n');
assert.deepEqual(fallbackCandidates.map((candidate) => candidate.url), ['https://example.com/', 'http://example.com/']);
const exactUrlCandidates = mergeCandidates(['lanproxy.eventec.cn'], 'http://lanproxy.eventec.cn:8000/\n');
assert.equal(exactUrlCandidates.length, 3);
assert.equal(exactUrlCandidates[2].url, 'http://lanproxy.eventec.cn:8000/');
assert.equal(exactUrlCandidates[2].host, 'lanproxy.eventec.cn');
assert.equal(exactUrlCandidates[2].port, 8000);
assert.equal(exactUrlCandidates[2].scheme, 'http');

const httpxJsonl = [
  JSON.stringify({ url: 'https://api.example.com/login', title: 'API Login', status_code: 200, tech: ['nginx', 'node'] }),
  JSON.stringify({ url: 'https://evil.com/', title: 'Out of scope', status_code: 200 }),
].join('\n') + '\n';
const assets = parseHttpxJsonl(httpxJsonl, targets);
assert.equal(assets.length, 1);
assert.equal(assets[0].asset_key, 'https:api.example.com:443');
assert.equal(assets[0].status_code, 200);

const nucleiJsonl = [
  JSON.stringify({ 'template-id': 'safe-info', 'matched-at': 'https://api.example.com/login', info: { name: 'Safe info finding', severity: 'info' } }),
  JSON.stringify({ 'template-id': 'bad-scope', 'matched-at': 'https://evil.com/', info: { name: 'Out of scope', severity: 'high' } }),
].join('\n') + '\n';
const findings = parseNucleiJsonl(nucleiJsonl, targets);
assert.equal(findings.length, 1);
assert.equal(findings[0].template_id, 'safe-info');
assert.equal(findings[0].asset_key, 'https:api.example.com:443');

const ingest = buildIngestResult({
  mode: 'real_toolchain',
  modules: ['subdomain', 'http_probe', 'nuclei'],
  targets,
  httpxJsonl,
  nucleiJsonl,
  assets,
  findings,
  stages: [
    { name: 'subfinder', status: 'completed', duration_ms: 12, input_count: 1, output_count: 0, exit_code: 0, stdout: '', stderr: '' },
    { name: 'httpx', status: 'completed', duration_ms: 34, input_count: 3, output_count: 1, exit_code: 0, stdout: httpxJsonl, stderr: '' },
    { name: 'nuclei', status: 'completed', duration_ms: 56, input_count: 1, output_count: 1, exit_code: 0, stdout: nucleiJsonl, stderr: '' },
  ],
  outcome: { status: 'completed', reason: null },
});
assert.equal(ingest.assets.length, 1);
assert.equal(ingest.findings.length, 1);
assert.equal(ingest.artifacts.length, 1);
assert.equal(ingest.artifacts[0].type, 'agent_real_toolchain_raw');
assert.match(ingest.artifacts[0].search_content, /Safe info finding/);
for (const stage of ['subfinder', 'httpx', 'nuclei']) {
  assert.match(ingest.artifacts[0].raw_content, new RegExp(`"source":"tool-stage","name":"${stage}"`), `${stage} must always have a raw stage record`);
  assert.match(ingest.artifacts[0].search_content, new RegExp(`Stage ${stage}`), `${stage} must have a searchable stage summary`);
}
const emptyHttpx = buildIngestResult({
  mode: 'real_toolchain',
  modules: ['subdomain', 'http_probe', 'nuclei'],
  targets,
  httpxJsonl: '',
  nucleiJsonl: '',
  assets: [],
  findings: [],
  stages: [
    { name: 'subfinder', status: 'completed', duration_ms: 1, input_count: 1, output_count: 0, exit_code: 0, stdout: '', stderr: '' },
    { name: 'httpx', status: 'failed_no_reachable_urls', duration_ms: 1, input_count: 2, output_count: 0, exit_code: 0, stdout: '', stderr: '', error: 'httpx completed without finding a reachable authorized URL' },
    { name: 'nuclei', status: 'skipped_no_urls', duration_ms: 0, input_count: 0, output_count: 0, exit_code: null, stdout: '', stderr: '', skip_reason: 'no reachable authorized URLs were available' },
  ],
  outcome: { status: 'failed', reason: 'httpx: no reachable URLs' },
});
assert.match(emptyHttpx.artifacts[0].raw_content, /failed_no_reachable_urls/);
assert.match(emptyHttpx.artifacts[0].raw_content, /skipped_no_urls/);
assert.match(emptyHttpx.artifacts[0].search_content, /Outcome: failed/);
assert.match(agentSource, /lookup\(candidate\.host, \{ all: true, verbatim: true \}\)/, 'every real candidate must be resolved before tool execution');
assert.match(agentSource, /'-follow-host-redirects'/, 'httpx must only follow same-host redirects');
assert.doesNotMatch(agentSource, /'-follow-redirects'/, 'httpx must not follow unrestricted redirects');
assert.match(agentSource, /redirect: 'manual'/, 'built-in HTTP probe must not automatically follow redirects');
assert.match(agentSource, /MAX_CANDIDATES: clampNumber\([^\n]+500, 1, 500\)/, 'candidate cap must be hard-bounded at 500');
assert.match(agentSource, /'-disable-unsigned-templates'/, 'Nuclei must reject unsigned templates');
assert.ok(
  agentSource.indexOf("await heartbeat.send({ phase: 'starting' })") < agentSource.indexOf("getJson(env, '/api/agent/config')"),
  'the first heartbeat must be sent before input downloads so startup can be distinguished from callback/download failure',
);
assert.match(agentSource, /if \(!waitForSlot\) return;/, 'periodic heartbeats must be skipped instead of overlapping');
assert.match(agentSource, /custom Nuclei template paths are disabled/, 'runtime template-path overrides must be rejected');
assert.match(agentSource, /'subfinder', \['-silent', '-all', '-rl', String\(env\.RATE_LIMIT\)/, 'subfinder must honor the task rate limit');
assert.match(agentSource, /'-follow-host-redirects',[\s\S]*'-rate-limit', String\(env\.RATE_LIMIT\)/, 'httpx must honor the task rate limit');
assert.match(agentSource, /'-disable-unsigned-templates',[\s\S]*'-rate-limit', String\(env\.RATE_LIMIT\)|'-rate-limit', String\(env\.RATE_LIMIT\)[\s\S]*'-disable-unsigned-templates'/, 'Nuclei must honor the task rate limit');
assert.match(agentSource, /httpx completed without finding a reachable authorized URL/, 'empty httpx output must not silently complete the task');
assert.match(agentSource, /result\.outcome\?\.status === 'failed'[\s\S]*\/api\/agent\/fail/, 'failed toolchain outcome must be persisted before the failure callback');

console.log(JSON.stringify({
  ok: true,
  mode: 'parser-fixture',
  assets: ingest.assets.length,
  findings: ingest.findings.length,
  artifacts: ingest.artifacts.length,
  candidate_hosts: candidates.map((candidate) => candidate.host),
  fallback_candidate_hosts: fallbackCandidates.map((candidate) => candidate.host),
  exact_url_candidate: exactUrlCandidates[2].url,
  rejected_scope_examples: ['https://evil.com/', 'not a host'],
  denied_ip_examples: ['127.0.0.1', '10.0.0.1', '169.254.169.254', 'fd00::1'],
  redirect_policy: 'manual fetch and same-host-only httpx',
  startup_heartbeat_before_download: true,
  network: 'not used',
}, null, 2));
