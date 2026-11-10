import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import { audit, forgetStaff, getIdentity, getMemberIdentity, getUser, MEMBER_PROVIDER, memberLoginUrl, onAppService, requireRole, ROLES, STAFF_PROVIDER } from './src/auth.js';
import { getPool, sql, sqlConfigured } from './src/db.js';
import { inviteToTenant } from './src/graph.js';
import * as members from './src/members.js';
import { createRegisterCache, PHASE_STATUS } from './src/register.js';
import { snapshotFromAccdb, snapshotFromSql } from './src/snapshot.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const localDatabase = path.join(root, 'data', 'BMSData.accdb');
const useSql = sqlConfigured();
const INVITE_DAYS = 14;

if (onAppService && !useSql) {
  console.error('[harbour] SQL_SERVER and SQL_DATABASE must be set on App Service.');
  process.exit(1);
}

// The register, kept in memory so staff pages load quickly (see src/register.js).
const register = createRegisterCache(() => (useSql ? snapshotFromSql() : snapshotFromAccdb(localDatabase)));

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
  const hasBody = Number(request.get('content-length') || 0) > 0 || Boolean(request.get('transfer-encoding'));
  if (request.get('x-harbour') !== '1' || (hasBody && !request.is('application/json'))) {
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

// Local development only: switch between pretending to be staff, a member, or nobody.
if (!onAppService) {
  app.get('/dev/as', (request, response) => {
    const who = ['staff', 'member', 'none'].includes(request.query.who) ? request.query.who : 'staff';
    response.cookie('harbour_dev_as', who, { httpOnly: true, sameSite: 'lax' });
    response.redirect(who === 'member' ? '/member.html' : who === 'staff' ? '/users.html' : '/');
  });
  // Stand-ins for App Service Authentication's sign-in URLs.
  app.get('/.auth/login/:provider', (request, response) => {
    const who = request.params.provider === 'members' ? 'member' : 'staff';
    response.cookie('harbour_dev_as', who, { httpOnly: true, sameSite: 'lax' });
    const target = String(request.query.post_login_redirect_uri || '/');
    response.redirect(target.startsWith('/') && !target.startsWith('//') ? target : '/');
  });
  app.get('/.auth/logout', (request, response) => {
    response.cookie('harbour_dev_as', 'none', { httpOnly: true, sameSite: 'lax' });
    response.redirect('/');
  });
}

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

// Public: who is signed in (if anyone), for the profile menu on every page. Reveals only the
// signed-in person's own name, email and Harbour role.
app.get('/api/session', async (request, response, next) => {
  try {
    const identity = getIdentity(request);
    if (!identity) return response.json({ signedIn: false });
    if (identity.provider === MEMBER_PROVIDER) {
      return response.json({ signedIn: true, kind: 'member', name: identity.name, email: identity.email, profileUrl: '/member.html' });
    }
    if (identity.provider === STAFF_PROVIDER) {
      const user = await getUser(request);
      const staff = user?.access === 'ok';
      return response.json({
        signedIn: true, kind: 'staff', name: identity.name, email: identity.email,
        role: staff ? user.role : null, profileUrl: staff ? '/profile.html' : null, appUrl: staff ? '/users.html' : null,
      });
    }
    return response.json({ signedIn: false });
  } catch (error) {
    return next(error);
  }
});

// The signed-in staff member's own details.
app.get('/api/staff/profile', requireRole('Viewer'), async (request, response, next) => {
  try {
    const { user } = request;
    let account = null;
    if (useSql && user.staffUserId) {
      const pool = await getPool();
      const result = await pool.request().input('id', sql.Int, user.staffUserId)
        .query('SELECT Email, DisplayName, Role, Status, InvitedBy, InvitedAt, ActivatedAt, LastSignInAt, LastSignInMfa FROM app.StaffUsers WHERE StaffUserId = @id');
      account = result.recordset[0] ?? null;
    }
    response.json({ name: user.name, email: user.email, role: user.role, mfa: user.mfa, provider: user.provider, account });
  } catch (error) {
    next(error);
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

// The people list: names, emails and statuses only. Linked records come from /people/:key.
app.get('/api/staff/people', requireRole('Viewer'), async (request, response, next) => {
  try {
    const json = await register.peopleListJson();
    await audit(request.user, 'people.list', null, null, null);
    response.type('json').set('Cache-Control', 'no-store').send(json);
  } catch (error) {
    next(error);
  }
});

// Everyone in a phase (?view=all|processing|…) with their linked records, as CSV. Audited.
app.get('/api/staff/people/export.csv', requireRole('Viewer'), async (request, response, next) => {
  try {
    const view = Object.hasOwn(PHASE_STATUS, request.query.view) ? request.query.view : 'all';
    const { csv, count } = await register.exportCsv(view);
    await audit(request.user, 'people.export', null, null, { view, people: count });
    response.type('text/csv; charset=utf-8').set('Cache-Control', 'no-store')
      .attachment(view === 'all' ? 'NgatiKuri_All_Users.csv' : `NgatiKuri_${view}.csv`).send(csv);
  } catch (error) {
    next(error);
  }
});

// One person and every record linked to them. Each view is audited.
app.get('/api/staff/people/:key', requireRole('Viewer'), async (request, response, next) => {
  try {
    const detail = await register.personDetail(request.params.key);
    if (!detail) return response.status(404).json({ error: 'That person is not on the register.' });
    await audit(request.user, 'person.read', detail.table.name, String(request.params.key), null);
    return response.set('Cache-Control', 'no-store').json(detail);
  } catch (error) {
    return next(error);
  }
});

// Every table, in one response (the table browser pages). Served from the cached copy. Audited.
app.get('/api/staff/snapshot', requireRole('Viewer'), async (request, response, next) => {
  try {
    const { json, tables } = await register.snapshotJson();
    await audit(request.user, 'snapshot.read', null, null, { tables });
    response.type('json').set('Cache-Control', 'no-store').send(json);
  } catch (error) {
    next(error);
  }
});

// ---- Members (External ID sign-in) ----

function requireMember(request, response, next) {
  const identity = getMemberIdentity(request);
  if (!identity) return response.status(401).json({ error: 'Sign in required.', login: memberLoginUrl('/member.html') });
  if (!useSql) return response.status(503).json({ error: 'Member accounts need Azure SQL.' });
  request.member = identity;
  return next();
}

app.get('/api/member/me', requireMember, async (request, response, next) => {
  try { response.json(await members.memberState(request.member)); } catch (error) { next(error); }
});
app.post('/api/member/registration', requireMember, async (request, response, next) => {
  try { await members.submitRegistration(request.member, request.body); response.status(201).json({ ok: true }); } catch (error) { next(error); }
});
app.post('/api/member/changes', requireMember, async (request, response, next) => {
  try { await members.submitChange(request.member, request.body); response.status(201).json({ ok: true }); } catch (error) { next(error); }
});
app.post('/api/member/changes/:id/withdraw', requireMember, async (request, response, next) => {
  try { await members.withdrawChange(request.member, Number(request.params.id)); response.json({ ok: true }); } catch (error) { next(error); }
});

// ---- Member requests (Approvers) ----

app.get('/api/review', requireRole('Approver'), async (request, response, next) => {
  if (needSql(response)) return;
  try { response.json(await members.reviewQueue()); } catch (error) { next(error); }
});
app.get('/api/review/search', requireRole('Approver'), async (request, response, next) => {
  if (needSql(response)) return;
  try { response.json(await members.searchApplicants(request.query.q)); } catch (error) { next(error); }
});
app.post('/api/review/registrations/:id', requireRole('Approver'), async (request, response, next) => {
  if (needSql(response)) return;
  try { const result = await members.decideRegistration(request.user, Number(request.params.id), request.body ?? {}); register.invalidate(); response.json(result); } catch (error) { next(error); }
});
app.post('/api/review/changes/:id', requireRole('Approver'), async (request, response, next) => {
  if (needSql(response)) return;
  try { await members.decideChange(request.user, Number(request.params.id), request.body ?? {}); register.invalidate(); response.json({ ok: true }); } catch (error) { next(error); }
});

// ---- Adding a person by hand, e.g. from a paper application (Approvers) ----

app.get('/api/staff/applicants/form', requireRole('Approver'), async (request, response, next) => {
  if (needSql(response)) return;
  try { response.json(await members.applicantFormOptions()); } catch (error) { next(error); }
});
app.post('/api/staff/applicants/similar', requireRole('Approver'), async (request, response, next) => {
  if (needSql(response)) return;
  try { response.json(await members.findSimilar(request.body)); } catch (error) { next(error); }
});
app.post('/api/staff/applicants/:id/status', requireRole('Approver'), async (request, response, next) => {
  if (needSql(response)) return;
  try { const result = await members.setApplicantStatus(request.user, Number(request.params.id), request.body ?? {}); register.invalidate(); response.json(result); } catch (error) { next(error); }
});
app.post('/api/staff/applicants', requireRole('Approver'), async (request, response, next) => {
  if (needSql(response)) return;
  try { const result = await members.createApplicant(request.user, request.body); register.invalidate(); response.status(201).json(result); } catch (error) { next(error); }
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

// Public pages: the home page and the member portal (whose data needs a member sign-in).
app.use(express.static(path.join(root, 'www'), { index: 'index.html' }));

// Staff pages. Operators needs Admin, Member requests needs Approver, everything else Viewer.
app.get('/admin.html', requireRole('Admin'));
app.get('/review.html', requireRole('Approver'));
app.get('/add-person.html', requireRole('Approver'));
app.use(requireRole('Viewer'), express.static(path.join(root, 'public'), { index: false }));

app.use((request, response) => response.status(404).type('text').send('Not found'));

app.use((error, request, response, next) => {
  if (error.expose && !response.headersSent) return response.status(error.status || 400).json({ error: error.message });
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
  register.warm();
});

