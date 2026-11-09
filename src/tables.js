// Which parts of the Access database are carried into Azure SQL and served to the app.

/** Access system tables the viewer reads (relationship definitions). Everything else in MSys* is skipped. */
export const SYSTEM_TABLES = ['MSysRelationships'];

/** Columns that must never leave the Access file (plain-text passwords). Keyed by table name. */
export const EXCLUDED_COLUMNS = {
  Staff: ['Password'],
};

/** Name of the column added to every migrated table to keep the original Access row order. */
export const ROW_ORDER_COLUMN = '_RowOrder';

export function includedColumns(tableName, columns) {
  const excluded = new Set(EXCLUDED_COLUMNS[tableName] ?? []);
  return columns.filter((column) => !excluded.has(column.name));
}

/** Lists the tables to migrate/serve from an mdb-reader instance, as { name, system }. */
export function listAccessTables(reader) {
  const normal = reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });
  const system = reader.getTableNames({ normalTables: false, systemTables: true, linkedTables: false })
    .filter((name) => SYSTEM_TABLES.includes(name));
  return [...normal.map((name) => ({ name, system: false })), ...system.map((name) => ({ name, system: true }))];
}

/** Quotes a SQL Server identifier. */
export function q(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}
