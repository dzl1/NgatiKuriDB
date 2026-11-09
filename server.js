import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import { audit, forgetStaff, getUser, onAppService, requireRole, ROLES } from './src/auth.js';
import { getPool, sql, sqlConfigured } from './src/db.js';
import { inviteToTenant } from './src/graph.js';
import { snapshotFromAccdb, snapshotFromSql } from './src/snapshot.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const localDatabase = path.join(root, 'data', 'BMSData.accdb');
const useSql = sqlConfigured();
const INVITE_DAYS = 14;

if (onAppService && !useSql) {
  console.error('[harbour] SQL_SERVER and SQL_DATABASE must be set on App Service.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(compression());
app.use((request, response, next) => {
  response.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    // Ask search engines and AI crawlers not to index, cache, snippet or train on anything here.
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai',
  });
  if (request.path.startsWith('/api/')) response.set('Cache-Control', 'no-store');
  next();
});

// Changes must come from Harbour's own pages: they send JSON with this header, which a
// cross-site form or link cannot.
app.use('/api', (request, response, next) => {
  if (['GET', 'HEAD'].includes(request.method)) return next();
  if (request.get('x-harbour') !== '1' || !request.is('application/json')) {
    return response.status(403).json({ error: 'Request refused.' });
  }
  return next();
});
app.use('/api', express.json({ limit: '20kb' }));

// Public: tells every crawler, including AI crawlers, to stay out of the whole site.
// Polite crawlers obey it; the real protection is that everything else needs a staff sign-in.
const AI_CRAWLERS = [
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
  'Google-Extended', 'GoogleOther', 'Applebot-Extended', 'PerplexityBot', 'Perplexity-User', 'CCBot',
  'Bytespider', 'Amazonbot', 'meta-externalagent', 'FacebookBot', 'cohere-ai', 'Diffbot', 'YouBot',
  'Timpibot', 'ImagesiftBot', 'omgili', 'DuckAssistBot', 'MistralAI-User',
];
const ROBOTS_TXT = [...AI_CRAWLERS, '*'].map((agent) => `User-agent: ${agent}\nDisallow: /\n`).join('\n');
app.get('/robots.txt', (request, response) => response.type('text').send(ROBOTS_TXT));

// Unauthenticated liveness check for App Service.
app.get('/healthz', (request, response) => response.type('text').send('ok'));

// Unauthenticated check that the app can reach its data. Reveals nothing but ok/unavailable.
app.get('/healthz/db', async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!useSql) return response.type('text').send('ok (local file)');
  try {
    const pool = await getPool();
    await pool.request().query('SELECT TOP 1 Name FROM meta.Tables');
    return response.type('text').send('ok');
  } catch (error) {
    console.error('[harbour] Database health check failed:', error.message);
    return response.status(503).type('text').send('unavailable');
  }
});

app.get('/api/me', async (request, response, next) => {
  try {
    const user = await getUser(request);
    if (!user) return response.status(401).json({ error: 'Sign in required.' });
    return response.json({ name: user.name, email: user.email, role: user.role, access: user.access, mfa: user.mfa });
  } catch (error) {
    return next(error);
  }
});

// Every table the staff viewer needs, in one response. Each read is audited.
app.get('/api/staff/snapshot', requireRole('Viewer'), async (request, response, next) => {
  try {
    const snapshot = useSql ? await snapshotFromSql() : await snapshotFromAccdb(localDatabase);
    await audit(request.user, 'snapshot.read', null, null, { tables: snapshot.tables.length });
    response.json(snapshot);
  } catch (error) {
    next(error);
  }
});

// ---- Staff management (Admins) ----

function needSql(response) {
  if (useSql) return false;
  response.status(503).json({ error: 'Staff management needs Azure SQL. Set SQL_SERVER and SQL_DATABASE.' });
  return true;
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

app.get('/api/admin/staff', requireRole('Admin'), async (request, response, next) => {
  if (needSql(response)) return;
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT StaffUserId, Email, DisplayName, Role, Status, InvitedBy, InvitedAt, InviteExpiresAt, ActivatedAt, LastSignInAt, LastSignInMfa,
             CASE WHEN Status = 'invited' AND InviteExpiresAt < SYSUTCDATETIME() THEN 1 ELSE 0 END AS Expired
      FROM app.StaffUsers ORDER BY CASE Status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END, DisplayName, Email`);
    response.json({ staff: result.recordset, me: request.user.staffUserId, roles: ROLES, requireMfa: String(process.env.REQUIRE_STAFF_MFA).toLowerCase() === 'true' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/staff', requireRole('Admin'), async (request, response, next) => {
  if (needSql(response)) return;
  const email = String(request.body?.email ?? '').trim().toLowerCase();
  const displayName = String(request.body?.displayName ?? '').trim().slice(0, 200) || null;
  const role = request.body?.role;
  if (!EMAIL.test(email) || email.length > 320) return response.status(400).json({ error: 'Enter a valid email address.' });
  if (!ROLES.includes(role)) return response.status(400).json({ error: 'Choose a role.' });
  try {
    const pool = await getPool();
    const existing = await pool.request().input('email', sql.NVarChar(320), email).query('SELECT StaffUserId FROM app.StaffUsers WHERE Email = @email');
    if (existing.recordset.length) return response.status(409).json({ error: `${email} is already on the staff list. Use Resend invite or change their role there.` });

    const invite = await inviteToTenant({ email, displayName, redirectUrl: siteUrl(request), invitedByName: request.user.name });
    const clash = await pool.request().input('oid', sql.NVarChar(100), invite.objectId).query('SELECT Email FROM app.StaffUsers WHERE EntraObjectId = @oid');
    if (clash.recordset.length) return response.status(409).json({ error: `That account is already on the staff list as ${clash.recordset[0].Email}.` });

    const inserted = await pool.request()
      .input('email', sql.NVarChar(320), email)
      .input('name', sql.NVarChar(200), displayName || invite.displayName || null)
      .input('role', sql.NVarChar(20), role)
      .input('oid', sql.NVarChar(100), invite.objectId)
      .input('by', sql.NVarChar(200), request.user.email || request.user.name)
      .input('days', sql.Int, INVITE_DAYS)
      .query(`INSERT INTO app.StaffUsers (Email, DisplayName, Role, Status, EntraObjectId, InvitedBy, InviteExpiresAt)
              OUTPUT inserted.StaffUserId
              VALUES (@email, @name, @role, 'invited', @oid, @by, DATEADD(DAY, @days, SYSUTCDATETIME()))`);
    const id = inserted.recordset[0].StaffUserId;
    forgetStaff(invite.objectId);
    await audit(request.user, 'staff.invited', 'app.StaffUsers', String(id), { email, role, emailed: invite.emailed });
    response.status(201).json({
      staffUserId: id,
      emailed: invite.emailed,
      message: invite.emailed
        ? `Invitation emailed to ${email}. It is valid for ${INVITE_DAYS} days.`
        : `${email} already has an account in your organisation, so Microsoft will not send an email. Send them this link to sign in within ${INVITE_DAYS} days: ${siteUrl(request)}`,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/staff/:id/resend', requireRole('Admin'), async (request, response, next) => {
  if (needSql(response)) return;
  try {
    const pool = await getPool();
    const found = await pool.request().input('id', sql.Int, Number(request.params.id)).query('SELECT * FROM app.StaffUsers WHERE StaffUserId = @id');
    const staff = found.recordset[0];
    if (!staff) return response.status(404).json({ error: 'Not found.' });
    if (staff.Status !== 'invited') return response.status(400).json({ error: 'Only pending invites can be resent.' });
    const invite = await inviteToTenant({ email: staff.Email, displayName: staff.DisplayName, redirectUrl: siteUrl(request), invitedByName: request.user.name });
    await pool.request()
      .input('id', sql.Int, staff.StaffUserId)
      .input('oid', sql.NVarChar(100), invite.objectId)
      .input('days', sql.Int, INVITE_DAYS)
      .query('UPDATE app.StaffUsers SET EntraObjectId = @oid, InvitedAt = SYSUTCDATETIME(), InviteExpiresAt = DATEADD(DAY, @days, SYSUTCDATETIME()) WHERE StaffUserId = @id');
    forgetStaff(invite.objectId);
    await audit(request.user, 'staff.reinvited', 'app.StaffUsers', String(staff.StaffUserId), { emailed: invite.emailed });
    response.json({ message: invite.emailed ? `Invitation emailed again to ${staff.Email}.` : `Invite renewed. Send ${staff.Email} this link: ${siteUrl(request)}` });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/admin/staff/:id', requireRole('Admin'), async (request, response, next) => {
  if (needSql(response)) return;
  const id = Number(request.params.id);
  const { role, status } = request.body ?? {};
  if (role !== undefined && !ROLES.includes(role)) return response.status(400).json({ error: 'Unknown role.' });
  if (status !== undefined && !['active', 'disabled'].includes(status)) return response.status(400).json({ error: 'Unknown status.' });
  if (id === request.user.staffUserId) return response.status(400).json({ error: 'You cannot change your own role or access. Ask another Admin.' });
  try {
    const pool = await getPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const found = await new sql.Request(transaction).input('id', sql.Int, id).query('SELECT * FROM app.StaffUsers WITH (UPDLOCK) WHERE StaffUserId = @id');
      const staff = found.recordset[0];
      if (!staff) { await transaction.rollback(); return response.status(404).json({ error: 'Not found.' }); }
      // Re-enabling someone who never signed in puts them back to "invited".
      const newStatus = status === 'active' && !staff.ActivatedAt ? 'invited' : (status ?? staff.Status);
      const newRole = role ?? staff.Role;
      await new sql.Request(transaction)
        .input('id', sql.Int, id).input('role', sql.NVarChar(20), newRole).input('status', sql.NVarChar(20), newStatus)
        .query('UPDATE app.StaffUsers SET Role = @role, Status = @status WHERE StaffUserId = @id');
      const admins = await new sql.Request(transaction).query("SELECT COUNT(*) AS n FROM app.StaffUsers WHERE Role = 'Admin' AND Status = 'active'");
      if (admins.recordset[0].n < 1) {
        await transaction.rollback();
        return response.status(400).json({ error: 'Harbour must keep at least one active Admin.' });
      }
      await transaction.commit();
      forgetStaff(staff.EntraObjectId);
      await audit(request.user, 'staff.updated', 'app.StaffUsers', String(id), { from: { role: staff.Role, status: staff.Status }, to: { role: newRole, status: newStatus } });
      return response.json({ ok: true });
    } catch (error) {
      await transaction.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

function siteUrl(request) {
  return process.env.WEB_URL || `${request.protocol}://${request.get('host')}`;
}

// ---- Pages ----

// The staff admin page needs the Admin role; every other page needs Viewer.
app.get('/admin.html', requireRole('Admin'));
app.use(requireRole('Viewer'), express.static(path.join(root, 'public'), { index: 'index.html' }));

app.use((request, response) => response.status(404).type('text').send('Not found'));

app.use((error, request, response, next) => {
  console.error('[harbour]', error);
  if (response.headersSent) return next(error);
  let message = 'The server could not complete the request. Check the server log for details.';
  if (error.code === 'ENOENT') message = 'Could not find data/BMSData.accdb. Put the database in the data folder, or set SQL_SERVER and SQL_DATABASE to use Azure SQL.';
  else if (error.status && request.path.startsWith('/api/admin/')) message = `Microsoft Entra refused the invite: ${error.message}`;
  return response.status(500).json({ error: message });
});

const port = Number(process.env.PORT) || 8765;
const host = onAppService ? '0.0.0.0' : '127.0.0.1';
app.listen(port, host, (error) => {
  if (error) {
    console.error('[harbour] Could not start server:', error);
    process.exitCode = 1;
    return;
  }
  console.log(`Harbour is running at http://${host}:${port} · data from ${useSql ? `Azure SQL (${process.env.SQL_DATABASE})` : 'data/BMSData.accdb'}`);
  if (!onAppService) console.log('Keep this window open while using the app. Press Ctrl+C to stop.');
});

