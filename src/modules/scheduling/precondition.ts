/**
 * Sweep hook for conditional (gated) scheduled tasks.
 *
 * A task may carry an optional `precondition` string in its `content` JSON.
 * When the task comes due, the host runs that command BEFORE waking a
 * container. The command is a "work counter": it must print a non-negative
 * integer to stdout and exit 0.
 *
 *   stdout > 0  → there is work → leave the row pending so the wake step spawns
 *   stdout == 0 → nothing to do → skip this occurrence (see below)
 *
 * Skipping is done by marking the due row `completed` while leaving its
 * `recurrence` intact — exactly the state a normal completion leaves behind.
 * `handleRecurrence` (later in the same sweep tick) then re-arms the next
 * occurrence. Net effect: no container spawned, task simply tries again next
 * tick. $0 when idle.
 *
 * Failure policy is FAIL OPEN: if the command errors, times out, or prints a
 * non-integer, we treat it as "has work" and let the task run. A flaky gate
 * should degrade to the old always-run behaviour, never silently wedge the
 * task into never running.
 *
 * Called from `src/host-sweep.ts` inside MODULE-HOOK:scheduling-precondition,
 * immediately before the due-message wake decision.
 */
import { execSync } from 'node:child_process';

import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { Session } from '../../types.js';

const PRECONDITION_TIMEOUT_MS = 30_000;

interface DueTaskRow {
  id: string;
  content: string;
}

/**
 * Evaluate the precondition of every due task in this session. Rows whose
 * precondition reports "no work" are completed in place so the next
 * recurrence re-arms them without a container spawn. Rows without a
 * precondition, or whose precondition reports work / fails, are left pending.
 */
export function applyDuePreconditions(inDb: Database.Database, session: Session): void {
  const rows = inDb
    .prepare(
      `SELECT id, content FROM messages_in
       WHERE kind = 'task' AND status = 'pending'
         AND process_after IS NOT NULL
         AND datetime(process_after) <= datetime('now')`,
    )
    .all() as DueTaskRow[];

  for (const row of rows) {
    let precondition: string | undefined;
    try {
      const parsed = JSON.parse(row.content);
      precondition = typeof parsed?.precondition === 'string' ? parsed.precondition.trim() : undefined;
    } catch {
      // Unparseable content — not ours to gate. Leave it pending.
      continue;
    }
    if (!precondition) continue;

    if (preconditionHasWork(precondition, session.id, row.id)) continue;

    inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(row.id);
    log.info('Skipped scheduled task occurrence — precondition reported no work', {
      sessionId: session.id,
      taskId: row.id,
    });
  }
}

function preconditionHasWork(cmd: string, sessionId: string, taskId: string): boolean {
  let out: string;
  try {
    out = execSync(cmd, {
      shell: '/bin/bash',
      timeout: PRECONDITION_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }).trim();
  } catch (err) {
    log.warn('Precondition command failed — failing open (task will run)', {
      sessionId,
      taskId,
      err: String(err),
    });
    return true;
  }

  const count = Number.parseInt(out, 10);
  if (Number.isNaN(count)) {
    log.warn('Precondition output not an integer — failing open (task will run)', {
      sessionId,
      taskId,
      out,
    });
    return true;
  }
  return count > 0;
}
