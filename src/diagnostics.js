export class OperationalError extends Error {
  constructor(code, area, status) {
    super(Number.isInteger(status) && status >= 100 && status <= 599 ? `${code}: ${status}` : code);
    this.name = 'OperationalError';
    this.code = code;
    this.area = area;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}

// Call sites supply fixed event names. Never serialize errors, bodies, URLs,
// headers, user IDs, proposal reasons or credentials, even from an error's name.
export function diagnostic(level, event, area, status) {
  const record = { event, area };
  if (Number.isInteger(status) && status >= 100 && status <= 599) record.status = status;
  console[level](JSON.stringify(record));
}

export function reportFailure(event, error) {
  const record = { event, area: 'worker', code: 'UNEXPECTED_ERROR' };
  if (error instanceof OperationalError) {
    record.area = error.area;
    record.code = error.code;
    if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) record.status = error.status;
  }
  console.warn(JSON.stringify(record));
}

const databases = new WeakMap();
const wrappedDatabases = new WeakSet();
const statements = new WeakMap();

function databaseError(action) {
  try { return action(); }
  catch { throw new OperationalError('D1_FAILURE', 'd1'); }
}

async function databaseAsync(action) {
  try { return await action(); }
  catch { throw new OperationalError('D1_FAILURE', 'd1'); }
}

function statement(raw) {
  const wrapped = {
    bind(...values) { return databaseError(() => statement(raw.bind(...values))); },
    run() { return databaseAsync(() => raw.run()); },
    first(...args) { return databaseAsync(() => raw.first(...args)); },
    all() { return databaseAsync(() => raw.all()); }
  };
  statements.set(wrapped, raw);
  return wrapped;
}

export function diagnosticDatabase(db) {
  if (!db || wrappedDatabases.has(db)) return db;
  if (databases.has(db)) return databases.get(db);
  const wrapped = {
    prepare(sql) { return databaseError(() => statement(db.prepare(sql))); },
    batch(batch) { return databaseAsync(() => db.batch(batch.map((item) => statements.get(item) ?? item))); }
  };
  databases.set(db, wrapped);
  wrappedDatabases.add(wrapped);
  return wrapped;
}

export async function discordRequest(url, options) {
  try { return await fetch(url, options); }
  catch { throw new OperationalError('DISCORD_NETWORK_FAILURE', 'discord'); }
}

export async function discordJSON(response) {
  try { return await response.json(); }
  catch { throw new OperationalError('DISCORD_RESPONSE_INVALID', 'discord'); }
}
