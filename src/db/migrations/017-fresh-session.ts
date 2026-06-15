import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'fresh-session',
  up(db: Database.Database) {
    // When 1, the agent-runner clears any persisted continuation at container
    // startup so each spawn (e.g. each cron tick) begins a brand-new
    // conversation instead of resuming the prior transcript.
    db.prepare('ALTER TABLE container_configs ADD COLUMN fresh_session INTEGER NOT NULL DEFAULT 0').run();
  },
};
