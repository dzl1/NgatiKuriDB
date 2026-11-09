// Gives the web app's managed identity read/write access to the Harbour database.
//   SQL_SERVER=… SQL_DATABASE=… node scripts/grant-webapp.js <web-app-name>
// Runs as the SQL server's Entra admin (the account signed in to the Azure CLI).

import { getPool } from '../src/db.js';
import { q } from '../src/tables.js';

const webApp = process.argv[2];
if (!webApp) {
  console.error('Usage: node scripts/grant-webapp.js <web-app-name>');
  process.exit(1);
}

const pool = await getPool();
const user = q(webApp);
const literal = `N'${webApp.replace(/'/g, "''")}'`;
await pool.request().batch(`
IF DATABASE_PRINCIPAL_ID(${literal}) IS NULL CREATE USER ${user} FROM EXTERNAL PROVIDER;
IF IS_ROLEMEMBER('db_datareader', ${literal}) = 0 ALTER ROLE db_datareader ADD MEMBER ${user};
IF IS_ROLEMEMBER('db_datawriter', ${literal}) = 0 ALTER ROLE db_datawriter ADD MEMBER ${user};
`);
console.log(`${webApp} can read and write the database.`);
await pool.close();
