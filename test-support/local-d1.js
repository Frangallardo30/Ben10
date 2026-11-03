import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ProposalMessageSync } from '../src/message-sync.js';

class D1Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  run() { return { meta: { changes: this.db.prepare(this.sql).run(...this.args).changes } }; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}

export class LocalD1 {
  constructor(legacy = false) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    if (legacy) this.db.exec('DROP TABLE role_votes; DROP TABLE bot_settings;');
  }
  prepare(sql) { return new D1Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.db.close(); }
}

export function messageSyncBinding(env) {
  const objects = new Map();
  return {
    idFromName: (id) => id,
    get(id) {
      if (!objects.has(id)) objects.set(id, new ProposalMessageSync({}, env));
      const object = objects.get(id);
      return { fetch: (url, options) => object.fetch(new Request(url, options)) };
    }
  };
}
