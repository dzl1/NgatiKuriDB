// Who is signed in, and what they may do.
//
// Sign-in: on Azure App Service, App Service Authentication ("Easy Auth") signs people in with
// Microsoft Entra ID and passes the result to the app in the X-MS-CLIENT-PRINCIPAL header,
// removing any copy of that header a client sends. The header is only trusted while App Service
// Authentication is switched on (WEBSITE_AUTH_ENABLED).
//
// Roles: held in app.StaffUsers, not in Entra, so Admins can invite and manage staff from inside
// Harbour. An invite is tied to the person's Entra object id and becomes active on first sign-in.
//
// MFA: Entra reports whether the sign-in used multi-factor authentication (amr claim "mfa").
// Harbour records it on every sign-in, and refuses staff sessions without it when
// REQUIRE_STAFF_MFA=true. MFA itself is enforced by the tenant (Security Defaults or
// Conditional Access); an app cannot ask Entra to require it.
//
// On a developer machine there is no Easy Auth: a local user with the DEV_ROLE role (default
// Admin) is assumed, and the server only listens on 127.0.0.1.

import { getPool, sql, sqlConfigured } from './db.js';

export const ROLE_RANK = { Viewer: 1, Approver: 2, Admin: 3 };
export const ROLES = Object.keys(ROLE_RANK);

export const onAppService = Boolean(process.env.WEBSITE_SITE_NAME);
const requireMfa = String(process.env.REQUIRE_STAFF_MFA).toLowerCase() === 'true';

const OBJECT_ID_CLAIMS = ['http://schemas.microsoft.com/identity/claims/objectidentifier', 'oid'];
const AMR_CLAIMS = ['http://schemas.microsoft.com/claims/authnmethodsreferences', 'amr'];

// Sign-in providers configured in App Service Authentication:
//   aad     – staff, Microsoft Entra ID (the organisation's tenant)
//   members – members, Microsoft Entra External ID (a separate customer tenant)
// Staff access is only ever granted to 'aad' sign-ins and member access only to 'members'
// sign-ins, so a member account can never act as staff, whatever its claims say.
export const STAFF_PROVIDER = 'aad';
export const MEMBER_PROVIDER = 'members';

/** Local development only: which kind of user to pretend to be (cookie set by /dev/as). */
function localDevIdentity(request) {
  const as = /(?:^|;\s*)harbour_dev_as=(\w+)/.exec(request.get('cookie') || '')?.[1];
  if (as === 'none') return null;
  if (as === 'member') {
    const email = process.env.DEV_MEMBER_EMAIL || 'member@example.org';
    return { id: `local-member-${email}`, name: 'Local member', givenName: 'Local', familyName: 'Member', email, mfa: true, provider: MEMBER_PROVIDER };
  }
  return { id: 'local-dev', name: process.env.DEV_USER || 'Local user', email: null, mfa: true, provider: STAFF_PROVIDER };
}

/** The signed-in identity, or null. Says nothing about Harbour access. */
export function getIdentity(request) {
  if (!onAppService) return localDevIdentity(request);
  if (String(process.env.WEBSITE_AUTH_ENABLED).toLowerCase() !== 'true') return null;
  const header = request.get('x-ms-client-principal');
  if (!header) return null;
  let principal;
  try {
    principal = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const claims = Array.isArray(principal.claims) ? principal.claims : [];
  const claim = (...types) => claims.find((item) => types.includes(item.typ))?.val;
  const id = claim(...OBJECT_ID_CLAIMS);
  if (!id) return null;
  const provider = principal.auth_typ;
  const emailClaims = ['email', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'];
  return {
    id,
    name: claim('name') || request.get('x-ms-client-principal-name') || 'Signed-in user',
    givenName: claim('given_name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname') || null,
    familyName: claim('family_name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname') || null,
    // Staff: their sign-in name. Members: the email External ID verified at sign-up.
    email: (provider === STAFF_PROVIDER ? claim('preferred_username', ...emailClaims) : claim(...emailClaims)) || null,
    mfa: claims.some((item) => AMR_CLAIMS.includes(item.typ) && item.val === 'mfa'),
    provider,
  };
}

/** The signed-in member (External ID), or null. */
export function getMemberIdentity(request) {
  const identity = getIdentity(request);
  return identity?.provider === MEMBER_PROVIDER ? identity : null;
}

export function memberLoginUrl(returnTo) {
  return `/.auth/login/${MEMBER_PROVIDER}?post_login_redirect_uri=${encodeURIComponent(returnTo || '/member.html')}`;
}

// Short cache so every page load and API call doesn't hit the database. Role changes and
// disabling take effect within this time.
const CACHE_MS = 30_000;
const cache = new Map();
export function forgetStaff(entraObjectId) {
  if (entraObjectId) cache.delete(entraObjectId); else cache.clear();
}

/**
 * The signed-in user with their Harbour access:
 * { ...identity, role, staffUserId, access: 'ok' | 'none' | 'expired' | 'disabled' | 'mfa' }
 */
export async function getUser(request) {
  const identity = getIdentity(request);
  if (!identity || identity.provider !== STAFF_PROVIDER) return null;

  if (!onAppService || !sqlConfigured()) {
    const role = ROLES.includes(process.env.DEV_ROLE) ? process.env.DEV_ROLE : 'Admin';
    return { ...identity, role, staffUserId: null, access: 'ok' };
  }

  const cached = cache.get(identity.id);
  let staff = cached && cached.until > Date.now() ? cached.staff : undefined;
  if (staff === undefined) {
    const pool = await getPool();
    const result = await pool.request()
      .input('oid', sql.NVarChar(100), identity.id)
      .query(`SELECT StaffUserId, Role, Status, InviteExpiresAt, LastSignInAt, LastSignInMfa
              FROM app.StaffUsers WHERE EntraObjectId = @oid`);
    staff = result.recordset[0] ?? null;
    if (staff) staff = await recordSignIn(pool, staff, identity);
    cache.set(identity.id, { staff, until: Date.now() + CACHE_MS });
  }

  let access = 'ok';
  if (!staff) access = 'none';
  else if (staff.Status === 'disabled') access = 'disabled';
  else if (staff.Status === 'invited') access = 'expired'; // still 'invited' after recordSignIn means it expired
  else if (requireMfa && !identity.mfa) access = 'mfa';
  return { ...identity, role: staff?.Role ?? null, staffUserId: staff?.StaffUserId ?? null, access };
}

// Activates an invite on first sign-in and keeps last-sign-in details up to date.
async function recordSignIn(pool, staff, identity) {
  const now = new Date();
  if (staff.Status === 'invited') {
    if (staff.InviteExpiresAt && staff.InviteExpiresAt < now) return staff;
    await pool.request()
      .input('id', sql.Int, staff.StaffUserId)
      .input('mfa', sql.Bit, identity.mfa)
      .query(`UPDATE app.StaffUsers SET Status = 'active', ActivatedAt = SYSUTCDATETIME(), LastSignInAt = SYSUTCDATETIME(), LastSignInMfa = @mfa
              WHERE StaffUserId = @id AND Status = 'invited'`);
    await audit({ ...identity, name: identity.email || identity.name }, 'staff.activated', 'app.StaffUsers', String(staff.StaffUserId), null);
    return { ...staff, Status: 'active' };
  }
  const stale = !staff.LastSignInAt || now - staff.LastSignInAt > 15 * 60_000 || Boolean(staff.LastSignInMfa) !== identity.mfa;
  if (staff.Status === 'active' && stale) {
    await pool.request()
      .input('id', sql.Int, staff.StaffUserId)
      .input('mfa', sql.Bit, identity.mfa)
      .query('UPDATE app.StaffUsers SET LastSignInAt = SYSUTCDATETIME(), LastSignInMfa = @mfa WHERE StaffUserId = @id');
  }
  return staff;
}

export function loginUrl(returnTo) {
  return `/.auth/login/${STAFF_PROVIDER}?post_login_redirect_uri=${encodeURIComponent(returnTo || '/users.html')}`;
}

function refusal(user, minRole) {
  const who = user.email || user.name;
  switch (user.access) {
    case 'none': return `${who} has not been invited to Harbour. Ask a Harbour admin to invite you, then sign in again.`;
    case 'expired': return `The Harbour invite for ${who} has expired. Ask a Harbour admin to send a new one.`;
    case 'disabled': return `Harbour access for ${who} has been turned off. Contact a Harbour admin.`;
    case 'mfa': return `Harbour requires multi-factor authentication, and this sign-in for ${who} did not use it. Sign out, then sign in again and approve the Microsoft Authenticator prompt. If you are never asked, set up MFA at https://aka.ms/mfasetup.`;
    default: return `${who} has the ${user.role} role; this needs ${minRole} or higher.`;
  }
}

/** Express middleware: requires a signed-in staff member with at least `minRole`. Pages redirect to sign-in; API calls get 401/403. */
export function requireRole(minRole) {
  return async (request, response, next) => {
    try {
      const user = await getUser(request);
      const wantsHtml = !request.path.startsWith('/api/') && request.accepts(['html', 'json']) === 'html';
      if (!user) {
        if (wantsHtml) return response.redirect(loginUrl(request.originalUrl));
        return response.status(401).json({ error: 'Sign in required.', login: loginUrl('/') });
      }
      if (user.access !== 'ok' || ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
        const message = refusal(user, minRole);
        if (wantsHtml) return response.status(403).type('html').send(refusalPage(message));
        return response.status(403).json({ error: message });
      }
      request.user = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function refusalPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harbour — no access</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 16px;color:#1d1d1b;background:#f7f6f2}a{color:#1f5f8b}</style></head>
<body><h1>No access to Harbour</h1><p>${escapeHtml(message)}</p><p><a href="/.auth/logout">Sign out</a></p></body></html>`;
}

/** Appends to app.AuditLog. */
export async function audit(user, action, tableName, recordKey, details) {
  if (!sqlConfigured()) return;
  const pool = await getPool();
  await pool.request()
    .input('actorId', sql.NVarChar(100), user?.id ?? null)
    .input('actorName', sql.NVarChar(200), user ? (user.email || user.name) : null)
    .input('action', sql.NVarChar(100), action)
    .input('tableName', sql.NVarChar(128), tableName)
    .input('recordKey', sql.NVarChar(100), recordKey)
    .input('details', sql.NVarChar(sql.MAX), details ? JSON.stringify(details) : null)
    .query(`INSERT INTO app.AuditLog (ActorId, ActorName, Action, TableName, RecordKey, DetailsJson)
            VALUES (@actorId, @actorName, @action, @tableName, @recordKey, @details)`);
}
