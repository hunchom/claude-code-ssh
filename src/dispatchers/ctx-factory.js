/**
 * Context-object factory for v4 dispatchers.
 *
 * The existing src/tools/*.js handlers destructure six divergent context
 * shapes. makeCtx assembles the right one from registration-time deps so the
 * dispatchers stay readable. deps holds getConnection / getServerConfig /
 * resolveGroup / getSftp; only the ones a kind needs are read.
 *
 * kinds:
 *   conn        { getConnection, args }                  exec, upload, cat, ...
 *   conn-cfg    { getConnection, getServerConfig, args }  execute_sudo, sync
 *   conn-group  { getConnection, resolveGroup, args }     execute_group
 *   cfg         { getServerConfig, args }                 key_manage
 *   deploy      { getConnection, getSftp, args }          deploy / deploy-artifact
 *   args        { args }                                  session_send, tail_read, ...
 */

export function makeCtx(kind, deps, args) {
  const d = deps || {};
  switch (kind) {
    case 'conn':
      return { getConnection: d.getConnection, args };
    case 'conn-cfg':
      return { getConnection: d.getConnection, getServerConfig: d.getServerConfig, args };
    case 'conn-group':
      return { getConnection: d.getConnection, resolveGroup: d.resolveGroup, args };
    case 'cfg':
      return { getServerConfig: d.getServerConfig, args };
    case 'deploy':
      return { getConnection: d.getConnection, getSftp: d.getSftp, args };
    case 'args':
      return { args };
    default:
      throw new Error(`unknown ctx kind: ${kind}`);
  }
}
