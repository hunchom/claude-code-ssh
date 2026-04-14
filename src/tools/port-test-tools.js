/**
 * ssh_port_test — run a chain of network probes FROM a remote server.
 *
 * Probes (each optional, executed in order the caller provides):
 *   - dns:   `getent hosts HOST` or `nslookup HOST` fallback → resolved_ip, ttl?
 *   - tcp:   `nc -z -w T HOST PORT` (or bash /dev/tcp fallback) → tcp_open, latency_ms
 *   - tls:   `openssl s_client … | openssl x509 …` → tls_cert (subject, dates, sha256 fp)
 *   - http:  `curl -sS -o /dev/null -w "%{http_code} %{time_total}"` → http_status, time_seconds
 *
 * Parsing functions are exported for unit testing without touching SSH.
 */

import { streamExecCommand, shQuote } from '../stream-exec.js';
import { ok, fail, toMcp } from '../structured-result.js';

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_CHAIN = ['dns', 'tcp', 'tls', 'http'];

// ──────────────────────────────────────────────────────────────────────────
// Parsers — pure, exported for tests.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse `getent hosts HOST` output:
 *   93.184.216.34   example.com
 *   2606:2800:220:1:248:1893:25c8:1946 example.com
 * Falls back to `nslookup HOST` format:
 *   Name:    example.com
 *   Address: 93.184.216.34
 */
export function parseDnsOutput(text) {
  if (!text) return { resolved_ip: null };
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // getent format: first whitespace-separated token is the IP.
  for (const line of lines) {
    // Skip lines that look like nslookup-style "Name:" / "Server:" headers.
    if (/^(Server|Address|Name|Non-authoritative)\s*[:#]/i.test(line)) continue;
    const tok = line.split(/\s+/)[0];
    if (isIPv4(tok) || isIPv6(tok)) {
      return { resolved_ip: tok };
    }
  }
  // nslookup format: search for the LAST "Address: X" (first is DNS server).
  let lastAddr = null;
  for (const line of lines) {
    const m = line.match(/^Address\s*[:#]\s*([0-9a-fA-F.:]+)/);
    if (m) lastAddr = m[1];
  }
  if (lastAddr && (isIPv4(lastAddr) || isIPv6(lastAddr))) return { resolved_ip: lastAddr };
  return { resolved_ip: null };
}

function isIPv4(s) { return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s); }
function isIPv6(s) { return s.includes(':') && /^[0-9a-fA-F:]+$/.test(s); }

/**
 * Parse TCP probe result. The remote command is expected to echo a trailer like:
 *    TCP_LATENCY_MS=12
 * when the connection succeeds (we construct it that way below). Exit code
 * governs tcp_open.
 */
export function parseTcpOutput(stdout, stderr, exitCode) {
  const text = (stdout || '') + '\n' + (stderr || '');
  const latencyMatch = text.match(/TCP_LATENCY_MS=(\d+(?:\.\d+)?)/);
  const open = exitCode === 0;
  const out = { tcp_open: open };
  if (latencyMatch) out.latency_ms = Number(latencyMatch[1]);
  if (!open) {
    // Extract a useful error snippet
    const errSnip = (stderr || stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' ');
    if (errSnip) out.error = errSnip;
    else out.error = `exit ${exitCode}`;
  }
  return out;
}

/**
 * Parse openssl x509 -noout -subject -dates -fingerprint -sha256 output:
 *   subject=CN = example.com
 *   notBefore=Mar  1 00:00:00 2024 GMT
 *   notAfter=Mar  1 23:59:59 2025 GMT
 *   sha256 Fingerprint=AB:CD:...:FF
 */
export function parseTlsOutput(text) {
  if (!text) return null;
  const out = {};
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^subject\s*=/i.test(line)) {
      out.subject = line.replace(/^subject\s*=\s*/i, '');
    } else if (/^notBefore\s*=/i.test(line)) {
      out.not_before = line.replace(/^notBefore\s*=\s*/i, '');
    } else if (/^notAfter\s*=/i.test(line)) {
      out.not_after = line.replace(/^notAfter\s*=\s*/i, '');
    } else if (/sha256 ?fingerprint/i.test(line)) {
      const m = line.match(/fingerprint\s*=\s*(.+)$/i);
      if (m) out.sha256_fp = m[1].trim();
    }
  }
  if (!out.subject && !out.sha256_fp) return null;
  return out;
}

/**
 * Parse curl -w "%{http_code} %{time_total}" output like:
 *   "200 0.145"
 */
export function parseHttpOutput(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const m = trimmed.match(/^(\d{3})\s+([\d.]+)/);
  if (!m) return null;
  return {
    http_status: parseInt(m[1], 10),
    time_seconds: Number(m[2]),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Remote command builders (exported for tests).
// ──────────────────────────────────────────────────────────────────────────

export function buildDnsCommand(host) {
  const h = shQuote(host);
  // Try getent first (works on glibc / Linux by default). Fall back to nslookup.
  return `getent hosts ${h} 2>/dev/null || nslookup ${h} 2>/dev/null`;
}

export function buildTcpCommand(host, port, timeoutMs) {
  const h = shQuote(host);
  const p = Math.max(1, Math.floor(Number(port)) || 0);
  const timeoutSecs = Math.max(1, Math.ceil(Number(timeoutMs) / 1000));
  // Use bash to measure latency. Two strategies tried in order:
  //  1) nc -z -w TIMEOUT HOST PORT
  //  2) bash /dev/tcp fallback
  // We capture start/end epoch-millis around the successful strategy and echo
  // TCP_LATENCY_MS=N for the parser.
  return [
    `bash -c '`,
    `start=$(date +%s%3N 2>/dev/null || echo 0); `,
    `if command -v nc >/dev/null 2>&1; then `,
    `  nc -z -w ${timeoutSecs} ${h} ${p} && rc=0 || rc=$?; `,
    `else `,
    `  timeout ${timeoutSecs} bash -c "cat </dev/tcp/${host}/${p}" >/dev/null 2>&1 && rc=0 || rc=$?; `,
    `fi; `,
    `end=$(date +%s%3N 2>/dev/null || echo 0); `,
    `if [ "$rc" = "0" ] && [ "$end" != "0" ] && [ "$start" != "0" ]; then `,
    `  echo "TCP_LATENCY_MS=$((end - start))"; `,
    `fi; `,
    `exit $rc'`,
  ].join('');
}

export function buildTlsCommand(host, port, timeoutMs) {
  const h = shQuote(host);
  const p = Math.max(1, Math.floor(Number(port)) || 443);
  const timeoutSecs = Math.max(1, Math.ceil(Number(timeoutMs) / 1000));
  // -servername enables SNI; -connect does the actual connect. Output is piped
  // to openssl x509 which parses the server cert and prints subject/dates/fp.
  return [
    `echo | timeout ${timeoutSecs} openssl s_client -servername ${h} -connect ${h}:${p} 2>/dev/null `,
    `| openssl x509 -noout -subject -dates -fingerprint -sha256 2>/dev/null`,
  ].join('');
}

export function buildHttpCommand(host, port, timeoutMs) {
  const h = shQuote(host);
  const p = Math.max(1, Math.floor(Number(port)) || 80);
  const scheme = (p === 443) ? 'https' : 'http';
  const timeoutSecs = Math.max(1, Math.ceil(Number(timeoutMs) / 1000));
  // The URL is built with shell substitution from quoted host so the host value
  // cannot break out of its quotes. Port/scheme are numeric/derived.
  return `curl -sS -k -o /dev/null -w "%{http_code} %{time_total}" --connect-timeout ${timeoutSecs} --max-time ${timeoutSecs} ${scheme}://${h}:${p}/`;
}

// ──────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────

export async function handleSshPortTest(ctx = {}) {
  const { getConnection, args = {} } = ctx;
  const {
    server,
    target_host,
    target_port,
    probe_chain,
    timeout_ms_per_probe = DEFAULT_PROBE_TIMEOUT_MS,
    continue_on_fail = false,
    format = 'markdown',
  } = args;

  if (!target_host) {
    return toMcp(fail('ssh_port_test', 'target_host is required', { server: server ?? null }), { format });
  }
  if (!target_port && (probe_chain || DEFAULT_CHAIN).some(p => p !== 'dns')) {
    return toMcp(fail('ssh_port_test', 'target_port is required for non-dns probes', { server: server ?? null }), { format });
  }

  const host = String(target_host);
  const port = target_port != null ? Math.floor(Number(target_port)) : null;

  // Default chain: dns, tcp, and tls/http only when appropriate for the port.
  let chain = Array.isArray(probe_chain) && probe_chain.length ? probe_chain.slice() : DEFAULT_CHAIN.slice();
  if (!args.probe_chain) {
    chain = chain.filter(step => {
      if (step === 'tls') return port === 443;
      if (step === 'http') return port === 80 || port === 443;
      return true;
    });
  }

  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_port_test', e, { server: server ?? null }), { format });
  }

  const probes = [];
  let overall_ok = true;

  for (const step of chain) {
    const t0 = Date.now();
    try {
      let cmd; let parseFn;
      if (step === 'dns') {
        cmd = buildDnsCommand(host);
        parseFn = (r) => parseDnsOutput(r.stdout);
      } else if (step === 'tcp') {
        cmd = buildTcpCommand(host, port, timeout_ms_per_probe);
        parseFn = (r) => parseTcpOutput(r.stdout, r.stderr, r.code);
      } else if (step === 'tls') {
        cmd = buildTlsCommand(host, port || 443, timeout_ms_per_probe);
        parseFn = (r) => {
          const parsed = parseTlsOutput(r.stdout);
          return parsed ? { tls_cert: parsed } : { tls_cert: null, error: 'no certificate returned' };
        };
      } else if (step === 'http') {
        cmd = buildHttpCommand(host, port || 80, timeout_ms_per_probe);
        parseFn = (r) => {
          const parsed = parseHttpOutput(r.stdout);
          return parsed || { error: 'unparseable curl output', raw: (r.stdout || '').trim().slice(0, 120) };
        };
      } else {
        probes.push({
          name: step, ok: false,
          duration_ms: 0,
          data: { error: `unknown probe: ${step}` },
        });
        overall_ok = false;
        if (!continue_on_fail) break;
        continue;
      }

      const result = await streamExecCommand(client, cmd, {
        timeoutMs: Math.max(1000, Number(timeout_ms_per_probe) + 2000),
      });
      const data = parseFn(result);
      // Determine ok per probe:
      let probeOk = result.code === 0;
      if (step === 'dns') probeOk = !!data.resolved_ip;
      if (step === 'tcp') probeOk = !!data.tcp_open;
      if (step === 'tls') probeOk = !!(data.tls_cert && data.tls_cert.sha256_fp);
      if (step === 'http') probeOk = Number.isFinite(data.http_status) && data.http_status < 500;

      probes.push({
        name: step,
        ok: probeOk,
        duration_ms: Date.now() - t0,
        data,
      });
      if (!probeOk) {
        overall_ok = false;
        if (!continue_on_fail) break;
      }
    } catch (e) {
      probes.push({
        name: step,
        ok: false,
        duration_ms: Date.now() - t0,
        data: { error: String(e.message || e) },
      });
      overall_ok = false;
      if (!continue_on_fail) break;
    }
  }

  const data = {
    target_host: host,
    target_port: port,
    probes,
    overall_ok,
  };
  return toMcp(ok('ssh_port_test', data, { server: server ?? null }), { format });
}
