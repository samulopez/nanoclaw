import type { Migration } from './index.js';

export const migration022: Migration = {
  version: 22,
  name: 'fresh-session',
  async up(db) {
    const columns = await db.all<{ name: string }>('PRAGMA table_info(container_configs)');
    if (!columns.some((column) => column.name === 'fresh_session')) {
      await db.exec('ALTER TABLE container_configs ADD COLUMN fresh_session INTEGER NOT NULL DEFAULT 0');
    }
  },
};
