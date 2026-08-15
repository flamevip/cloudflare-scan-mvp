# scan-agent

Local/container agent for the scan MVP. It uses the same callback token contract as the Worker external providers.

Required environment variables:

```text
TASK_ID
SHARD_ID
AGENT_RUN_ID
CALLBACK_BASE_URL
CALLBACK_TOKEN
```

Optional:

```text
SCAN_MODE=mock|http_probe|real_toolchain  # default: mock
CONFIG_URL=/api/agent/config
TARGETS_URL=/api/agent/targets
CANDIDATES_URL=/api/agent/candidates
MODULES_JSON=["subdomain","http_probe","nuclei"]
RATE_LIMIT=50
TIMEOUT_MINUTES=30
HTTP_TIMEOUT_MS=5000
NUCLEI_TEMPLATES=/usr/local/share/nuclei-templates  # fixed; custom paths are rejected
```

Modes:

- `mock`: no network scan; builds deterministic mock assets/findings from authorized root targets and optional candidates.
- `http_probe`: bounded Node `fetch()` probe for authorized targets/candidates only.
- `real_toolchain`: requires `subfinder`, `httpx`, and/or `nuclei` based on `MODULES_JSON`; fails clearly if a required binary is missing.

Safety defaults for `real_toolchain`:

- The authorized root target is always retained as both an HTTPS and HTTP candidate, even when `subfinder` returns no subdomains or optional candidates are present.
- Candidate merge revalidates every candidate host against authorized root domains from `/api/agent/targets`.
- DNS safety filtering deduplicates hosts, uses at most five concurrent lookups, caps each lookup at five seconds and the full filter at 45 seconds, and rejects unresolved or timed-out hosts by default.
- `nuclei` uses severities `info,low,medium,high,critical`, excludes tags `dos,bruteforce,brute-force,fuzz,fuzzing,intrusive,destructive`, and runs a fixed low-impact Pilot profile from the baked template commit (security headers, robots/sitemap, technology/WAF detection, and deprecated TLS).
- Stage budgets are fixed at 1 minute for subfinder, 2 minutes for httpx, and 4 minutes for nuclei, with the remaining task time reserved for provisioning, ingest, terminal callbacks, and cleanup. A stage budget expiry is recorded as `partial_timeout`; the Agent keeps the partial stdout/stderr and continues with safe root-domain candidates.
- Rate and process timeout come from Worker-injected `RATE_LIMIT` and `TIMEOUT_MINUTES`.
- Raw artifacts contain one structured stage record for each of `subfinder`, `httpx`, and `nuclei`, including stdout, stderr, exit code, duration, input/output counts, and any skip/failure reason.
- If `httpx` produces no reachable authorized URL, diagnostics are ingested first and the task is then marked failed. Zero Nuclei findings remain a valid successful result when Nuclei had URL input.

Flow:

1. `GET /api/agent/config`
2. `GET /api/agent/targets`
3. `GET /api/agent/candidates` (empty when Hunter did not produce candidates)
4. `POST /api/agent/heartbeat`
5. Run selected mode and parse httpx/nuclei JSONL when applicable
6. `POST /api/agent/ingest`
7. `POST /api/agent/complete` or `POST /api/agent/fail`

Run locally in safe mock mode:

```bash
TASK_ID=... \
SHARD_ID=... \
AGENT_RUN_ID=... \
CALLBACK_BASE_URL=http://localhost:8787 \
CALLBACK_TOKEN=... \
SCAN_MODE=mock \
node src/scan-agent.js
```

Parser fixture verification (no network or cloud credentials):

```bash
node ../../scripts/verify-agent-fixtures.mjs
```

Build container locally:

```bash
docker build -t scan-agent:v0.1.0 .
```

The Dockerfile installs ProjectDiscovery `subfinder`, `httpx`, and `nuclei` from upstream Go modules into the image. It embeds no secrets and no target-specific data. Cloud Run Jobs should normally run this image with `SCAN_MODE=mock` first, then explicitly opt into `http_probe` or `real_toolchain` only for authorized targets.
