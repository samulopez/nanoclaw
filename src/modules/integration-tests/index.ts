/**
 * Host-side gated integration-test runner.
 *
 * Lets an allowlisted agent group trigger ONE fixed command (e.g.
 * `make integration_tests`) that needs the host's Docker daemon —
 * without ever giving the container any Docker access (no socket, no
 * nested/privileged daemon). The agent writes a `run_integration_tests`
 * system message to outbound.db; the host runs the *hardcoded* command
 * (no agent-controlled arguments) against the host clone and writes the
 * captured output back to inbound.db.
 *
 * Security model:
 *   - The command is a fixed `string[]` from ALLOWLIST, never built from
 *     agent input. No shell is used (spawn with arg array), so there is no
 *     injection surface.
 *   - Only sessions whose agent_group_id is in ALLOWLIST are served; any
 *     other group gets an explicit "not allowed" response.
 *   - Runs as the trusted host process, against the directory the host
 *     already owns. The agent only ever receives stdout/stderr + exit code.
 *
 * The command runs DETACHED: `handleSystemAction` is awaited serially in
 * the delivery loop, so blocking it on a multi-minute `make` would stall
 * delivery for the session. Instead we spawn, return immediately (the
 * outbound message is marked delivered), and write the response from the
 * child-exit callback using a fresh inbound.db handle.
 */
import { spawn } from 'child_process';
import os from 'os';

import { registerDeliveryAction } from '../../delivery.js';
import { openInboundDb, insertMessage } from '../../db/session-db.js';
import { inboundDbPath } from '../../session-manager.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

interface RunnerEntry {
  /** Absolute working directory the command runs in (the host clone). */
  cwd: string;
  /** Fixed command + args. NEVER built from agent input. */
  command: string[];
  /** Hard timeout; the child is killed and the run reported as timed out. */
  timeoutMs: number;
}

/**
 * Per-agent-group allowlist. Add an entry to enable the runner for a group.
 * An absent entry means the group can never trigger a run.
 */
const ALLOWLIST: Record<string, RunnerEntry> = {
  // la-quiniela-coder
  'ag-1781014857918-460v65': {
    cwd: `${os.homedir()}/projects/la-quiniela-coder`,
    command: ['make', 'integration_tests'],
    timeoutMs: 10 * 60 * 1000,
  },
};

/** Cap captured output so a runaway test can't blow up memory or the DB row. */
const MAX_OUTPUT_BYTES = 16 * 1024;

/** Sessions with a run currently in flight — one run per session at a time. */
const inFlight = new Set<string>();

/** Keep only the tail of the output once it exceeds the cap. */
function clampTail(s: string): string {
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  return `…[truncated ${s.length - MAX_OUTPUT_BYTES} bytes]…\n` + s.slice(-MAX_OUTPUT_BYTES);
}

/** Write a result row the container's poller picks up (trigger=0: context only). */
function writeResult(
  session: Session,
  requestId: string,
  result: { ok: boolean; exitCode: number | null; output: string; timedOut?: boolean; error?: string },
): void {
  const db = openInboundDb(inboundDbPath(session.agent_group_id, session.id));
  try {
    insertMessage(db, {
      id: `it-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        type: 'integration_test_result',
        requestId,
        ...result,
      }),
      processAfter: null,
      recurrence: null,
      trigger: 0,
    });
  } finally {
    db.close();
  }
}

registerDeliveryAction('run_integration_tests', async (content, session) => {
  const requestId = content.requestId as string;

  if (!requestId || !/^[A-Za-z0-9_-]+$/.test(requestId)) {
    log.warn('run_integration_tests: missing/invalid requestId', { sessionId: session.id });
    return;
  }

  const entry = ALLOWLIST[session.agent_group_id];
  if (!entry) {
    log.warn('run_integration_tests: agent group not allowlisted', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
    });
    writeResult(session, requestId, {
      ok: false,
      exitCode: null,
      output: '',
      error: 'integration-test runner is not enabled for this agent group',
    });
    return;
  }

  if (inFlight.has(session.id)) {
    writeResult(session, requestId, {
      ok: false,
      exitCode: null,
      output: '',
      error: 'an integration-test run is already in progress for this session',
    });
    return;
  }

  inFlight.add(session.id);
  log.info('run_integration_tests: starting', {
    requestId,
    sessionId: session.id,
    cwd: entry.cwd,
    command: entry.command.join(' '),
  });

  // Detached run — return now, report on child exit.
  const [cmd, ...args] = entry.command;
  const child = spawn(cmd, args, {
    cwd: entry.cwd,
    env: {
      ...process.env,
      // Ensure Go + docker resolve regardless of the service's PATH, and let
      // Go fetch the exact toolchain the repo pins if it differs.
      PATH: `/usr/local/go/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
      GOTOOLCHAIN: 'auto',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const append = (buf: Buffer) => {
    output = clampTail(output + buf.toString());
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, entry.timeoutMs);

  const finish = (exitCode: number | null) => {
    clearTimeout(timer);
    inFlight.delete(session.id);
    const ok = !timedOut && exitCode === 0;
    log.info('run_integration_tests: finished', { requestId, sessionId: session.id, ok, exitCode, timedOut });
    try {
      writeResult(session, requestId, { ok, exitCode, output, timedOut });
    } catch (err) {
      log.error('run_integration_tests: failed to write result', { requestId, sessionId: session.id, err });
    }
  };

  child.on('error', (err) => {
    clearTimeout(timer);
    inFlight.delete(session.id);
    log.error('run_integration_tests: spawn error', { requestId, sessionId: session.id, err });
    try {
      writeResult(session, requestId, {
        ok: false,
        exitCode: null,
        output,
        error: `failed to launch runner: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch {
      /* best effort */
    }
  });

  child.on('close', (code) => finish(code));
});
