// Member self-service: registration, viewing your own record, and proposing changes that
// staff approve. Members never write to the register (bms.*) directly; only an Approver's
// decision does, and every decision is audited.

import { audit } from './auth.js';
import { getPool, sql } from './db.js';

const NEW_APPLICANT_STATUS = 10; // "Application Received"

/** Fields a member may see and propose changes to, with limits matching the Access database. */
export const MEMBER_FIELDS = [
  { name: 'FirstName', label: 'First name', max: 50, required: true },
  { name: 'MiddleNames', label: 'Middle names', max: 60 },
  { name: 'LastName', label: 'Last name', max: 50, required: true },
  { name: 'DOB', label: 'Date of birth', type: 'date', required: true },
  { name: 'Gender', label: 'Gender', type: 'choice', options: [['', 'Prefer not to say'], ['F', 'Female'], ['M', 'Male'], ['G', 'Gender diverse']] },
  { name: 'Address0', label: 'Address line 1', max: 50 },
  { name: 'Address1', label: 'Address line 2 (suburb)', max: 50 },
  { name: 'Address2', label: 'Town or city, postcode', max: 50 },
  { name: 'Address3', label: 'Country (if not New Zealand)', max: 50 },
  { name: 'PhoneNumber', label: 'Phone', max: 20 },
  { name: 'Mobile', label: 'Mobile', max: 20 },
  { name: 'Email', label: 'Email', max: 100, type: 'email' },
];
const FIELD = new Map(MEMBER_FIELDS.map((field) => [field.name, field]));

/** Extra questions on the registration form that help staff confirm whakapapa. */
export const REGISTRATION_EXTRA = [
  { name: 'AlreadyRegistered', label: 'Are you already on the Ngāti Kuri register?', type: 'choice', options: [['unsure', 'Not sure'], ['yes', 'Yes'], ['no', 'No']] },
  { name: 'Mother', label: "Mother's full name (including maiden name)", max: 150 },
  { name: 'Father', label: "Father's full name", max: 150 },
  { name: 'Grandparents', label: 'Grandparents or tūpuna through whom you descend from Ngāti Kuri', max: 1000, type: 'long', required: true },
  { name: 'RegisteredWhanau', label: 'Whānau members already on the register (names)', max: 500, type: 'long' },
  { name: 'Notes', label: 'Anything else we should know', max: 1000, type: 'long' },
];
const EXTRA = new Map(REGISTRATION_EXTRA.map((field) => [field.name, field]));

export class MemberError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

// ---- Validation ----

function cleanValue(field, raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (field.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new MemberError(`${field.label}: use the date picker.`);
    const date = new Date(`${text}T00:00:00Z`);
    const year = date.getUTCFullYear();
    if (Number.isNaN(date.getTime()) || year < 1880 || date > new Date()) throw new MemberError(`${field.label}: enter a real date.`);
    return text;
  }
  if (field.type === 'choice') {
    if (!field.options.some(([value]) => value === text)) throw new MemberError(`${field.label}: choose one of the options.`);
    return text;
  }
  if (field.type === 'email' && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(text)) throw new MemberError(`${field.label}: enter a valid email address.`);
  if (text.length > field.max) throw new MemberError(`${field.label}: keep it to ${field.max} characters.`);
  return text;
}

function cleanRegistration(input) {
  const details = {};
  for (const field of [...MEMBER_FIELDS, ...REGISTRATION_EXTRA]) {
    const value = cleanValue(field, input?.[field.name]);
    if (field.required && !value) throw new MemberError(`${field.label} is required.`);
    if (value !== null) details[field.name] = value;
  }
  if (input?.Consent !== true) throw new MemberError('Please confirm you agree to how your information is used.');
  details.ConsentAt = new Date().toISOString();
  return details;
}

// Register values as the member sees them: dates as YYYY-MM-DD, everything else as text.
function memberValue(field, value) {
  if (value === null || value === undefined || value === '') return null;
  if (field.type === 'date') return new Date(value).toISOString().slice(0, 10);
  if (field.name === 'Gender') return String(value).toUpperCase();
  return String(value);
}

function sqlValue(field, value) {
  if (value === null) return null;
  return field.type === 'date' ? new Date(`${value}T00:00:00Z`) : value;
}

function sqlType(field) {
  return field.type === 'date' ? sql.DateTime2(3) : sql.NVarChar(field.max ?? 10);
}

// ---- Member side ----

/** Finds or creates the member's account row. */
async function account(pool, identity) {
  const found = await pool.request().input('id', sql.NVarChar(100), identity.id)
    .query('SELECT * FROM app.MemberAccounts WHERE ExternalUserId = @id');
  if (found.recordset[0]) {
    if (identity.email && found.recordset[0].Email !== identity.email) {
      await pool.request().input('id', sql.Int, found.recordset[0].MemberAccountId).input('email', sql.NVarChar(320), identity.email)
        .query('UPDATE app.MemberAccounts SET Email = @email WHERE MemberAccountId = @id');
    }
    return found.recordset[0];
  }
  const created = await pool.request()
    .input('id', sql.NVarChar(100), identity.id)
    .input('email', sql.NVarChar(320), identity.email)
    .query("INSERT INTO app.MemberAccounts (ExternalUserId, Email) OUTPUT inserted.* VALUES (@id, @email)");
  return created.recordset[0];
}

async function readApplicant(pool, applicantId) {
  const columns = MEMBER_FIELDS.map((field) => `[${field.name}]`).join(', ');
  const result = await pool.request().input('id', sql.Int, applicantId)
    .query(`SELECT ApplicantID, ApplicantStatusID, ${columns} FROM bms.Applicants WHERE ApplicantID = @id`);
  const row = result.recordset[0];
  if (!row) return null;
  const values = Object.fromEntries(MEMBER_FIELDS.map((field) => [field.name, memberValue(field, row[field.name])]));
  const status = await pool.request().input('s', sql.Int, row.ApplicantStatusID)
    .query('SELECT ApplicantStatus FROM bms.ApplicantStatus WHERE ApplicantStatusID = @s');
  return { applicantId: row.ApplicantID, status: status.recordset[0]?.ApplicantStatus ?? null, values };
}

/** Everything the member page needs. */
export async function memberState(identity) {
  const pool = await getPool();
  const member = await account(pool, identity);
  if (member.Status === 'disabled') {
    return { state: 'disabled', email: member.Email };
  }
  const base = { email: identity.email, givenName: identity.givenName, familyName: identity.familyName, fields: MEMBER_FIELDS, extra: REGISTRATION_EXTRA };
  if (member.Status === 'linked' && member.ApplicantID) {
    const applicant = await readApplicant(pool, member.ApplicantID);
    const requests = await pool.request().input('m', sql.Int, member.MemberAccountId).query(`
      SELECT TOP 20 ChangeRequestId, ChangesJson, MemberNote, Status, SubmittedAt, ReviewedAt, ReviewNote
      FROM app.ChangeRequests WHERE MemberAccountId = @m ORDER BY ChangeRequestId DESC`);
    return {
      ...base,
      state: 'linked',
      applicant,
      requests: requests.recordset.map((row) => ({ ...row, Changes: JSON.parse(row.ChangesJson), ChangesJson: undefined })),
    };
  }
  const registration = await pool.request().input('m', sql.Int, member.MemberAccountId)
    .query('SELECT TOP 1 RegistrationId, Status, SubmittedAt, ReviewNote, DetailsJson FROM app.MemberRegistrations WHERE MemberAccountId = @m ORDER BY RegistrationId DESC');
  const latest = registration.recordset[0];
  if (!latest) return { ...base, state: 'new' };
  if (latest.Status === 'pending') return { ...base, state: 'pending', submittedAt: latest.SubmittedAt, details: JSON.parse(latest.DetailsJson) };
  // Accepted before, but no longer linked (their record was removed): they can register again.
  if (latest.Status !== 'rejected') return { ...base, state: 'new' };
  return { ...base, state: 'rejected', reviewNote: latest.ReviewNote, details: JSON.parse(latest.DetailsJson) };
}

export async function submitRegistration(identity, input) {
  const details = cleanRegistration(input);
  details.SignInEmail = identity.email;
  const pool = await getPool();
  const member = await account(pool, identity);
  if (member.Status !== 'pending') throw new MemberError('Your account is already linked to the register.', 409);
  const open = await pool.request().input('m', sql.Int, member.MemberAccountId)
    .query("SELECT COUNT(*) AS n FROM app.MemberRegistrations WHERE MemberAccountId = @m AND Status = 'pending'");
  if (open.recordset[0].n) throw new MemberError('We already have your registration and are checking it.', 409);
  const inserted = await pool.request()
    .input('m', sql.Int, member.MemberAccountId)
    .input('details', sql.NVarChar(sql.MAX), JSON.stringify(details))
    .query('INSERT INTO app.MemberRegistrations (MemberAccountId, DetailsJson) OUTPUT inserted.RegistrationId VALUES (@m, @details)');
  await audit(memberActor(identity), 'member.registered', 'app.MemberRegistrations', String(inserted.recordset[0].RegistrationId), null);
}

export async function submitChange(identity, input) {
  const pool = await getPool();
  const member = await account(pool, identity);
  if (member.Status !== 'linked' || !member.ApplicantID) throw new MemberError('Your account is not linked to the register yet.', 409);
  const current = await readApplicant(pool, member.ApplicantID);
  if (!current) throw new MemberError('We could not find your record. Please contact the office.', 404);

  const changes = {};
  for (const [name, raw] of Object.entries(input?.changes ?? {})) {
    const field = FIELD.get(name);
    if (!field) throw new MemberError(`${name} cannot be changed here.`);
    const value = cleanValue(field, raw);
    if (field.required && !value) throw new MemberError(`${field.label} cannot be blank.`);
    if (value !== current.values[name]) changes[name] = { from: current.values[name], to: value };
  }
  if (!Object.keys(changes).length) throw new MemberError('Nothing has changed.');
  const note = input?.note ? String(input.note).trim().slice(0, 1000) : null;

  const open = await pool.request().input('m', sql.Int, member.MemberAccountId)
    .query("SELECT COUNT(*) AS n FROM app.ChangeRequests WHERE MemberAccountId = @m AND Status = 'pending'");
  if (open.recordset[0].n >= 3) throw new MemberError('You have three changes waiting for review. Please wait until they are checked.', 429);

  const inserted = await pool.request()
    .input('a', sql.Int, member.ApplicantID)
    .input('m', sql.Int, member.MemberAccountId)
    .input('changes', sql.NVarChar(sql.MAX), JSON.stringify(changes))
    .input('note', sql.NVarChar(1000), note)
    .query('INSERT INTO app.ChangeRequests (ApplicantID, MemberAccountId, ChangesJson, MemberNote) OUTPUT inserted.ChangeRequestId VALUES (@a, @m, @changes, @note)');
  await audit(memberActor(identity), 'member.changeRequested', 'app.ChangeRequests', String(inserted.recordset[0].ChangeRequestId), { fields: Object.keys(changes) });
}

export async function withdrawChange(identity, changeRequestId) {
  const pool = await getPool();
  const member = await account(pool, identity);
  const result = await pool.request().input('id', sql.Int, changeRequestId).input('m', sql.Int, member.MemberAccountId)
    .query("UPDATE app.ChangeRequests SET Status = 'withdrawn' WHERE ChangeRequestId = @id AND MemberAccountId = @m AND Status = 'pending'");
  if (!result.rowsAffected[0]) throw new MemberError('That change can no longer be withdrawn.', 409);
  await audit(memberActor(identity), 'member.changeWithdrawn', 'app.ChangeRequests', String(changeRequestId), null);
}

function memberActor(identity) {
  return { id: identity.id, name: `member:${identity.email || identity.id}` };
}

// ---- Staff side (Approvers) ----

export async function reviewQueue() {
  const pool = await getPool();
  const registrations = await pool.request().query(`
    SELECT r.RegistrationId, r.DetailsJson, r.SubmittedAt, a.Email AS SignInEmail
    FROM app.MemberRegistrations r JOIN app.MemberAccounts a ON a.MemberAccountId = r.MemberAccountId
    WHERE r.Status = 'pending' ORDER BY r.SubmittedAt`);
  const changes = await pool.request().query(`
    SELECT c.ChangeRequestId, c.ApplicantID, c.ChangesJson, c.MemberNote, c.SubmittedAt, a.Email AS SignInEmail,
           p.FirstName, p.LastName
    FROM app.ChangeRequests c
    JOIN app.MemberAccounts a ON a.MemberAccountId = c.MemberAccountId
    LEFT JOIN bms.Applicants p ON p.ApplicantID = c.ApplicantID
    WHERE c.Status = 'pending' ORDER BY c.SubmittedAt`);
  return {
    registrations: await Promise.all(registrations.recordset.map(async (row) => {
      const details = JSON.parse(row.DetailsJson);
      return { registrationId: row.RegistrationId, submittedAt: row.SubmittedAt, signInEmail: row.SignInEmail, details, matches: await suggestMatches(pool, details) };
    })),
    changes: changes.recordset.map((row) => ({
      changeRequestId: row.ChangeRequestId, applicantId: row.ApplicantID, name: [row.FirstName, row.LastName].filter(Boolean).join(' '),
      signInEmail: row.SignInEmail, submittedAt: row.SubmittedAt, note: row.MemberNote, changes: JSON.parse(row.ChangesJson),
    })),
    fields: MEMBER_FIELDS,
    extra: REGISTRATION_EXTRA,
  };
}

/** Likely existing records for a registration: same date of birth and a similar name, or same email. */
async function suggestMatches(pool, details) {
  const result = await pool.request()
    .input('dob', sql.DateTime2(3), details.DOB ? new Date(`${details.DOB}T00:00:00Z`) : null)
    .input('first', sql.NVarChar(50), details.FirstName ?? '')
    .input('last', sql.NVarChar(50), details.LastName ?? '')
    .input('email', sql.NVarChar(100), details.Email ?? details.SignInEmail ?? '')
    .query(`
      SELECT TOP 8 p.ApplicantID, p.FirstName, p.MiddleNames, p.LastName, p.DOB, p.Email, p.Address0, p.Address2, s.ApplicantStatus,
        (CASE WHEN p.DOB = @dob THEN 4 ELSE 0 END
         + CASE WHEN p.LastName = @last THEN 3 WHEN SOUNDEX(p.LastName) = SOUNDEX(@last) THEN 2 ELSE 0 END
         + CASE WHEN p.FirstName = @first THEN 2 WHEN SOUNDEX(p.FirstName) = SOUNDEX(@first) THEN 1 ELSE 0 END
         + CASE WHEN @email <> '' AND p.Email = @email THEN 4 ELSE 0 END) AS Score,
        CASE WHEN EXISTS (SELECT 1 FROM app.MemberAccounts m WHERE m.ApplicantID = p.ApplicantID AND m.Status = 'linked') THEN 1 ELSE 0 END AS AlreadyLinked
      FROM bms.Applicants p LEFT JOIN bms.ApplicantStatus s ON s.ApplicantStatusID = p.ApplicantStatusID
      WHERE p.DOB = @dob OR (@email <> '' AND p.Email = @email)
         OR (SOUNDEX(p.LastName) = SOUNDEX(@last) AND SOUNDEX(p.FirstName) = SOUNDEX(@first))
      ORDER BY Score DESC, p.LastName, p.FirstName`);
  return result.recordset.map((row) => ({ ...row, DOB: row.DOB ? row.DOB.toISOString().slice(0, 10) : null }));
}

export async function searchApplicants(query) {
  const text = String(query ?? '').trim();
  if (text.length < 2) return [];
  const pool = await getPool();
  const id = /^\d+$/.test(text) ? Number(text) : null;
  const result = await pool.request()
    .input('like', sql.NVarChar(120), `%${text.replace(/[%_[]/g, '[$&]')}%`)
    .input('id', sql.Int, id)
    .query(`
      SELECT TOP 15 ApplicantID, FirstName, MiddleNames, LastName, DOB, Email, Address0, Address2
      FROM bms.Applicants
      WHERE ApplicantID = @id OR LastName LIKE @like OR FirstName LIKE @like OR Email LIKE @like
         OR CONCAT(FirstName, ' ', LastName) LIKE @like
      ORDER BY LastName, FirstName`);
  return result.recordset.map((row) => ({ ...row, DOB: row.DOB ? row.DOB.toISOString().slice(0, 10) : null }));
}

/** Approver decision on a registration: link to an existing record, add a new record, or reject. */
export async function decideRegistration(staff, registrationId, { action, applicantId, note }) {
  if (!['link', 'create', 'reject'].includes(action)) throw new MemberError('Unknown action.');
  if (action === 'reject' && !String(note ?? '').trim()) throw new MemberError('Add a note for the member explaining why.');
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const request = () => new sql.Request(transaction);
  try {
    const found = await request().input('id', sql.Int, registrationId)
      .query('SELECT r.*, a.Status AS AccountStatus FROM app.MemberRegistrations r WITH (UPDLOCK) JOIN app.MemberAccounts a ON a.MemberAccountId = r.MemberAccountId WHERE r.RegistrationId = @id');
    const registration = found.recordset[0];
    if (!registration || registration.Status !== 'pending') throw new MemberError('This registration has already been dealt with.', 409);
    const details = JSON.parse(registration.DetailsJson);
    const reviewer = staff.email || staff.name;
    let linkedId = null;

    if (action === 'link') {
      linkedId = Number(applicantId);
      const exists = await request().input('a', sql.Int, linkedId).query('SELECT 1 AS ok FROM bms.Applicants WHERE ApplicantID = @a');
      if (!exists.recordset.length) throw new MemberError(`There is no applicant with ID ${applicantId}.`);
      const taken = await request().input('a', sql.Int, linkedId)
        .query("SELECT 1 AS taken FROM app.MemberAccounts WITH (UPDLOCK) WHERE ApplicantID = @a AND Status = 'linked'");
      if (taken.recordset.length) throw new MemberError('Another member account is already linked to that record.', 409);
    }

    if (action === 'create') {
      const values = { ...details, Email: details.Email || details.SignInEmail || null };
      linkedId = await insertApplicant(request, values, NEW_APPLICANT_STATUS, registrationNotes(details, reviewer, 'Registered online'));
    }

    const status = { link: 'linked', create: 'created', reject: 'rejected' }[action];
    await request()
      .input('id', sql.Int, registrationId).input('status', sql.NVarChar(20), status).input('a', sql.Int, linkedId)
      .input('by', sql.NVarChar(200), reviewer).input('note', sql.NVarChar(1000), note ? String(note).trim().slice(0, 1000) : null)
      .query('UPDATE app.MemberRegistrations SET Status = @status, ApplicantID = @a, ReviewedBy = @by, ReviewedAt = SYSUTCDATETIME(), ReviewNote = @note WHERE RegistrationId = @id');
    if (linkedId) {
      await request()
        .input('m', sql.Int, registration.MemberAccountId).input('a', sql.Int, linkedId).input('by', sql.NVarChar(200), reviewer)
        .query("UPDATE app.MemberAccounts SET Status = 'linked', ApplicantID = @a, LinkedBy = @by, LinkedAt = SYSUTCDATETIME() WHERE MemberAccountId = @m");
    }
    await transaction.commit();
    await audit(staff, `registration.${status}`, 'app.MemberRegistrations', String(registrationId), { applicantId: linkedId });
    return { applicantId: linkedId };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}

/**
 * Adds a person to bms.Applicants inside the caller's transaction and returns their new ApplicantID.
 * IDs follow on from the highest existing ones, as Access numbered them.
 */
async function insertApplicant(request, values, statusId, notes) {
  const next = await request().query('SELECT ISNULL(MAX(ApplicantID), 0) + 1 AS id, ISNULL(MAX(ApplicantAutoID), 0) + 1 AS auto, ISNULL(MAX(_RowOrder), 0) + 1 AS row FROM bms.Applicants WITH (TABLOCKX)');
  const { id, auto, row } = next.recordset[0];
  const insert = request()
    .input('row', sql.Int, row).input('auto', sql.Int, auto).input('id', sql.Int, id)
    .input('status', sql.SmallInt, statusId)
    .input('notes', sql.NVarChar(sql.MAX), notes);
  const names = [];
  for (const field of MEMBER_FIELDS) {
    insert.input(`f_${field.name}`, sqlType(field), sqlValue(field, values[field.name] ?? null));
    names.push(field.name);
  }
  // Booleans in the Access tables are NOT NULL.
  await insert.query(`
    INSERT INTO bms.Applicants (_RowOrder, ApplicantAutoID, ApplicantID, ApplicantStatusID, Notes, NoteAddedDate,
      Inactive, AddressLocked, Deceased, ${names.map((name) => `[${name}]`).join(', ')})
    VALUES (@row, @auto, @id, @status, @notes, SYSUTCDATETIME(), 0, 0, 0, ${names.map((name) => `@f_${name}`).join(', ')})`);
  return id;
}

function registrationNotes(details, reviewer, how) {
  const today = new Date().toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short', year: 'numeric' });
  const lines = [`${how}; added to the register ${today} by ${reviewer}.`];
  for (const field of REGISTRATION_EXTRA) {
    if (details[field.name]) lines.push(`${field.label}: ${field.type === 'choice' ? field.options.find(([value]) => value === details[field.name])?.[1] : details[field.name]}`);
  }
  return lines.join('\n');
}

/**
 * Approver decision on a proposed change. Approving applies it to bms.Applicants, but only if
 * the record still has the values the member saw; otherwise staff must re-check.
 */
export async function decideChange(staff, changeRequestId, { action, note }) {
  if (!['approve', 'reject'].includes(action)) throw new MemberError('Unknown action.');
  if (action === 'reject' && !String(note ?? '').trim()) throw new MemberError('Add a note for the member explaining why.');
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const request = () => new sql.Request(transaction);
  try {
    const found = await request().input('id', sql.Int, changeRequestId)
      .query('SELECT * FROM app.ChangeRequests WITH (UPDLOCK) WHERE ChangeRequestId = @id');
    const change = found.recordset[0];
    if (!change || change.Status !== 'pending') throw new MemberError('This change has already been dealt with.', 409);
    const changes = JSON.parse(change.ChangesJson);

    if (action === 'approve') {
      const columns = Object.keys(changes).filter((name) => FIELD.has(name));
      const current = await request().input('a', sql.Int, change.ApplicantID)
        .query(`SELECT ${columns.map((name) => `[${name}]`).join(', ')} FROM bms.Applicants WITH (UPDLOCK) WHERE ApplicantID = @a`);
      const row = current.recordset[0];
      if (!row) throw new MemberError('The applicant record no longer exists.', 409);
      const stale = columns.filter((name) => memberValue(FIELD.get(name), row[name]) !== changes[name].from);
      if (stale.length) {
        throw new MemberError(`The record has changed since the member asked (${stale.map((name) => FIELD.get(name).label).join(', ')}). Reject this request with a note and ask them to check again.`, 409);
      }
      const update = request().input('a', sql.Int, change.ApplicantID);
      columns.forEach((name) => update.input(`f_${name}`, sqlType(FIELD.get(name)), sqlValue(FIELD.get(name), changes[name].to)));
      await update.query(`UPDATE bms.Applicants SET ${columns.map((name) => `[${name}] = @f_${name}`).join(', ')} WHERE ApplicantID = @a`);
    }

    await request()
      .input('id', sql.Int, changeRequestId).input('status', sql.NVarChar(20), action === 'approve' ? 'approved' : 'rejected')
      .input('by', sql.NVarChar(200), staff.email || staff.name).input('note', sql.NVarChar(1000), note ? String(note).trim().slice(0, 1000) : null)
      .query('UPDATE app.ChangeRequests SET Status = @status, ReviewedBy = @by, ReviewedAt = SYSUTCDATETIME(), ReviewNote = @note WHERE ChangeRequestId = @id');
    await transaction.commit();
    await audit(staff, `change.${action === 'approve' ? 'approved' : 'rejected'}`, 'bms.Applicants', String(change.ApplicantID), { changeRequestId, fields: Object.keys(changes) });
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}

// ---- Staff adding a person directly (paper applications) ----

/** Fields and choices for the staff "Add person" form. */
export async function applicantFormOptions() {
  const pool = await getPool();
  const statuses = await pool.request().query("SELECT ApplicantStatusID AS id, ApplicantStatus AS label FROM bms.ApplicantStatus WHERE ApplicantStatusID <> 0 AND ApplicantStatus IS NOT NULL ORDER BY ApplicantStatusID");
  return { fields: MEMBER_FIELDS, extra: REGISTRATION_EXTRA, statuses: statuses.recordset, defaultStatus: NEW_APPLICANT_STATUS };
}

// Staff entering a paper form only need a name; everything else is optional.
function cleanStaffEntry(input) {
  const details = {};
  for (const field of [...MEMBER_FIELDS, ...REGISTRATION_EXTRA]) {
    const value = cleanValue(field, input?.[field.name]);
    if (value !== null) details[field.name] = value;
  }
  if (!details.FirstName || !details.LastName) throw new MemberError('First name and last name are needed.');
  if (input?.ReceivedOn) details.ReceivedOn = cleanValue({ label: 'Date received', type: 'date' }, input.ReceivedOn);
  return details;
}

/** People already on the register who look like this entry (same checks as online registrations). */
export async function findSimilar(input) {
  const details = cleanStaffEntry(input);
  const pool = await getPool();
  return suggestMatches(pool, details);
}

export async function createApplicant(staff, input) {
  const details = cleanStaffEntry(input);
  const pool = await getPool();
  const statusId = Number(input?.statusId ?? NEW_APPLICANT_STATUS);
  const status = await pool.request().input('s', sql.Int, statusId).query('SELECT 1 AS ok FROM bms.ApplicantStatus WHERE ApplicantStatusID = @s');
  if (!status.recordset.length) throw new MemberError('Choose a status.');
  const staffNote = input?.notes ? String(input.notes).trim().slice(0, 4000) : '';
  const how = details.ReceivedOn ? `Paper application received ${details.ReceivedOn}` : 'Entered by staff';
  const notes = [registrationNotes(details, staff.email || staff.name, how), staffNote].filter(Boolean).join('\n');

  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const applicantId = await insertApplicant(() => new sql.Request(transaction), details, statusId, notes);
    await transaction.commit();
    await audit(staff, 'applicant.created', 'bms.Applicants', String(applicantId), { statusId, source: details.ReceivedOn ? 'paper' : 'staff' });
    return { applicantId };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}

// ---- Moving an application between phases (Approvers) ----

const STATUS_DATES = { 30: 'ApprovedDate', 40: 'RejectedDate' }; // Registered, Application Rejected

/**
 * Changes a person's ApplicantStatusID, stamps ApprovedDate/RejectedDate when registering or
 * declining, and adds a dated line to Notes saying who moved it and why.
 */
export async function setApplicantStatus(staff, applicantId, input) {
  const statusId = Number(input?.statusId);
  const note = input?.note ? String(input.note).trim().slice(0, 1000) : '';
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const request = () => new sql.Request(transaction);
  try {
    const statuses = await request().query('SELECT ApplicantStatusID AS id, ApplicantStatus AS label FROM bms.ApplicantStatus');
    const label = (id) => statuses.recordset.find((row) => row.id === id)?.label ?? `status ${id}`;
    if (!statuses.recordset.some((row) => row.id === statusId)) throw new MemberError('Choose a status.');
    const found = await request().input('a', sql.Int, applicantId)
      .query('SELECT ApplicantStatusID FROM bms.Applicants WITH (UPDLOCK) WHERE ApplicantID = @a');
    if (!found.recordset.length) throw new MemberError('That person is no longer on the register.', 404);
    const from = found.recordset[0].ApplicantStatusID;
    if (from === statusId) throw new MemberError(`They are already “${label(statusId)}”.`);

    const today = new Date().toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short', year: 'numeric' });
    const line = `${today}: ${label(from)} → ${label(statusId)} by ${staff.email || staff.name}.${note ? ` ${note}` : ''}`;
    const dateColumn = STATUS_DATES[statusId];
    const result = await request()
      .input('a', sql.Int, applicantId).input('s', sql.SmallInt, statusId).input('line', sql.NVarChar(sql.MAX), line)
      .query(`
        UPDATE bms.Applicants
        SET ApplicantStatusID = @s,
            Notes = CASE WHEN Notes IS NULL OR Notes = '' THEN @line ELSE CONCAT(Notes, CHAR(10), @line) END,
            NoteAddedDate = SYSUTCDATETIME()${dateColumn ? `, [${dateColumn}] = SYSUTCDATETIME()` : ''}
        OUTPUT inserted.ApplicantStatusID, inserted.Notes, inserted.NoteAddedDate, inserted.ApprovedDate, inserted.RejectedDate
        WHERE ApplicantID = @a`);
    await transaction.commit();
    await audit(staff, 'applicant.statusChanged', 'bms.Applicants', String(applicantId), { from, to: statusId, note: note || undefined });
    return result.recordset[0];
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}

// ---- Staff editing a person's record directly (Approvers and Admins) ----

/**
 * Fields staff may edit on bms.Applicants. Status has its own control (Move to…); IDs, dates
 * Harbour stamps itself, and links to other tables are not edited here. Text limits match Access.
 */
export const STAFF_EDIT_FIELDS = [
  { name: 'FirstName', label: 'First name', max: 50, required: true },
  { name: 'MiddleNames', label: 'Middle names', max: 60 },
  { name: 'LastName', label: 'Last name', max: 50, required: true },
  { name: 'DOB', label: 'Date of birth', type: 'date' },
  { name: 'Gender', label: 'Gender', type: 'choice', options: [['', 'Not recorded'], ['F', 'Female'], ['M', 'Male'], ['G', 'Gender diverse']] },
  { name: 'Address0', label: 'Address line 1', max: 50 },
  { name: 'Address1', label: 'Address line 2 (suburb)', max: 50 },
  { name: 'Address2', label: 'Town or city, postcode', max: 50 },
  { name: 'Address3', label: 'Country', max: 50 },
  { name: 'PhoneNumber', label: 'Phone', max: 20 },
  { name: 'Mobile', label: 'Mobile', max: 20 },
  { name: 'FaxNumber', label: 'Fax', max: 20 },
  { name: 'Email', label: 'Email', max: 100, type: 'email' },
  { name: 'Constituancy', label: 'Constituency code', max: 1 },
  { name: 'Deceased', label: 'Deceased', type: 'boolean' },
  { name: 'DeceasedDate', label: 'Date of death', type: 'date' },
  { name: 'Inactive', label: 'Inactive', type: 'boolean' },
  { name: 'FollowupDate', label: 'Follow-up date', type: 'date', future: true },
];
const STAFF_FIELD = new Map(STAFF_EDIT_FIELDS.map((field) => [field.name, field]));

/** A stored value in the form the edit screen uses: dates as YYYY-MM-DD, booleans, text as stored. */
function staffValue(field, value) {
  if (field.type === 'boolean') return Boolean(value);
  if (value === null || value === undefined || value === '') return null;
  if (field.type === 'date') return new Date(value).toISOString().slice(0, 10);
  return String(value);
}

function cleanStaffValue(field, raw) {
  if (field.type === 'boolean') {
    if (typeof raw !== 'boolean') throw new MemberError(`${field.label}: choose yes or no.`);
    return raw;
  }
  if (field.type === 'date' && field.future && raw) {
    const text = String(raw).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) throw new MemberError(`${field.label}: use the date picker.`);
    return text;
  }
  return cleanValue(field, raw);
}

function staffSqlType(field) {
  if (field.type === 'boolean') return sql.Bit;
  if (field.type === 'date') return sql.DateTime2(3);
  return sql.NVarChar(field.max);
}

/** The editable fields and their current values, read fresh from the database. */
export async function applicantForEdit(applicantId) {
  const pool = await getPool();
  const columns = STAFF_EDIT_FIELDS.map((field) => `[${field.name}]`).join(', ');
  const found = await pool.request().input('a', sql.Int, applicantId)
    .query(`SELECT ApplicantID, ${columns} FROM bms.Applicants WHERE ApplicantID = @a`);
  const row = found.recordset[0];
  if (!row) throw new MemberError('That person is no longer on the register.', 404);
  return {
    applicantId: row.ApplicantID,
    fields: STAFF_EDIT_FIELDS,
    values: Object.fromEntries(STAFF_EDIT_FIELDS.map((field) => [field.name, staffValue(field, row[field.name])])),
  };
}

/**
 * Saves staff edits to bms.Applicants. `original` holds the values the editor started from; if
 * any changed field no longer has that value, someone else changed it meanwhile and nothing is
 * saved. Adds a dated line to Notes saying who edited what, and audits the old and new values.
 */
export async function updateApplicant(staff, applicantId, input) {
  const changesIn = input?.changes ?? {};
  const original = input?.original ?? {};
  const note = input?.note ? String(input.note).trim().slice(0, 1000) : '';
  const names = Object.keys(changesIn);
  for (const name of names) if (!STAFF_FIELD.has(name)) throw new MemberError(`${name} cannot be edited here.`);
  if (!names.length && !note) throw new MemberError('Nothing has changed.');

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const request = () => new sql.Request(transaction);
  try {
    const columns = STAFF_EDIT_FIELDS.map((field) => `[${field.name}]`).join(', ');
    const found = await request().input('a', sql.Int, applicantId)
      .query(`SELECT ${columns} FROM bms.Applicants WITH (UPDLOCK) WHERE ApplicantID = @a`);
    const row = found.recordset[0];
    if (!row) throw new MemberError('That person is no longer on the register.', 404);

    const changes = {};
    for (const name of names) {
      const field = STAFF_FIELD.get(name);
      const current = staffValue(field, row[name]);
      if (changesIn[name] === current) continue; // unchanged, even if it is an old value the form would not accept
      const to = cleanStaffValue(field, changesIn[name]);
      if (to === current) continue;
      if (field.required && !to) throw new MemberError(`${field.label} cannot be blank.`);
      if (!Object.hasOwn(original, name) || original[name] !== current) {
        throw new MemberError(`Someone else changed ${field.label} while you were editing. Close the editor and open it again to see their change.`, 409);
      }
      changes[name] = { from: current, to };
    }
    const changed = Object.keys(changes);
    if (!changed.length && !note) throw new MemberError('Nothing has changed.');

    const today = new Date().toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short', year: 'numeric' });
    const what = changed.length ? `Record edited by ${staff.email || staff.name} (${changed.map((name) => STAFF_FIELD.get(name).label).join(', ')}).` : `Note by ${staff.email || staff.name}.`;
    const line = `${today}: ${what}${note ? ` ${note}` : ''}`;

    const update = request().input('a', sql.Int, applicantId).input('line', sql.NVarChar(sql.MAX), line);
    const sets = changed.map((name) => {
      const field = STAFF_FIELD.get(name);
      const value = changes[name].to;
      update.input(`f_${name}`, staffSqlType(field), field.type === 'date' && value ? new Date(`${value}T00:00:00Z`) : value);
      return `[${name}] = @f_${name}`;
    });
    if (changes.Inactive) sets.push(changes.Inactive.to ? 'SetInactiveDate = SYSUTCDATETIME()' : 'SetInactiveDate = NULL');
    sets.push("Notes = CASE WHEN Notes IS NULL OR Notes = '' THEN @line ELSE CONCAT(Notes, CHAR(10), @line) END", 'NoteAddedDate = SYSUTCDATETIME()');
    await update.query(`UPDATE bms.Applicants SET ${sets.join(', ')} WHERE ApplicantID = @a`);
    await transaction.commit();
    await audit(staff, 'applicant.edited', 'bms.Applicants', String(applicantId), { changes, note: note || undefined });
    return { changed };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}

// ---- Members correcting a registration that is still waiting for review ----

export async function updateRegistration(identity, input) {
  const details = cleanRegistration(input);
  details.SignInEmail = identity.email;
  const pool = await getPool();
  const member = await account(pool, identity);
  const result = await pool.request()
    .input('m', sql.Int, member.MemberAccountId)
    .input('details', sql.NVarChar(sql.MAX), JSON.stringify(details))
    .query("UPDATE app.MemberRegistrations SET DetailsJson = @details OUTPUT inserted.RegistrationId WHERE MemberAccountId = @m AND Status = 'pending'");
  if (!result.recordset.length) throw new MemberError('There is no registration waiting for review to change. If yours has already been checked, ask for a change from your details page instead.', 409);
  await audit(memberActor(identity), 'member.registrationEdited', 'app.MemberRegistrations', String(result.recordset[0].RegistrationId), null);
}

// ---- Deleting a person's record (Admins only) ----

/**
 * Rows in other register tables that belong to one person and go with them. Relationship rows
 * are only the links; the other people in them stay on the register. Attachments are the
 * register's pointers to files, not the files themselves.
 */
const PERSON_ROWS = [
  { table: 'ApplicantRelationships', label: 'family links', one: 'family link', where: 'ParentApplicantID = @a OR ChildApplicantID = @a' },
  { table: 'Attachments', label: 'attachments', one: 'attachment', where: 'ApplicantID = @a' },
  { table: 'Notes', label: 'notes', one: 'note', where: 'ApplicantID = @a' },
  { table: 'NoteEmails', label: 'saved emails', one: 'saved email', where: 'ApplicantID = @a' },
  { table: 'FundApplications', label: 'fund applications', one: 'fund application', where: 'ApplicantID = @a' },
];

async function deletionPlan(request, applicantId, lock) {
  if (!Number.isInteger(applicantId) || applicantId < 1) throw new MemberError('That person is no longer on the register.', 404);
  const found = await request().input('a', sql.Int, applicantId)
    .query(`SELECT * FROM bms.Applicants${lock ? ' WITH (UPDLOCK, HOLDLOCK)' : ''} WHERE ApplicantID = @a`);
  const person = found.recordset[0];
  if (!person) throw new MemberError('That person is no longer on the register.', 404);
  const related = [];
  for (const item of PERSON_ROWS) {
    const exists = await request().input('t', sql.NVarChar(200), `bms.${item.table}`).query('SELECT OBJECT_ID(@t) AS id');
    if (!exists.recordset[0].id) continue;
    const rows = await request().input('a', sql.Int, applicantId)
      .query(`SELECT * FROM bms.[${item.table}]${lock ? ' WITH (UPDLOCK, HOLDLOCK)' : ''} WHERE ${item.where}`);
    related.push({ ...item, rows: rows.recordset });
  }
  const login = await request().input('a', sql.Int, applicantId)
    .query("SELECT MemberAccountId, Email FROM app.MemberAccounts WHERE ApplicantID = @a AND Status = 'linked'");
  const requests = await request().input('a', sql.Int, applicantId)
    .query("SELECT COUNT(*) AS n FROM app.ChangeRequests WHERE ApplicantID = @a AND Status = 'pending'");
  return { person, related, logins: login.recordset, pendingRequests: requests.recordset[0].n };
}

function personName(person) {
  return [person.FirstName, person.MiddleNames, person.LastName].map((part) => String(part ?? '').trim()).filter(Boolean).join(' ') || `Person ${person.ApplicantID}`;
}

/** What deleting this person would remove, for the confirmation screen. */
export async function deletionSummary(applicantId) {
  const pool = await getPool();
  const plan = await deletionPlan(() => pool.request(), applicantId, false);
  return {
    applicantId,
    name: personName(plan.person),
    related: plan.related.filter((item) => item.rows.length).map((item) => ({ label: item.rows.length === 1 ? item.one : item.label, count: item.rows.length })),
    memberLogin: plan.logins.map((row) => row.Email).filter(Boolean),
    pendingRequests: plan.pendingRequests,
  };
}

/**
 * Permanently removes a person and the rows that belong to them, in one transaction. A member
 * login linked to them is unlinked (they can register again), and their pending change requests
 * are closed. The audit entry keeps a full copy of every removed row.
 */
export async function deleteApplicant(staff, applicantId, input) {
  if (input?.confirm !== true) throw new MemberError('Confirm the delete first.');
  const reason = input?.reason ? String(input.reason).trim().slice(0, 1000) : '';
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const request = () => new sql.Request(transaction);
  try {
    const plan = await deletionPlan(request, applicantId, true);
    for (const item of plan.related) {
      if (item.rows.length) await request().input('a', sql.Int, applicantId).query(`DELETE FROM bms.[${item.table}] WHERE ${item.where}`);
    }
    await request().input('a', sql.Int, applicantId)
      .query('UPDATE bms.Applicants SET AddressLockedToApplicantID = NULL WHERE AddressLockedToApplicantID = @a');
    await request().input('a', sql.Int, applicantId).query('DELETE FROM bms.Applicants WHERE ApplicantID = @a');
    await request().input('a', sql.Int, applicantId)
      .query("UPDATE app.MemberAccounts SET ApplicantID = NULL, Status = 'pending', LinkedBy = NULL, LinkedAt = NULL WHERE ApplicantID = @a AND Status = 'linked'");
    await request().input('a', sql.Int, applicantId).input('by', sql.NVarChar(200), staff.email || staff.name)
      .query("UPDATE app.ChangeRequests SET Status = 'rejected', ReviewedBy = @by, ReviewedAt = SYSUTCDATETIME(), ReviewNote = 'The record was removed from the register.' WHERE ApplicantID = @a AND Status = 'pending'");
    await transaction.commit();
    await audit(staff, 'applicant.deleted', 'bms.Applicants', String(applicantId), {
      name: personName(plan.person),
      reason: reason || undefined,
      unlinkedLogins: plan.logins.map((row) => row.MemberAccountId),
      closedRequests: plan.pendingRequests,
      removed: { Applicants: [plan.person], ...Object.fromEntries(plan.related.filter((item) => item.rows.length).map((item) => [item.table, item.rows])) },
    });
    return { deleted: applicantId };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}
