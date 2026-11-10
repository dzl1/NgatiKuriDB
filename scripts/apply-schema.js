// Creates any of Harbour's own tables and indexes (sql/app-schema.sql) that are missing.
// Safe to run any time: it never drops or changes existing tables or rows, and it does not
// touch the register (bms.*). Run it after deploying code that adds to app-schema.sql.
//
//   SQL_SERVER=… SQL_DATABASE=… node scripts/apply-schema.js
// Runs as the SQL server's Entra admin (the account signed in to the Azure CLI).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from '../src/db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = await getPool();
const before = new Set((await pool.request().query("SELECT SCHEMA_NAME(schema_id) + '.' + name AS name FROM sys.tables WHERE SCHEMA_NAME(schema_id) IN ('app', 'meta')")).recordset.map((row) => row.name));
await pool.request().batch(await fs.readFile(path.join(root, 'sql', 'app-schema.sql'), 'utf8'));
const after = (await pool.request().query("SELECT SCHEMA_NAME(schema_id) + '.' + name AS name FROM sys.tables WHERE SCHEMA_NAME(schema_id) IN ('app', 'meta')")).recordset.map((row) => row.name);
const added = after.filter((name) => !before.has(name));
console.log(added.length ? `Created: ${added.join(', ')}` : 'All tables were already there.');
console.log(`Harbour tables: ${after.sort().join(', ')}`);
await pool.close();
