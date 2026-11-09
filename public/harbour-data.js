// Loads the database from the Harbour API (Azure SQL, or the local .accdb in development)
// and exposes the small part of the mdb-reader API the pages use, so page logic is unchanged:
//   db.getTableNames({ normalTables, systemTables, linkedTables })
//   db.getTable(name).rowCount / getColumnNames() / getColumns() / getData({ columns, rowOffset, rowLimit })

const DATE_TYPES = new Set(['datetime', 'datetimeextended']);

export async function loadDatabase() {
  const response = await fetch('/api/staff/snapshot', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (response.status === 401) {
    // Session expired: sign in again and come back to this page.
    window.location.href = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    return new Promise(() => {});
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `The server returned ${response.status}.`);
  return new HarbourDatabase(body);
}

class HarbourDatabase {
  constructor({ source, tables }) {
    this.source = source;
    this.tables = new Map(tables.map((table) => [table.name, new HarbourTable(table)]));
  }

  getTableNames({ normalTables = true, systemTables = false, linkedTables = false } = {}) {
    void linkedTables; // linked tables are not migrated
    return [...this.tables.values()]
      .filter((table) => (table.system ? systemTables : normalTables))
      .map((table) => table.name);
  }

  getTable(name) {
    const table = this.tables.get(name);
    if (!table) throw new Error(`Could not find table with name ${name}`);
    return table;
  }
}

class HarbourTable {
  constructor({ name, system, columns, rows }) {
    this.name = name;
    this.system = system;
    this.columns = columns;
    const dateColumns = columns.filter((column) => DATE_TYPES.has(column.type)).map((column) => column.name);
    this.rows = rows.map((row) => {
      dateColumns.forEach((column) => { if (row[column] != null) row[column] = new Date(row[column]); });
      return row;
    });
  }

  get rowCount() { return this.rows.length; }

  getColumnNames() { return this.columns.map((column) => column.name); }

  getColumns() { return this.columns.map((column) => ({ ...column })); }

  getData({ columns, rowOffset = 0, rowLimit = Infinity } = {}) {
    const names = columns ?? this.getColumnNames();
    return this.rows.slice(rowOffset, rowOffset + rowLimit).map((row) => {
      const copy = {};
      names.forEach((name) => { copy[name] = row[name] instanceof Date ? new Date(row[name]) : row[name] ?? null; });
      return copy;
    });
  }
}
