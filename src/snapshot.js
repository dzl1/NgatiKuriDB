import fs from 'node:fs/promises';
import MDBReader from 'mdb-reader';
import { getPool } from './db.js';
import { includedColumns, listAccessTables, q, ROW_ORDER_COLUMN } from './tables.js';

// A snapshot is every table the staff viewer needs, in one shape for both sources:
// { source, tables: [{ name, system, columns: [mdb-reader column definitions], rows: [...] }] }

export async function snapshotFromSql() {
  const pool = await getPool();
  const meta = await pool.request().query('SELECT Name, IsSystem, ColumnsJson FROM meta.Tables ORDER BY Name');
  // Read a few tables side by side; more than that gains little on the Basic tier.
  const queue = [...meta.recordset];
  const tables = [];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { Name: name, IsSystem: system, ColumnsJson } = item;
      const columns = JSON.parse(ColumnsJson);
      const select = columns.map((column) => q(column.name)).join(', ');
      const result = await pool.request().query(`SELECT ${select} FROM bms.${q(name)} ORDER BY ${q(ROW_ORDER_COLUMN)}`);
      tables.push({ name, system, columns, rows: result.recordset });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  tables.sort((a, b) => a.name.localeCompare(b.name));
  return { source: 'Azure SQL', tables };
}

export async function snapshotFromAccdb(filePath) {
  const reader = new MDBReader(await fs.readFile(filePath));
  const tables = listAccessTables(reader).map(({ name, system }) => {
    const table = reader.getTable(name);
    const columns = includedColumns(name, table.getColumns());
    const rows = table.getData({ columns: columns.map((column) => column.name) });
    return { name, system, columns, rows };
  });
  return { source: 'BMSData.accdb (local)', tables };
}
