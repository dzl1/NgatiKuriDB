// Copies BMSData.accdb into Azure SQL.
//
//   SQL_SERVER=… SQL_DATABASE=… npm run migrate [-- path/to/BMSData.accdb]
//
// Every Access table is recreated in the `bms` schema with the same table and column names,
// then filled from the Access file, all in one transaction: if anything fails nothing changes.
// Re-running replaces the bms tables with a fresh copy; Harbour's own `app` tables
// (audit log, member accounts, change requests) are never touched.
//
// Runs as the account signed in to the Azure CLI, which must be the SQL server's Entra admin.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MDBReader from 'mdb-reader';
import { getPool, sql } from '../src/db.js';
import { includedColumns, listAccessTables, q, ROW_ORDER_COLUMN } from '../src/tables.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accdbPath = path.resolve(process.argv[2] || path.join(root, 'data', 'BMSData.accdb'));

// Access column type -> [DDL, mssql bulk type]
function sqlType(column, maxTextLength) {
  switch (column.type) {
    case 'boolean': return ['BIT', sql.Bit];
    case 'byte': return ['TINYINT', sql.TinyInt];
    case 'integer': return ['SMALLINT', sql.SmallInt];
    case 'long': return ['INT', sql.Int];
    case 'bigint': return ['BIGINT', sql.BigInt];
    case 'float': return ['REAL', sql.Real];
    case 'double': return ['FLOAT', sql.Float];
    case 'currency': return ['DECIMAL(19,4)', sql.Decimal(19, 4)];
    case 'numeric': return [`DECIMAL(${column.precision},${column.scale})`, sql.Decimal(column.precision, column.scale)];
    case 'datetime':
    case 'datetimeextended': return ['DATETIME2(3)', sql.DateTime2(3)];
    case 'repid': return ['UNIQUEIDENTIFIER', sql.UniqueIdentifier];
    case 'binary':
    case 'ole': return ['VARBINARY(MAX)', sql.VarBinary(sql.MAX)];
    case 'memo': return ['NVARCHAR(MAX)', sql.NVarChar(sql.MAX)];
    case 'text': {
      // mdb-reader reports text sizes in bytes, which is at least the character count.
      const length = Math.max(column.size || 1, maxTextLength);
      return length > 4000 ? ['NVARCHAR(MAX)', sql.NVarChar(sql.MAX)] : [`NVARCHAR(${length})`, sql.NVarChar(length)];
    }
    default:
      throw new Error(`Column ${column.name} has Access type "${column.type}", which this migration does not handle yet.`);
  }
}

async function main() {
  console.log(`Reading ${accdbPath}…`);
  const reader = new MDBReader(await fs.readFile(accdbPath));
  const tables = listAccessTables(reader).map(({ name, system }) => {
    const table = reader.getTable(name);
    const columns = includedColumns(name, table.getColumns());
    const rows = table.getData({ columns: columns.map((column) => column.name) });
    return { name, system, columns, rows };
  });

  console.log(`Connecting to ${process.env.SQL_SERVER} / ${process.env.SQL_DATABASE}…`);
  const pool = await getPool();
  await pool.request().batch(await fs.readFile(path.join(root, 'sql', 'app-schema.sql'), 'utf8'));

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    // Drop bms tables that no longer exist in the Access file.
    const existing = await new sql.Request(transaction).query("SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID('bms')");
    for (const { name } of existing.recordset) {
      if (!tables.some((table) => table.name === name)) await new sql.Request(transaction).batch(`DROP TABLE bms.${q(name)}`);
    }
    await new sql.Request(transaction).batch('DELETE FROM meta.Tables');

    for (const table of tables) {
      const types = table.columns.map((column) => {
        const maxText = column.type === 'text'
          ? table.rows.reduce((max, row) => Math.max(max, typeof row[column.name] === 'string' ? row[column.name].length : 0), 0)
          : 0;
        return sqlType(column, maxText);
      });

      const ddl = [
        `${q(ROW_ORDER_COLUMN)} INT NOT NULL CONSTRAINT ${q(`PK_${table.name}`)} PRIMARY KEY`,
        ...table.columns.map((column, index) => `${q(column.name)} ${types[index][0]} ${column.type === 'boolean' ? 'NOT NULL' : 'NULL'}`),
      ];
      await new sql.Request(transaction).batch(`DROP TABLE IF EXISTS bms.${q(table.name)}; CREATE TABLE bms.${q(table.name)} (\n  ${ddl.join(',\n  ')}\n);`);

      if (table.rows.length) {
        const bulk = new sql.Table(`bms.${q(table.name)}`);
        bulk.columns.add(ROW_ORDER_COLUMN, sql.Int, { nullable: false });
        table.columns.forEach((column, index) => bulk.columns.add(column.name, types[index][1], { nullable: column.type !== 'boolean' }));
        table.rows.forEach((row, index) => bulk.rows.add(index + 1, ...table.columns.map((column) => row[column.name] ?? null)));
        await new sql.Request(transaction).bulk(bulk);
      }

      // Speed up lookups by person.
      for (const column of table.columns.filter((item) => /^(ApplicantID|ParentApplicantID|ChildApplicantID)$/i.test(item.name))) {
        await new sql.Request(transaction).batch(`CREATE INDEX ${q(`IX_${table.name}_${column.name}`)} ON bms.${q(table.name)} (${q(column.name)})`);
      }

      await new sql.Request(transaction)
        .input('name', sql.NVarChar(128), table.name)
        .input('system', sql.Bit, table.system)
        .input('columns', sql.NVarChar(sql.MAX), JSON.stringify(table.columns))
        .input('rowCount', sql.Int, table.rows.length)
        .query('INSERT INTO meta.Tables (Name, IsSystem, ColumnsJson, [RowCount], MigratedAt) VALUES (@name, @system, @columns, @rowCount, SYSUTCDATETIME())');

      console.log(`  ${table.name.padEnd(28)} ${String(table.rows.length).padStart(6)} rows`);
    }

    await transaction.commit();
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }

  // Check the copy: row counts in SQL must match the Access file.
  const counts = await pool.request().query('SELECT Name, [RowCount] FROM meta.Tables');
  let mismatches = 0;
  for (const table of tables) {
    const actual = await pool.request().query(`SELECT COUNT(*) AS n FROM bms.${q(table.name)}`);
    const recorded = counts.recordset.find((row) => row.Name === table.name)?.RowCount;
    if (actual.recordset[0].n !== table.rows.length || recorded !== table.rows.length) {
      mismatches += 1;
      console.error(`  MISMATCH ${table.name}: Access ${table.rows.length}, SQL ${actual.recordset[0].n}`);
    }
  }
  if (mismatches) throw new Error(`${mismatches} table(s) did not copy completely.`);
  console.log(`Done: ${tables.length} tables, ${tables.reduce((sum, table) => sum + table.rows.length, 0)} rows copied and verified.`);
  await pool.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
