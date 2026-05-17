/**
 * ssh_net -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_tunnel_create / _list / _close and ssh_port_test.
 * tunnel-open + port-test use conn ctx; tunnel-list + tunnel-close use args.
 * v4 `tunnel_type` maps to the tunnel handler's `type` arg.
 *
 * handlers (injected): { tunnelCreate, tunnelList, tunnelClose, portTest }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  'tunnel-open': ['server', 'tunnel_type'],
  'tunnel-list': [],
  'tunnel-close': ['tunnel_id'],
  'port-test': ['target_host'],
};

export async function handleSshNet({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_net', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_net', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_net', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'tunnel-open':
      return handlers.tunnelCreate(makeCtx('conn', deps, {
        server: a.server,
        type: a.tunnel_type,
        bind: a.bind, // handler destructures `bind`, not local_host
        local_port: a.local_port,
        remote_host: a.remote_host,
        remote_port: a.remote_port,
        preview: a.preview,
        format: a.format,
      }));

    case 'tunnel-list':
      return handlers.tunnelList(makeCtx('args', deps, {
        server: a.server, format: a.format,
      }));

    case 'tunnel-close':
      return handlers.tunnelClose(makeCtx('args', deps, {
        tunnel_id: a.tunnel_id, format: a.format,
      }));

    case 'port-test':
    default:
      return handlers.portTest(makeCtx('conn', deps, {
        server: a.server,
        target_host: a.target_host,
        target_port: a.target_port,
        probe_chain: a.probe_chain,
        timeout_ms_per_probe: a.timeout_ms_per_probe,
        continue_on_fail: a.continue_on_fail,
        format: a.format,
      }));
  }
}
