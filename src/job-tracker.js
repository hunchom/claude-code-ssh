/**
 * ssh_run detach / job-status / job-kill engine. Job state lives on the
 * REMOTE host under ~/.ssh-manager/jobs/<id>/ as three files: rc (exit code,
 * written on completion), pid, log. Completion is decided by the rc file's
 * presence -- never by PID liveness -- so there is no PID-reuse race and a
 * job survives an MCP restart or a pooled-connection eviction.
 *
 * Pure: builders return POSIX-sh strings, parseJobStatus turns raw stdout
 * into a structured status. The dispatcher (Plan 4) execs and reads the log
 * incrementally by offset.
 */

import crypto from 'crypto';

/** Remote root for job directories. `$HOME` expands on the remote shell. */
export const JOBS_ROOT = '$HOME/.ssh-manager/jobs';

/** A short, unique, filesystem/shell-safe job id. */
export function newJobId() {
  // 9 random bytes -> 12 base64url chars; collision-free for practical use.
  return crypto.randomBytes(9).toString('base64url');
}

/** Shell-quote a token for POSIX sh (single-quote wrap, escape inner quote). */
function shQuoteLocal(str) {
  return `'${String(str).replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * Build the detach launch command. Returns { jobId, jobDir, logPath, command }.
 *
 * The command:
 *   mkdir -p <jobDir>
 *   && setsid sh -c '<cmd>; echo $? > <jobDir>/rc' > <jobDir>/log 2>&1 &
 *   echo $! > <jobDir>/pid
 *
 * setsid detaches the job from the SSH session's process group, so closing
 * the channel does not kill it. rc is written only after the command exits.
 */
export function buildDetachCommand(command, { jobId = newJobId() } = {}) {
  if (typeof command !== 'string' || command === '') {
    throw new Error('ssh_run detach: command is required');
  }
  const jobDir = `${JOBS_ROOT}/${jobId}`;
  const logPath = `${jobDir}/log`;
  // Inner script: run the user command, then record its exit code in rc.
  const inner = `${command}; echo $? > ${jobDir}/rc`;
  const cmd =
    `mkdir -p ${jobDir} && `
    + `{ setsid sh -c ${shQuoteLocal(inner)} > ${logPath} 2>&1 & `
    + `echo $! > ${jobDir}/pid; }`;
  return { jobId, jobDir, logPath, command: cmd };
}

/**
 * Build the job-status command. Prints a small keyed block plus the log
 * tail from `offset` bytes onward. `rc` presence (not PID liveness) decides
 * completion -- `cat rc 2>/dev/null` yields the code, or empty if unwritten.
 *
 * Emitted block:
 *   STATE=present|missing
 *   RC=<code or empty>
 *   PID=<pid or empty>
 *   LOGSIZE=<bytes>
 *   ##LOG##
 *   <log bytes after offset>
 */
export function buildJobStatusCommand(jobId, { offset = 0 } = {}) {
  if (typeof jobId !== 'string' || jobId === '') {
    throw new Error('ssh_run job-status: job id is required');
  }
  const jobDir = `${JOBS_ROOT}/${jobId}`;
  const off = offset | 0;
  // wc -c after +<off> yields bytes-from-offset; tail -c +N is 1-indexed.
  return (
    `if test -d ${jobDir}; then `
    + `echo STATE=present; `
    + `echo "RC=$(cat ${jobDir}/rc 2>/dev/null)"; `
    + `echo "PID=$(cat ${jobDir}/pid 2>/dev/null)"; `
    + `echo "LOGSIZE=$(wc -c < ${jobDir}/log 2>/dev/null || echo 0)"; `
    + `echo '##LOG##'; `
    + `tail -c +${off + 1} ${jobDir}/log 2>/dev/null; `
    + `else echo STATE=missing; fi`
  );
}

/**
 * Parse job-status output into { state, exitCode, pid, logSize, logChunk }.
 *   state: 'done' (rc file present) | 'running' (dir present, no rc)
 *          | 'unknown' (job dir missing)
 * exitCode is the rc value when done, else null. PID liveness is never
 * consulted -- rc presence alone decides completion.
 */
export function parseJobStatus(stdout) {
  const s = stdout == null ? '' : String(stdout);
  const logMark = s.indexOf('\n##LOG##\n');
  const head = logMark === -1 ? s : s.slice(0, logMark);
  const logChunk = logMark === -1 ? '' : s.slice(logMark + '\n##LOG##\n'.length);

  const field = (key) => {
    const m = head.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };

  if (field('STATE') === 'missing') {
    return { state: 'unknown', exitCode: null, pid: null, logSize: 0, logChunk: '' };
  }

  const rc = field('RC');
  const pidRaw = field('PID');
  const sizeRaw = field('LOGSIZE');
  const hasRc = rc !== '';

  return {
    state: hasRc ? 'done' : 'running',
    exitCode: hasRc ? Number(rc) : null,
    pid: pidRaw === '' ? null : Number(pidRaw),
    logSize: sizeRaw === '' ? 0 : Number(sizeRaw),
    logChunk,
  };
}

/**
 * Build the job-kill command. Reads the recorded pid; since the job ran
 * under setsid it leads its own process group, so a negative pid (`-PID`)
 * signals the whole group -- children included. TERM first, brief grace,
 * then KILL. A missing pid file or an already-dead group is not an error.
 */
export function buildJobKillCommand(jobId) {
  if (typeof jobId !== 'string' || jobId === '') {
    throw new Error('ssh_run job-kill: job id is required');
  }
  const jobDir = `${JOBS_ROOT}/${jobId}`;
  // P holds the job's pid; -$P targets its process group.
  return (
    `P=$(cat ${jobDir}/pid 2>/dev/null); `
    + `if test -n "$P"; then `
    + `kill -TERM -"$P" 2>/dev/null; `
    + `sleep 2; `
    + `kill -KILL -"$P" 2>/dev/null; `
    + `echo "killed $P"; `
    + `else echo 'job-kill: no pid recorded'; fi`
  );
}
