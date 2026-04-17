/**
 * Upgraded SSH tunnel tools -- typed, preview-aware, idempotent close.
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
 *     unforwarder?: () => void // remote -- cancels client.forwardIn
 *   }
 *
 * We use ssh2's client.forwardOut / client.forwardIn exclusively.  We do NOT
 * require the ssh2 package at module load -- we duck-type the client so that
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

// --------------------------------------------------------------------------
// SOCKS5 protocol handler (RFC 1928, no-auth CONNECT only)
// --------------------------------------------------------------------------

// Reply codes -- used for the SOCKS5 response byte.
const SOCKS_REP = Object.freeze({
  SUCCEEDED:                  0x00,
  GENERAL_FAILURE:            0x01,
  CONNECTION_NOT_ALLOWED:     0x02,
  NETWORK_UNREACHABLE:        0x03,
  HOST_UNREACHABLE:           0x04,
  CONNECTION_REFUSED:         0x05,
  TTL_EXPIRED:                0x06,
  COMMAND_NOT_SUPPORTED:      0x07,
  ADDRESS_TYPE_NOT_SUPPORTED: 0x08,
});

/**
 * Build a SOCKS5 reply packet. `boundAddr` / `boundPort` are the server's
 * local binding for the outbound connection -- we return 0.0.0.0:0 because
 * we don't have a meaningful value to report (we forward via SSH).
 */
function buildSocksReply(rep, atyp = 0x01) {
  // VER REP RSV ATYP BND.ADDR BND.PORT
  if (atyp === 0x01) {
    // IPv4 binding: 4 zero bytes + 2 zero bytes
    return Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
  }
  // Fallback to IPv4 zero binding for unknown reply atyps.
  return Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

/**
 * Parse the SOCKS5 CONNECT request buffer. Returns
 *   { host, port, atyp, consumed }
 * or throws an Error if the request is malformed / unsupported.
 * Supports: ATYP 0x01 IPv4, 0x03 domain, 0x04 IPv6.
 */
export function parseSocksConnectRequest(buf) {
  if (buf.length < 10) throw new Error('short CONNECT request');
  if (buf[0] !== 0x05) throw new Error(`unsupported VER ${buf[0]}`);
  if (buf[1] !== 0x01) throw new Error(`only CMD=CONNECT supported, got ${buf[1]}`);
  // buf[2] reserved, ignore
  const atyp = buf[3];
  let host, portOffset;
  if (atyp === 0x01) {
    if (buf.length < 10) throw new Error('short IPv4 CONNECT');
    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    portOffset = 8;
  } else if (atyp === 0x03) {
    const dlen = buf[4];
    if (buf.length < 5 + dlen + 2) throw new Error('short domain CONNECT');
    host = buf.slice(5, 5 + dlen).toString('ascii');
    portOffset = 5 + dlen;
  } else if (atyp === 0x04) {
    if (buf.length < 22) throw new Error('short IPv6 CONNECT');
    const segs = [];
    for (let i = 0; i < 8; i++) segs.push(buf.readUInt16BE(4 + i * 2).toString(16));
    host = segs.join(':');
    portOffset = 20;
  } else {
    throw new Error(`unsupported ATYP ${atyp}`);
  }
  const port = buf.readUInt16BE(portOffset);
  return { host, port, atyp, consumed: portOffset + 2 };
}

/**
 * Drive one SOCKS5 session over a single client TCP socket:
 *   1. greeting (methods negotiation) -- we accept only 0x00 (no auth)
 *   2. CONNECT request -- open ssh.forwardOut to target
 *   3. bidirectional pipe until either side closes
 *
 * `sshClient` is a duck-typed ssh2 Client (.forwardOut(src, srcPort, dst,
 * dstPort, cb)).
 */
export function handleSocks5Connection(sock, sshClient) {
  let phase = 'greeting'; // greeting -> request -> streaming
  let buf = Buffer.alloc(0);
  const fail = (rep = SOCKS_REP.GENERAL_FAILURE) => {
    try { sock.write(buildSocksReply(rep)); } catch (_) { /* ignore */ }
    try { sock.end(); } catch (_) { /* ignore */ }
  };
  sock.on('error', () => { try { sock.destroy(); } catch (_) { /* ignore */ } });
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (phase === 'greeting') {
      if (buf.length < 2) return;
      if (buf[0] !== 0x05) { fail(); return; }
      const nmethods = buf[1];
      if (buf.length < 2 + nmethods) return;
      const methods = buf.slice(2, 2 + nmethods);
      buf = buf.slice(2 + nmethods);
      if (!methods.includes(0x00)) {
        // Method-not-acceptable: VER + 0xFF
        try { sock.write(Buffer.from([0x05, 0xff])); } catch (_) { /* ignore */ }
        try { sock.end(); } catch (_) { /* ignore */ }
        return;
      }
      try { sock.write(Buffer.from([0x05, 0x00])); }
      catch (_) { sock.destroy(); return; }
      phase = 'request';
    }
    if (phase === 'request') {
      let req;
      try { req = parseSocksConnectRequest(buf); }
      catch (_) {
        // Either short (need more bytes) or unsupported. Parse errors from
        // short buffers look identical to unsupported -- differentiate by
        // length.
        if (buf.length < 10) return;
        fail(SOCKS_REP.COMMAND_NOT_SUPPORTED);
        return;
      }
      buf = buf.slice(req.consumed);
      phase = 'streaming';
      sshClient.forwardOut(
        sock.remoteAddress || '127.0.0.1',
        sock.remotePort || 0,
        req.host, req.port,
        (err, stream) => {
          if (err) {
            const msg = String(err.message || '').toLowerCase();
            let code = SOCKS_REP.GENERAL_FAILURE;
            if (msg.includes('refused')) code = SOCKS_REP.CONNECTION_REFUSED;
            else if (msg.includes('unreachable')) code = SOCKS_REP.HOST_UNREACHABLE;
            fail(code);
            return;
          }
          try { sock.write(buildSocksReply(SOCKS_REP.SUCCEEDED)); }
          catch (_) { try { stream.destroy(); } catch (__) { /* ignore */ } return; }
          // Any residual bytes the client sent before the reply need to be
          // flushed into the newly-opened SSH channel (the piping begins on
          // the next `sock.on('data')` only).
          if (buf.length > 0) {
            try { stream.write(buf); } catch (_) { /* ignore */ }
            buf = Buffer.alloc(0);
          }
          sock.pipe(stream).pipe(sock);
          const cleanup = () => {
            try { stream.destroy(); } catch (_) { /* ignore */ }
            try { sock.destroy(); } catch (_) { /* ignore */ }
          };
          stream.on('close', cleanup);
          stream.on('error', cleanup);
          sock.on('close', cleanup);
        }
      );
    }
  });
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

// --------------------------------------------------------------------------
// Reachability probe (DNS + TCP)
// Used only in preview -- never blocks create if unavailable.
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// create
// --------------------------------------------------------------------------

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
  // `dynamic` (SOCKS5) tunnels don't need a fixed remote_host/remote_port --
  // each SOCKS client connection carries its own target. Only local/remote
  // require the remote endpoint upfront.
  if (type !== 'dynamic' && (!remote_host || !remote_port)) {
    return toMcp(fail('ssh_tunnel_create',
      `remote_host and remote_port required for type=${type}`, { server: server ?? null }), { format });
  }

  // -- preview -------------------------------------------------------
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
      effects.push(`opens SOCKS5 listener on ${bind}:${lport}`);
      effects.push(`each CONNECT is forwarded via ${server} (target chosen per-connection)`);
      effects.push('auth: no-authentication method only (method 0x00)');
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

  // -- execute -------------------------------------------------------
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
    if (type === 'local') {
      const listener = net.createServer((sock) => {
        const srcAddr = sock.remoteAddress || '127.0.0.1';
        const srcPort = sock.remotePort || 0;
        client.forwardOut(srcAddr, srcPort, remote_host, Number(remote_port), (err, stream) => {
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
    } else if (type === 'dynamic') {
      const listener = net.createServer((sock) => {
        handleSocks5Connection(sock, client);
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

// --------------------------------------------------------------------------
// list
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// close (idempotent)
// --------------------------------------------------------------------------

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
