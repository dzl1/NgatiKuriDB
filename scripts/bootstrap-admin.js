// Adds (or re-enables) a Harbour Admin directly in the database. Used once by azure-setup.sh
// for the first Admin; after that, Admins invite everyone else from Maintenance → Operators.
//   SQL_SERVER=… SQL_DATABASE=… node scripts/bootstrap-admin.js <email> <entra-object-id> [display name]

import { getPool, sql } from '../src/db.js';

const [email, objectId, displayName] = process.argv.slice(2);
if (!email || !objectId) {
  console.error('Usage: node scripts/bootstrap-admin.js <email> <entra-object-id> [display name]');
  process.exit(1);
}

const pool = await getPool();
await pool.request()
  .input('email', sql.NVarChar(320), email.toLowerCase())
  .input('oid', sql.NVarChar(100), objectId)
  .input('name', sql.NVarChar(200), displayName || null)
  .query(`
MERGE app.StaffUsers AS target
USING (SELECT @email AS Email, @oid AS EntraObjectId, @name AS DisplayName) AS source
ON target.EntraObjectId = source.EntraObjectId OR target.Email = source.Email
WHEN MATCHED THEN UPDATE SET Role = 'Admin', Status = 'active', EntraObjectId = source.EntraObjectId,
  ActivatedAt = COALESCE(target.ActivatedAt, SYSUTCDATETIME())
WHEN NOT MATCHED THEN INSERT (Email, DisplayName, Role, Status, EntraObjectId, InvitedBy, ActivatedAt)
  VALUES (source.Email, source.DisplayName, 'Admin', 'active', source.EntraObjectId, 'setup script', SYSUTCDATETIME());
INSERT INTO app.AuditLog (ActorName, Action, TableName, RecordKey) VALUES ('setup script', 'staff.bootstrapAdmin', 'app.StaffUsers', @email);`);
console.log(`${email} is a Harbour Admin.`);
await pool.close();
