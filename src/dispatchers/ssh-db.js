/**
 * ssh_db -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_db_query / ssh_db_list / ssh_db_dump / ssh_db_import.
 * All four use the conn ctx kind.
 *
 * handlers (injected): { query, list, dump, import }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  query: ['server', 'database', 'query'],
  list: ['server'],
  dump: ['server', 'database'],
  import: ['server', 'database'],
};

// Args common to every db handler: connection-target credentials.
function creds(a) {
  return {
    server: a.server,
    db_type: a.db_type,
    database: a.database,
    user: a.user,
    password: a.password,
    host: a.host,
    port: a.port,
    format: a.format,
  };
}

export async function handleSshDb({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_db', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_db', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_db', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'query':
      return handlers.query(makeCtx('conn', deps, {
        ...creds(a), query: a.query, collection: a.collection,
      }));

    case 'list':
      return handlers.list(makeCtx('conn', deps, creds(a)));

    case 'dump':
      return handlers.dump(makeCtx('conn', deps, {
        ...creds(a), output_file: a.output_file, gzip: a.gzip, tables: a.tables,
      }));

    case 'import':
    default:
      return handlers.import(makeCtx('conn', deps, {
        ...creds(a), input_file: a.input_file, drop: a.drop, preview: a.preview,
      }));
  }
}
