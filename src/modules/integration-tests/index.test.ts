/**
 * Tests for the host-side gated integration-test runner.
 *
 * Covers the security gate and input validation only — NOT the actual
 * `make integration_tests` spawn (that would run a real, slow, Docker-backed
 * suite). The allowlist gate is the security boundary, so that's what we
 * assert: an unlisted group gets an explicit refusal and nothing is executed.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDeliveryAction } from '../../delivery.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { inboundDbPath, sessionDir } from '../../session-manager.js';
import type Database from 'better-sqlite3';
import type { Session } from '../../types.js';

// Import for side effect: registers the 'run_integration_tests' delivery action.
import './index.js';

const AG = 'ag-it-unit-test';
const SESS = 'sess-it-unit-test';

function fakeSession(agentGroupId: string): Session {
  return {
    id: SESS,
    agent_group_id: agentGroupId,
    messaging_group_id: 'mg-test',
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
  } as Session;
}

function openDb(agentGroupId: string): Database.Database {
  return openInboundDb(inboundDbPath(agentGroupId, SESS));
}

function resultRow(db: Database.Database, requestId: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT content FROM messages_in WHERE content LIKE ?').get(`%"requestId":"${requestId}"%`) as
    | { content: string }
    | undefined;
  return row ? (JSON.parse(row.content) as Record<string, unknown>) : null;
}

beforeEach(() => {
  fs.mkdirSync(sessionDir(AG, SESS), { recursive: true });
  ensureSchema(inboundDbPath(AG, SESS), 'inbound');
});

afterEach(() => {
  fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });
});

describe('run_integration_tests delivery action', () => {
  it('is registered', () => {
    expect(getDeliveryAction('run_integration_tests')).toBeDefined();
  });

  it('refuses a group that is not in the allowlist (no command run)', async () => {
    const handler = getDeliveryAction('run_integration_tests')!;
    const requestId = 'it-unit-deny';
    await handler({ action: 'run_integration_tests', requestId }, fakeSession(AG), {} as Database.Database);

    const db = openDb(AG);
    try {
      const result = resultRow(db, requestId);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('integration_test_result');
      expect(result!.ok).toBe(false);
      expect(String(result!.error)).toMatch(/not enabled/i);
    } finally {
      db.close();
    }
  });

  it('ignores a request with an invalid requestId (writes nothing)', async () => {
    const handler = getDeliveryAction('run_integration_tests')!;
    await handler(
      { action: 'run_integration_tests', requestId: 'bad id; rm -rf' },
      fakeSession(AG),
      {} as Database.Database,
    );

    const db = openDb(AG);
    try {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number }).n;
      expect(count).toBe(0);
    } finally {
      db.close();
    }
  });
});
