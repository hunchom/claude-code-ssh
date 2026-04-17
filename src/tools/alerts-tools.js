/**
 * ssh_alert_setup -- threshold-based alerting on top of ssh_health_check.
 *
 * Three actions:
 *   - set:   persist {cpu, memory, disk, enabled} for a server to the
 *            operator-local store (~/.ssh-manager/alerts/<server>.json).
 *   - get:   read the persisted config for a server.
 *   - check: run ssh_health_check, compare each metric against the persisted
 *            thresholds, return {alerts:[...], alert_count, status}.
 *
 * We deliberately store thresholds on the operator's machine (not on the
 * target host). Reasons:
 *
 *   - Multiple operators targeting the same fleet don't overwrite each
 *     other's thresholds.
 *   - No sudo / remote filesystem writes are needed to configure alerts.
 *   - Thresholds survive target-host reboots or disk changes.
 *
 * This is a *setup + on-demand check* tool. There is no background runner --
 * operators wire `check` into cron, CI, or an `ssh_hooks` action to get
 * continuous monitoring behavior. That choice keeps the MCP server stateless
 * and composable.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ok, fail, toMcp, defaultRender } from '../structured-result.js';
import { handleSshHealthCheck } from './monitoring-tools.js';

const ALERTS_DIR = path.join(os.homedir(), '.ssh-manager', 'alerts');

// Defaults are deliberately conservative -- set() stores thresholds explicitly,
// we don't silently infer "you probably meant 80%".
const VALID_ACTIONS = new Set(['set', 'get', 'check']);

function configPathFor(server) {
  // Server names are already normalized to [a-z0-9_-] via server-aliases; guard
  // anyway so a crafted name can't escape ALERTS_DIR.
  const safe = String(server).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return path.join(ALERTS_DIR, `${safe}.json`);
}

function readConfig(server) {
  const p = configPathFor(server);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.version === 'number') {
      return parsed;
    }
  } catch (_) { /* corrupt file -> treat as missing */ }
  return null;
}

function writeConfig(server, cfg) {
  fs.mkdirSync(ALERTS_DIR, { recursive: true });
  const p = configPathFor(server);
  // Atomic write: tmp + rename so a crash mid-write can't corrupt the file.
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  return p;
}

function evaluateThresholds(metrics, cfg) {
  const alerts = [];
  // CPU usage: metrics.cpu.usage_percent (see monitoring-tools.parseTopCpu).
  const cpuPct = Number(metrics?.cpu?.usage_percent);
  if (Number.isFinite(cpuPct) && Number.isFinite(cfg.cpuThreshold) && cpuPct >= cfg.cpuThreshold) {
    alerts.push({
      metric: 'cpu', observed: cpuPct, threshold: cfg.cpuThreshold,
      message: `CPU at ${cpuPct.toFixed(1)}% >= threshold ${cfg.cpuThreshold}%`,
    });
  }
  // Memory used%: parseFreeMem returns { total_bytes, used_bytes, free_bytes, used_percent }.
  const memPct = Number(metrics?.memory?.used_percent);
  if (Number.isFinite(memPct) && Number.isFinite(cfg.memoryThreshold) && memPct >= cfg.memoryThreshold) {
    alerts.push({
      metric: 'memory', observed: memPct, threshold: cfg.memoryThreshold,
      message: `memory at ${memPct.toFixed(1)}% >= threshold ${cfg.memoryThreshold}%`,
    });
  }
  // Disk: parseDf returns an array of { filesystem, mount, used_percent, ... }.
  if (Array.isArray(metrics?.disk) && Number.isFinite(cfg.diskThreshold)) {
    for (const fs_ of metrics.disk) {
      const pct = Number(fs_?.used_percent);
      if (Number.isFinite(pct) && pct >= cfg.diskThreshold) {
        alerts.push({
          metric: 'disk', mount: fs_.mount || fs_.filesystem,
          observed: pct, threshold: cfg.diskThreshold,
          message: `disk ${fs_.mount || fs_.filesystem} at ${pct.toFixed(1)}% >= threshold ${cfg.diskThreshold}%`,
        });
      }
    }
  }
  return alerts;
}

function renderAlertResult(result) {
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const lines = [];
  const srv = result.server ? ` | \`${result.server}\`` : '';
  lines.push(`[ok] **ssh_alert_setup**${srv} | action: \`${d.action}\``);
  if (d.action === 'set') {
    lines.push('');
    lines.push(`thresholds saved to \`${d.config_path}\``);
    lines.push('```json');
    lines.push(JSON.stringify(d.config, null, 2));
    lines.push('```');
  } else if (d.action === 'get') {
    lines.push('');
    if (d.config) {
      lines.push('```json');
      lines.push(JSON.stringify(d.config, null, 2));
      lines.push('```');
    } else {
      lines.push('_no alert config_ -- run with `action=set` first');
    }
  } else if (d.action === 'check') {
    lines.push('');
    lines.push(`status: \`${d.status}\` | alerts: ${d.alert_count}`);
    if (d.alerts && d.alerts.length > 0) {
      for (const a of d.alerts) lines.push(`- **${a.metric}**: ${a.message}`);
    }
  }
  return lines.join('\n');
}

export async function handleSshAlertSetup({ getConnection, args }) {
  const {
    server, action,
    cpuThreshold, memoryThreshold, diskThreshold,
    enabled = true,
    format = 'markdown',
  } = args || {};

  if (!server) {
    return toMcp(fail('ssh_alert_setup', 'server is required'), { format, renderer: renderAlertResult });
  }
  if (!action || !VALID_ACTIONS.has(action)) {
    return toMcp(fail('ssh_alert_setup',
      `action must be one of: ${[...VALID_ACTIONS].join(', ')}`, { server }),
    { format, renderer: renderAlertResult });
  }

  try {
    if (action === 'set') {
      const cfg = {
        version: 1,
        server,
        enabled: !!enabled,
        cpuThreshold: Number.isFinite(Number(cpuThreshold)) ? Number(cpuThreshold) : null,
        memoryThreshold: Number.isFinite(Number(memoryThreshold)) ? Number(memoryThreshold) : null,
        diskThreshold: Number.isFinite(Number(diskThreshold)) ? Number(diskThreshold) : null,
        updated_at: new Date().toISOString(),
      };
      const p = writeConfig(server, cfg);
      return toMcp(ok('ssh_alert_setup', {
        action: 'set', config: cfg, config_path: p,
      }, { server }), { format, renderer: renderAlertResult });
    }

    if (action === 'get') {
      const cfg = readConfig(server);
      return toMcp(ok('ssh_alert_setup', {
        action: 'get', config: cfg, config_path: configPathFor(server),
      }, { server }), { format, renderer: renderAlertResult });
    }

    // action === 'check'
    const cfg = readConfig(server);
    if (!cfg) {
      return toMcp(fail('ssh_alert_setup',
        'no alert configuration found for this server; run with action=set first', { server }),
      { format, renderer: renderAlertResult });
    }
    if (cfg.enabled === false) {
      return toMcp(ok('ssh_alert_setup', {
        action: 'check', status: 'disabled',
        thresholds: cfg, alert_count: 0, alerts: [],
      }, { server }), { format, renderer: renderAlertResult });
    }

    // Delegate to the existing health aggregator so parsers stay in one place.
    const hc = await handleSshHealthCheck({ getConnection, args: { server, format: 'json' } });
    if (hc.isError) {
      const parsed = safeJson(hc.content?.[0]?.text);
      return toMcp(fail('ssh_alert_setup',
        `health_check failed: ${parsed?.error || 'unknown'}`, { server }),
      { format, renderer: renderAlertResult });
    }
    const parsed = safeJson(hc.content?.[0]?.text);
    if (!parsed || !parsed.success) {
      return toMcp(fail('ssh_alert_setup',
        `health_check returned malformed payload: ${parsed?.error || 'no data'}`, { server }),
      { format, renderer: renderAlertResult });
    }

    const alerts = evaluateThresholds(parsed.data, cfg);
    const status = alerts.length === 0 ? 'ok' : 'alerts_triggered';

    return toMcp(ok('ssh_alert_setup', {
      action: 'check', status, thresholds: cfg,
      alert_count: alerts.length, alerts,
      current_metrics: {
        cpu: parsed.data?.cpu || null,
        memory: parsed.data?.memory || null,
        disk: parsed.data?.disk || null,
      },
    }, { server }), { format, renderer: renderAlertResult });
  } catch (e) {
    return toMcp(fail('ssh_alert_setup', e, { server }),
      { format, renderer: renderAlertResult });
  }
}

function safeJson(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); }
  catch (_) { return null; }
}

// Exported for tests.
export const __internals = {
  configPathFor, readConfig, writeConfig, evaluateThresholds, ALERTS_DIR,
};
