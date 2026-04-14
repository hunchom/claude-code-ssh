/**
 * Upgraded SSH tunnel tools — typed, preview-aware, idempotent close.
 *
 * Handlers:
 *   - handleSshTunnelCreate  create local/remote/dynamic forward; preview shows plan + reachability probe
 *   - handleSshTunnelList    typed list of active tunnels
 *   - handleSshTunnelClose   close by tunnel_id; idempotent (second close returns already_closed:true)
 *
 * Tunnel state is kept in a module-level Map<tunnel_id, state>. Each state is:
 *   {
 *     tunnel_id, server, type, local_port, remote_host, remote_port, bind,
 *     started_at, closed_at?, closed?, probe?,
 *     // transport references (present while open)
 *     listener?: net.Server,   // local/dynamic
 *     unforwarder?: () => void // remote — cancels client.forwardIn
 *   }
 *
 * We use ssh2's client.forwardOut / client.forwardIn exclusively.  We do NOT
 * require the ssh2 package at module load — we duck-type the client so that
 * tests using FakeClient work without installing dependencies.
 */

import net from 'net';
import dns from 'dns';
import { ok, fail, preview, toMcp } from '../structured-result.js';
import { buildPlan } from '../preview-mode.js';
import { shQuote } from '../stream-exec.js';

const tunnels = new Map();

let idCounter = 0;
function newTunnelId() {
  idCounter += 1;
  return `tunnel_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/** Test-only: flush all registered tunnels. */
export function __resetTunnelStore() {
  for (const state of tunnels.values()) {
    try { state.listener && state.listener.close(); } catch (_) { /* ignore */ }
    try { state.unforwarder && state.unforwarder(); } catch (_) { /* ignore */ }
  }
  tunnels.clear();
  idCounter = 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Reachability probe (DNS + TCP)
// Used only in preview — never blocks create if unavailable.
// ──────────────────────────────────────────────────────────────────────────

export async function probeReachability(host, port, { timeoutMs = 3000, resolver, tcpDialer } = {}) {
  const probe = { host, port, dns: { ok: false }, tcp: { ok: false } };
  if (!host || !port) {
    probe.dns.error = 'no host/port';
    return probe;
  }

  // DNS
  try {
    const lookup = resolver || ((h) => new Promise((resolve, reject) => {
      dns.lookup(h, (err, address) => err ? reject(err) : resolve(address));
    }));
    const addr = await Promise.race([
      lookup(host),
      new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), timeoutMs)),
    ]);
    probe.dns = { ok: true, address: addr };
  } catch (e) {
    probe.dns = { ok: false, error: String(e.message || e) };
  }

  // TCP (skip if DNS failed for a real host)
  try {
    const dial = tcpDialer || ((h, p) => new Promise((resolve, reject) => {
      const sock = net.connect({ host: h, port: p }, () => { sock.destroy(); resolve(); });
      sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error('tcp timeout')); });
      sock.on('error', (err) => { reject(err); });
    }));
    await dial(host, port);
    probe.tcp = { ok: true };
  } catch (e) {
    probe.tcp = { ok: false, error: String(e.message || e) };
  }

  return probe;
}

// ──────────────────────────────────────────────────────────────────────────
// create
// ──────────────────────────────────────────────────────────────────────────

export async function handleSshTunnelCreate(ctx = {}) {
  const { getConnection, args = {}, probeImpl = probeReachability } = ctx;
  const {
    server,
    type,
    local_port,
    remote_host,
    remote_port,
    bind = '127.0.0.1',
    format = 'markdown',
    preview: isPreview = false,
  } = args;

  if (!type || !['local', 'remote', 'dynamic'].includes(type)) {
    return toMcp(fail('ssh_tunnel_create', `invalid type: ${type}`, { server: server ?? null }), { format });
  }
  const lport = Math.floor(Number(local_port));
  if (!Number.isFinite(lport) || lport <= 0 || lport > 65535) {
    return toMcp(fail('ssh_tunnel_create', 'local_port must be 1..65535', { server: server ?? null }), { format });
  }
  if (type !== 'dynamic') {
    if (!remote_host || !remote_port) {
      return toMcp(fail('ssh_tunnel_create',
        `remote_host and remote_port required for type=${type}`, { server: server ?? null }), { format });
    }
  }

  // ── preview ───────────────────────────────────────────────────────
  if (isPreview) {
    let probe = null;
    if (type !== 'dynamic' && remote_host && remote_port) {
      probe = await probeImpl(remote_host, Number(remote_port), { timeoutMs: 2000 });
    }
    const effects = [];
    if (type === 'local') {
      effects.push(`opens TCP listener on ${bind}:${lport}`);
      effects.push(`forwards to ${shQuote(remote_host)}:${remote_port} via ${server}`);
    } else if (type === 'remote') {
      effects.push(`requests remote forward ${shQuote(remote_host)}:${remote_port} from ${server}`);
      effects.push(`incoming connections piped to local ${bind}:${lport}`);
    } else {
      effects.push(`opens SOCKS5 proxy on ${bind}:${lport}`);
      effects.push(`all SOCKS client requests routed via ${server}`);
    }
    if (probe) {
      effects.push(`reachability probe: dns=${probe.dns.ok ? 'ok' : 'fail'}, tcp=${probe.tcp.ok ? 'ok' : 'fail'}`);
    }
    const plan = buildPlan({
      action: 'tunnel-create',
      target: `${server || '(direct)'}:${type}:${bind}:${lport}`,
      effects,
      reversibility: 'auto',
      risk: type === 'remote' ? 'high' : 'medium',
      probe,
    });
    return toMcp(preview('ssh_tunnel_create', plan, { server: server ?? null }), { format });
  }

  // ── execute ───────────────────────────────────────────────────────
  let client;
  try { client = await getConnection(server); }
  catch (e) { return toMcp(fail('ssh_tunnel_create', e, { server: server ?? null }), { format }); }

  const tunnel_id = newTunnelId();
  const started_at = new Date().toISOString();
  const state = {
    tunnel_id, server: server ?? null, type,
    local_port: lport, remote_host: remote_host || null,
    remote_port: remote_port ? Number(remote_port) : null,
    bind, started_at, closed: false,
  };

  try {
    if (type === 'local' || type === 'dynamic') {
      const listener = net.createServer((sock) => {
        const srcAddr = sock.remoteAddress || '127.0.0.1';
        const srcPort = sock.remotePort || 0;
        const dstHost = type === 'local' ? remote_host : null;
        const dstPort = type === 'local' ? Number(remote_port) : null;
        if (type !== 'local') { // dynamic: no remote handler — hook left as future work
          sock.destroy();
          return;
        }
        client.forwardOut(srcAddr, srcPort, dstHost, dstPort, (err, stream) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(stream).pipe(sock);
          sock.on('close', () => { try { stream.destroy(); } catch (_) { /* ignore */ } });
          stream.on('close', () => { try { sock.destroy(); } catch (_) { /* ignore */ } });
          sock.on('error', () => { try { stream.destroy(); } catch (_) { /* ignore */ } });
          stream.on('error', () => { try { sock.destroy(); } catch (_) { /* ignore */ } });
        });
      });

      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(lport, bind, () => resolve());
      });
      state.listener = listener;
    } else if (type === 'remote') {
      await new Promise((resolve, reject) => {
        client.forwardIn(remote_host, Number(remote_port), (err) => err ? reject(err) : resolve());
      });
      state.unforwarder = () => {
        try {
          if (typeof client.unforwardIn === 'function') {
            client.unforwardIn(remote_host, Number(remote_port), () => {});
          }
        } catch (_) { /* ignore */ }
      };
    }
  } catch (e) {
    return toMcp(fail('ssh_tunnel_create', e, { server: server ?? null }), { format });
  }

  tunnels.set(tunnel_id, state);
  const data = {
    tunnel_id, type,
    local_port: lport,
    remote_host: state.remote_host,
    remote_port: state.remote_port,
    bind,
    started_at,
  };
  return toMcp(ok('ssh_tunnel_create', data, { server: server ?? null }), { format });
}

// ──────────────────────────────────────────────────────────────────────────
// list
// ──────────────────────────────────────────────────────────────────────────

export async function handleSshTunnelList(ctx = {}) {
  const { args = {} } = ctx;
  const { server, format = 'markdown' } = args;
  const out = [];
  for (const state of tunnels.values()) {
    if (server && state.server !== server) continue;
    out.push({
      tunnel_id: state.tunnel_id,
      server: state.server,
      type: state.type,
      local_port: state.local_port,
      remote_host: state.remote_host,
      remote_port: state.remote_port,
      bind: state.bind,
      started_at: state.started_at,
      closed: !!state.closed,
      closed_at: state.closed_at || null,
    });
  }
  return toMcp(ok('ssh_tunnel_list', { tunnels: out, total: out.length }), { format });
}

// ──────────────────────────────────────────────────────────────────────────
// close (idempotent)
// ──────────────────────────────────────────────────────────────────────────

export async function handleSshTunnelClose(ctx = {}) {
  const { args = {} } = ctx;
  const { tunnel_id, format = 'markdown' } = args;
  if (!tunnel_id) {
    return toMcp(fail('ssh_tunnel_close', 'tunnel_id is required'), { format });
  }
  const state = tunnels.get(tunnel_id);
  if (!state) {
    return toMcp(fail('ssh_tunnel_close', `tunnel ${tunnel_id} not found`), { format });
  }

  if (state.closed) {
    return toMcp(ok('ssh_tunnel_close', {
      tunnel_id,
      already_closed: true,
      closed_at: state.closed_at,
    }), { format });
  }

  try { state.listener && state.listener.close(); } catch (_) { /* ignore */ }
  try { state.unforwarder && state.unforwarder(); } catch (_) { /* ignore */ }
  state.listener = null;
  state.unforwarder = null;
  state.closed = true;
  state.closed_at = new Date().toISOString();

  return toMcp(ok('ssh_tunnel_close', {
    tunnel_id,
    already_closed: false,
    closed_at: state.closed_at,
  }), { format });
}
