/**
 * Tests for `applyDuePreconditions` — the host-side gate that skips a due
 * scheduled task when its `precondition` command reports no work.
 *
 * Uses plain shell builtins as the precondition (`echo 0` / `echo 3`) so the
 * test is deterministic and needs no external tooling.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { insertTask } from './db.js';
import { applyDuePreconditions } from './precondition.js';
import { handleRecurrence } from './recurrence.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-precondition-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: 'mg-test',
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
  } as Session;
}

function dueTask(id: string, content: Record<string, unknown>) {
  return {
    id,
    processAfter: '2020-01-01T00:00:00.000Z', // already due
    recurrence: '0 */2 * * *',
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify(content),
  };
}

function statusOf(db: ReturnType<typeof freshDb>, id: string): string {
  return (db.prepare(`SELECT status FROM messages_in WHERE id = ?`).get(id) as { status: string }).status;
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('applyDuePreconditions', () => {
  it('skips a due task whose precondition reports no work', () => {
    const db = freshDb();
    insertTask(db, dueTask('task-1', { prompt: 'go', precondition: 'echo 0' }));

    applyDuePreconditions(db, fakeSession());

    expect(statusOf(db, 'task-1')).toBe('completed');
  });

  it('leaves a due task pending when its precondition reports work', () => {
    const db = freshDb();
    insertTask(db, dueTask('task-1', { prompt: 'go', precondition: 'echo 3' }));

    applyDuePreconditions(db, fakeSession());

    expect(statusOf(db, 'task-1')).toBe('pending');
  });

  it('leaves a task without a precondition untouched', () => {
    const db = freshDb();
    insertTask(db, dueTask('task-1', { prompt: 'go' }));

    applyDuePreconditions(db, fakeSession());

    expect(statusOf(db, 'task-1')).toBe('pending');
  });

  it('fails open (leaves pending) when the precondition command errors', () => {
    const db = freshDb();
    insertTask(db, dueTask('task-1', { prompt: 'go', precondition: 'exit 7' }));

    applyDuePreconditions(db, fakeSession());

    expect(statusOf(db, 'task-1')).toBe('pending');
  });

  it('fails open when the precondition prints a non-integer', () => {
    const db = freshDb();
    insertTask(db, dueTask('task-1', { prompt: 'go', precondition: 'echo nope' }));

    applyDuePreconditions(db, fakeSession());

    expect(statusOf(db, 'task-1')).toBe('pending');
  });

  it('does not gate a task that is not yet due', () => {
    const db = freshDb();
    insertTask(db, {
      ...dueTask('task-1', { prompt: 'go', precondition: 'echo 0' }),
      processAfter: '2999-01-01T00:00:00.000Z',
    });

    applyDuePreconditions(db, fakeSession());

    expect(statusOf(db, 'task-1')).toBe('pending');
  });

  it('a skipped occurrence is re-armed by handleRecurrence (no spawn, tries again next tick)', async () => {
    const db = freshDb();
    insertTask(db, dueTask('task-1', { prompt: 'go', precondition: 'echo 0' }));

    applyDuePreconditions(db, fakeSession());
    await handleRecurrence(db, fakeSession());

    const rows = db
      .prepare(`SELECT id, status, recurrence, series_id, process_after FROM messages_in ORDER BY seq`)
      .all() as Array<{
      id: string;
      status: string;
      recurrence: string | null;
      series_id: string;
      process_after: string;
    }>;

    // Original completed + recurrence cleared; a fresh pending occurrence queued for the future.
    const original = rows.find((r) => r.id === 'task-1')!;
    const follow = rows.find((r) => r.id !== 'task-1')!;
    expect(original.status).toBe('completed');
    expect(original.recurrence).toBeNull();
    expect(follow.status).toBe('pending');
    expect(follow.series_id).toBe('task-1');
    expect(new Date(follow.process_after).getTime()).toBeGreaterThan(Date.now());
  });
});
