// Applications: the people list and each person's profile.
// The list loads only names, emails and statuses (/api/staff/people). A person's full record and
// linked records load when they are opened (/api/staff/people/:key). The server keeps the register
// in memory and works out how the tables link, so this page stays small and quick.

const $ = (selector) => document.querySelector(selector);
const state = { table: 'Applicants', keyField: 'ApplicantID', all: [], people: [], selectedKey: null, details: new Map(), listMode: 'all', nameDescending: false, applicantStatuses: new Map(), canEdit: false, canDelete: false };
// Application phases shown under Applications, and the ApplicantStatus each one lists.
const PHASES = {
  all: { label: 'List All', intro: 'Every person on the register. Open a profile to see their connected records.', status: null },
  processing: { label: 'Processing', intro: 'Applications received and being checked.', status: 10 },
  awaiting: { label: 'Awaiting Information', intro: 'Applications waiting on more information from the applicant.', status: 20 },
  registered: { label: 'Registered', intro: 'Registered whānau members.', status: 30 },
  declined: { label: 'Declined', intro: 'Applications that were declined.', status: 40 },
  cancelled: { label: 'Cancelled', intro: 'Applications that were cancelled.', status: 99 },
};
const STATUS_FIELD = 'ApplicantStatusID';

function norm(value) { return String(value ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function token(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLocaleLowerCase();
  return text ? text : null;
}
function isBinary(value) { return value instanceof Uint8Array || (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)); }
function displayValue(value) {
  if (value === null || value === undefined) return '(Null)';
  if (isBinary(value)) return `[Binary · ${(value.byteLength ?? value.data.length).toLocaleString()} bytes]`;
  if (Array.isArray(value)) return value.map((item) => item?.name || String(item)).join('; ');
  if (value instanceof Date) return formatUsDate(value);
  return String(value);
}

/** Register dates have no time zone and arrive as UTC, so read them as UTC. */
function formatUsDate(value) {
  return `${value.getUTCMonth() + 1}/${value.getUTCDate()}/${value.getUTCFullYear()}`;
}

function applicantStatusLabel(value) {
  const key = token(value);
  if (key === null) return '';
  return state.applicantStatuses.get(key) ?? `Unmapped status (ID ${String(value)})`;
}

function displayRecordField(record, field) {
  return norm(field) === 'applicantstatusid'
    ? `${applicantStatusLabel(record[field])} (ID: ${displayValue(record[field])})`
    : displayValue(record[field]);
}

async function getJson(url) {
  const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (response.status === 401) {
    // Session expired: sign in again and come back to this page.
    window.location.href = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    return new Promise(() => {});
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `The server returned ${response.status}.`);
  return body;
}

// ---- The list ----

const clean = (value) => (value != null && String(value).trim() ? String(value).trim() : '');
// Sort on the tidied name: a stray leading space or "(" would otherwise put " Gordon" above "Abbott".
const sortKey = (value) => clean(value).replace(/^[^\p{L}\p{N}]+/u, '');

function makePerson([key, first, middle, last, email, status], index) {
  const name = [first, middle, last].map(clean).filter(Boolean).join(' ') || clean(email) || `Person ${index + 1}`;
  // Lists are sorted by surname, so they show "Surname, First names".
  const given = [first, middle].map(clean).filter(Boolean).join(' ');
  const listName = clean(last) && given ? `${clean(last)}, ${given}` : name;
  const subline = clean(email) || `${state.keyField}: ${key}`;
  return { key, name, listName, subline, first: sortKey(first), last: sortKey(last) || sortKey(name), status: status == null ? null : Number(status), search: `${name} ${listName} ${subline}`.toLowerCase() };
}

function updatePhaseCounts() {
  document.querySelectorAll('#applicationsNav button[data-mode]').forEach((button) => {
    const phase = PHASES[button.dataset.mode];
    const count = phase.status === null ? state.all.length : state.all.filter((person) => person.status === phase.status).length;
    button.querySelector('.nav-count').textContent = String(count);
  });
}

const compareText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** Rebuilds the list for the current phase. Keeps `preferKey` selected if it is still in the list. */
function loadPeople(preferKey = null) {
  const phase = PHASES[state.listMode] ?? PHASES.all;
  state.people = state.all
    .filter((person) => phase.status === null || person.status === phase.status)
    .sort((a, b) => {
      const byName = compareText(a.last, b.last) || compareText(a.first, b.first) || compareText(a.name, b.name);
      return state.nameDescending ? -byName : byName;
    });
  if (preferKey === null) $('#peopleSearch').value = '';
  renderPeople();
  updatePhaseCounts();
  $('#exportUsersButton').disabled = state.people.length === 0;
  // ?person=<key> opens that person (used after adding someone, and from duplicate checks).
  const wanted = preferKey ?? new URLSearchParams(window.location.search).get('person');
  const requested = wanted !== null ? state.people.find((person) => token(person.key) === token(wanted)) : null;
  if (requested) {
    selectPerson(requested.key);
    document.querySelector('.person-list-item.selected')?.scrollIntoView({ block: 'center' });
  } else if (state.people.length) selectPerson(state.people[0].key);
  else {
    state.selectedKey = null;
    showEmptyDetail(`No one in ${phase.label}`, phase.status === null ? 'The register has no people yet.' : 'There are no applications in this phase right now.');
  }
}

function renderPeople() {
  const host = $('#peopleList');
  const query = $('#peopleSearch').value.trim().toLowerCase();
  const visible = query ? state.people.filter((person) => person.search.includes(query)) : state.people;
  $('#peopleTotal').textContent = `${visible.length}`;
  const fragment = document.createDocumentFragment();
  visible.forEach((person) => {
    const button = document.createElement('button'); button.type = 'button';
    button.className = `person-list-item${token(state.selectedKey) === token(person.key) ? ' selected' : ''}`;
    button.dataset.key = String(person.key);
    const avatar = document.createElement('span'); avatar.className = 'person-avatar'; avatar.textContent = person.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    const info = document.createElement('span'); info.style.minWidth = '0';
    const name = document.createElement('span'); name.className = 'person-list-name'; name.textContent = person.listName;
    const sub = document.createElement('span'); sub.className = 'person-list-sub'; sub.textContent = person.subline;
    info.append(name, sub); button.append(avatar, info); fragment.append(button);
  });
  if (!visible.length) { const empty = document.createElement('div'); empty.className = 'person-empty'; empty.style.minHeight = '100px'; empty.textContent = 'No matching people'; fragment.append(empty); }
  host.replaceChildren(fragment);
}

function markSelected() {
  document.querySelectorAll('#peopleList .person-list-item').forEach((button) => {
    button.classList.toggle('selected', token(button.dataset.key) === token(state.selectedKey));
  });
}

// ---- One person ----

function reviveDates(rows, dates) {
  if (!dates?.length) return;
  rows.forEach((row) => dates.forEach((column) => { if (typeof row[column] === 'string') row[column] = new Date(row[column]); }));
}

async function fetchDetail(key) {
  const cacheKey = token(key);
  if (!state.details.has(cacheKey)) {
    const request = getJson(`/api/staff/people/${encodeURIComponent(key)}`).then((detail) => {
      reviveDates([detail.record], detail.table.dates);
      detail.groups.forEach((group) => reviveDates(group.records, group.table.dates));
      return detail;
    });
    state.details.set(cacheKey, request);
    request.catch(() => state.details.delete(cacheKey));
  }
  return state.details.get(cacheKey);
}

async function selectPerson(key) {
  state.selectedKey = key;
  markSelected();
  const person = state.people.find((item) => token(item.key) === token(key)) ?? state.all.find((item) => token(item.key) === token(key));
  if (!person) return;
  const pending = setTimeout(() => showEmptyDetail(person.name, 'Loading their record…'), 150);
  try {
    const detail = await fetchDetail(key);
    clearTimeout(pending);
    if (token(state.selectedKey) !== token(key)) return; // someone else was chosen meanwhile
    renderPersonDetail(person, detail);
  } catch (error) {
    clearTimeout(pending);
    if (token(state.selectedKey) === token(key)) showEmptyDetail('Could not load this person', error.message);
  }
}

function showEmptyDetail(title, message) {
  const host = $('#personDetail'); host.replaceChildren();
  const empty = document.createElement('div'); empty.className = 'person-empty';
  const icon = document.createElement('span'); icon.textContent = '♙';
  const strong = document.createElement('strong'); strong.textContent = title;
  const small = document.createElement('small'); small.textContent = message;
  empty.append(icon, strong, small); host.append(empty);
}

function recordCategory(group) {
  const name = norm(group.table.name), fields = group.table.columns.map(norm).join(' ');
  if (/fund|grant|application/.test(name)) return 'Funding Applications';
  if (/attach|document|file|image|photo/.test(name) || /attachment|filename|filepath|filedata/.test(fields)) return 'Attachments';
  if (/email|correspondence|communication/.test(name) || /emailbody|emailsubject|sentdate|recipient/.test(fields)) return 'Emails';
  if (/note|memo|comment|journal/.test(name) || /notetext|notecontent|memotext/.test(fields)) return 'All Notes';
  if (/contact|address|phone|telephone/.test(name) || /address|phone|telephone|constituency|hapu/.test(fields)) return 'Contact Details';
  return 'Other Records';
}

/** Current status, and for Approvers/Admins a control to move the application to another phase. */
function statusControl(person, detail) {
  const record = detail.record;
  const box = document.createElement('div'); box.className = 'status-control';
  const current = document.createElement('span'); current.className = 'status-current';
  current.textContent = record[STATUS_FIELD] == null ? 'No status' : applicantStatusLabel(record[STATUS_FIELD]);
  box.append(current);
  if (!state.canEdit) return box;

  const phaseFor = (id) => Object.values(PHASES).find((phase) => phase.status === id)?.label;
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Move to');
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Move to…'; select.append(placeholder);
  const currentStatus = record[STATUS_FIELD] == null ? null : Number(record[STATUS_FIELD]);
  [...state.applicantStatuses.entries()]
    .map(([key, label]) => ({ id: Number(key), label }))
    .filter((item) => item.id > 0 && item.id !== currentStatus)
    .sort((a, b) => (phaseFor(b.id) ? 1 : 0) - (phaseFor(a.id) ? 1 : 0) || a.id - b.id)
    .forEach((item) => { const option = document.createElement('option'); option.value = String(item.id); option.textContent = phaseFor(item.id) ? `${phaseFor(item.id)} — ${item.label}` : item.label; select.append(option); });
  const note = document.createElement('input'); note.type = 'text'; note.placeholder = 'Note (optional)'; note.maxLength = 1000; note.hidden = true;
  const move = document.createElement('button'); move.type = 'button'; move.textContent = 'Move'; move.hidden = true;
  select.addEventListener('change', () => { note.hidden = move.hidden = !select.value; if (select.value) note.focus(); });
  move.addEventListener('click', async () => {
    move.disabled = select.disabled = true;
    try {
      const applicantId = record.ApplicantID ?? person.key;
      const response = await fetch(`/api/staff/applicants/${encodeURIComponent(applicantId)}/status`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Harbour': '1' },
        body: JSON.stringify({ statusId: Number(select.value), note: note.value.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `The server returned ${response.status}.`);
      // Update the loaded copy so the lists and counts change straight away.
      for (const field of ['ApplicantStatusID', 'Notes', 'NoteAddedDate', 'ApprovedDate', 'RejectedDate']) {
        if (field in data && field in record) record[field] = /Date$/.test(field) && data[field] ? new Date(data[field]) : data[field];
      }
      person.status = data.ApplicantStatusID == null ? null : Number(data.ApplicantStatusID);
      loadPeople(person.key);
      $('#loadStatus').textContent = `${person.name} moved to ${applicantStatusLabel(data.ApplicantStatusID)}.`;
    } catch (error) {
      $('#loadStatus').textContent = error.message;
      move.disabled = select.disabled = false;
    }
  });
  box.append(select, note, move);
  return box;
}

// ---- Editing a record (Approvers and Admins) ----

async function sendJson(method, url, body) {
  const response = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Harbour': '1' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The server returned ${response.status}.`);
  return data;
}

function editorControl(field, value) {
  const id = `edit_${field.name}`;
  let input;
  if (field.type === 'boolean') {
    input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(value);
  } else if (field.type === 'choice') {
    input = document.createElement('select');
    const options = [...field.options];
    // Keep an old value the list does not offer (for example a code from Access), so saving does not change it.
    if (value != null && !options.some(([key]) => key === value)) options.push([value, `${value} (as recorded)`]);
    options.forEach(([key, label]) => { const option = document.createElement('option'); option.value = key; option.textContent = label; input.append(option); });
    input.value = value ?? '';
  } else {
    input = document.createElement('input');
    input.type = field.type === 'date' ? 'date' : field.type === 'email' ? 'email' : 'text';
    input.value = value ?? '';
    if (field.max) input.maxLength = field.max;
    if (field.type === 'date' && !field.future) input.max = new Date().toISOString().slice(0, 10);
  }
  input.id = id; input.name = field.name;
  const label = document.createElement('label'); label.className = `edit-field${field.type === 'boolean' ? ' edit-check' : ''}`; label.htmlFor = id;
  const text = document.createElement('span'); text.textContent = `${field.label}${field.required ? ' *' : ''}`;
  if (field.type === 'boolean') label.append(input, text); else label.append(text, input);
  return label;
}

function editorValue(field, input) {
  if (field.type === 'boolean') return input.checked;
  const text = input.value.trim();
  return text || null;
}

async function openEditor(person, detail) {
  const applicantId = detail.record.ApplicantID ?? person.key;
  const host = $('#personDetail');
  showEmptyDetail(`Edit ${person.name}`, 'Loading the latest values…');
  let data;
  try {
    const response = await fetch(`/api/staff/applicants/${encodeURIComponent(applicantId)}/edit`, { credentials: 'same-origin' });
    data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `The server returned ${response.status}.`);
  } catch (error) {
    showEmptyDetail('Could not open the editor', error.message);
    return;
  }
  if (token(state.selectedKey) !== token(person.key)) return;

  const form = document.createElement('form'); form.className = 'record-editor'; form.noValidate = true;
  const head = document.createElement('header'); head.className = 'person-header';
  const copy = document.createElement('div'); copy.className = 'person-heading-copy';
  const title = document.createElement('h2'); title.textContent = `Edit ${person.name}`;
  const sub = document.createElement('p'); sub.textContent = `${detail.table.name} · ${detail.keyField}: ${applicantId}. Status is changed with “Move to…”.`;
  copy.append(title, sub); head.append(copy); form.append(head);

  const message = document.createElement('div'); message.className = 'editor-message'; message.setAttribute('role', 'status');
  const grid = document.createElement('div'); grid.className = 'edit-grid';
  data.fields.forEach((field) => grid.append(editorControl(field, data.values[field.name])));
  const noteLabel = document.createElement('label'); noteLabel.className = 'edit-field edit-wide'; noteLabel.htmlFor = 'edit_note';
  const noteText = document.createElement('span'); noteText.textContent = 'Add a note (optional; added to Notes with today’s date and your name)';
  const note = document.createElement('textarea'); note.id = 'edit_note'; note.maxLength = 1000; note.rows = 2;
  noteLabel.append(noteText, note); grid.append(noteLabel);

  const actions = document.createElement('div'); actions.className = 'editor-actions';
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'editor-save'; save.textContent = 'Save changes';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'editor-cancel'; cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => renderPersonDetail(person, detail));
  actions.append(save, cancel);
  form.append(message, grid, actions);

  form.addEventListener('input', (event) => {
    const field = data.fields.find((item) => item.name === event.target.name);
    if (field) event.target.closest('.edit-field').classList.toggle('changed', editorValue(field, event.target) !== data.values[field.name]);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const changes = {}, original = {};
    for (const field of data.fields) {
      const input = form.elements.namedItem(field.name);
      if (input.type !== 'checkbox' && !input.checkValidity()) { message.textContent = `Check “${field.label}”.`; message.classList.add('error'); input.focus(); return; }
      const value = editorValue(field, input);
      if (value !== data.values[field.name]) { changes[field.name] = value; original[field.name] = data.values[field.name]; }
    }
    if (!Object.keys(changes).length && !note.value.trim()) { message.textContent = 'You have not changed anything yet.'; message.classList.add('error'); return; }
    save.disabled = cancel.disabled = true; message.classList.remove('error'); message.textContent = 'Saving…';
    try {
      await sendJson('PATCH', `/api/staff/applicants/${encodeURIComponent(applicantId)}`, { changes, original, note: note.value.trim() });
      // Refresh the list entry and fetch the saved record.
      const values = { ...data.values, ...changes };
      Object.assign(person, makePerson([person.key, values.FirstName, values.MiddleNames, values.LastName, values.Email, person.status], 0));
      state.details.delete(token(person.key));
      loadPeople(person.key);
      $('#loadStatus').textContent = `Saved changes to ${person.name}.`;
    } catch (error) {
      message.textContent = error.message; message.classList.add('error');
      save.disabled = cancel.disabled = false;
    }
  });
  host.replaceChildren(form);
  form.querySelector('input,select')?.focus();
}

// ---- Deleting a record (Admins only) ----

function confirmDelete(person, detail) {
  const applicantId = detail.record.ApplicantID ?? person.key;
  const dialog = document.createElement('dialog'); dialog.className = 'delete-dialog';
  const title = document.createElement('h2'); title.textContent = `Delete ${person.name}?`;
  const body = document.createElement('div'); body.className = 'delete-summary'; body.textContent = 'Checking what is linked to this record…';
  const form = document.createElement('form'); form.method = 'dialog'; form.className = 'delete-form';
  const reasonLabel = document.createElement('label'); reasonLabel.htmlFor = 'delete_reason'; reasonLabel.textContent = 'Reason (optional, kept in the audit log)';
  const reason = document.createElement('textarea'); reason.id = 'delete_reason'; reason.rows = 2; reason.maxLength = 1000;
  const typeLabel = document.createElement('label'); typeLabel.htmlFor = 'delete_confirm'; typeLabel.innerHTML = 'Type <b>DELETE</b> to confirm';
  const typed = document.createElement('input'); typed.id = 'delete_confirm'; typed.autocomplete = 'off'; typed.spellcheck = false;
  const message = document.createElement('p'); message.className = 'editor-message'; message.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'editor-actions';
  const go = document.createElement('button'); go.type = 'submit'; go.className = 'delete-confirm-button'; go.textContent = 'Delete permanently'; go.disabled = true;
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'editor-cancel'; cancel.textContent = 'Cancel';
  actions.append(go, cancel);
  form.append(reasonLabel, reason, typeLabel, typed, message, actions);
  dialog.append(title, body, form);
  document.body.append(dialog);
  let ready = false, busy = false;
  const update = () => { go.disabled = busy || !ready || typed.value.trim().toUpperCase() !== 'DELETE'; };
  typed.addEventListener('input', update);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
  cancel.focus();

  getJson(`/api/staff/applicants/${encodeURIComponent(applicantId)}/delete`).then((summary) => {
    body.replaceChildren();
    const lead = document.createElement('p'); lead.innerHTML = '<strong>This cannot be undone.</strong> ';
    lead.append(`${summary.name} (ApplicantID ${summary.applicantId}) will be removed from the register.`);
    body.append(lead);
    const items = [...summary.related.map((item) => `${item.count} ${item.label}`)];
    if (summary.memberLogin.length) items.push(`Their member login (${summary.memberLogin.join(', ')}) will be unlinked; they can register again`);
    if (summary.pendingRequests) items.push(`${summary.pendingRequests} change request${summary.pendingRequests === 1 ? '' : 's'} waiting for review will be closed`);
    if (items.length) {
      const also = document.createElement('p'); also.textContent = 'Also removed with them:'; body.append(also);
      const list = document.createElement('ul'); items.forEach((text) => { const li = document.createElement('li'); li.textContent = text; list.append(li); }); body.append(list);
      if (summary.related.some((item) => item.label.startsWith('family link'))) {
        const note = document.createElement('p'); note.className = 'dialog-note'; note.textContent = 'Removing family links does not remove the other people in them.'; body.append(note);
      }
    } else {
      const none = document.createElement('p'); none.textContent = 'Nothing else in the register is linked to them.'; body.append(none);
    }
    ready = true; update(); typed.focus();
  }).catch((error) => { body.textContent = error.message; body.classList.add('error'); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (go.disabled) return;
    busy = true; update(); cancel.disabled = true; message.classList.remove('error'); message.textContent = 'Deleting…';
    try {
      await sendJson('DELETE', `/api/staff/applicants/${encodeURIComponent(applicantId)}`, { confirm: true, reason: reason.value.trim() });
      const index = state.people.findIndex((item) => token(item.key) === token(person.key));
      const next = state.people[index + 1] ?? state.people[index - 1] ?? null;
      state.all = state.all.filter((item) => token(item.key) !== token(person.key));
      state.details.delete(token(person.key));
      const url = new URL(window.location.href);
      if (url.searchParams.has('person')) { url.searchParams.delete('person'); history.replaceState(null, '', url); }
      busy = false; dialog.close();
      loadPeople(next ? next.key : null);
      $('#loadStatus').textContent = `Deleted ${person.name} from the register.`;
    } catch (error) {
      busy = false; cancel.disabled = false; update();
      message.textContent = error.message; message.classList.add('error');
    }
  });
}

function renderPersonDetail(person, detail) {
  const entity = detail.table;
  const host = $('#personDetail'); host.replaceChildren();
  const header = document.createElement('header'); header.className = 'person-header';
  const avatar = document.createElement('span'); avatar.className = 'person-large-avatar'; avatar.textContent = person.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const copy = document.createElement('div'); copy.className = 'person-heading-copy';
  const title = document.createElement('h2'); title.textContent = person.name;
  const subtitle = document.createElement('p'); subtitle.textContent = `${entity.name} · ${detail.keyField}: ${displayValue(person.key)}`;
  copy.append(title, subtitle); header.append(avatar, copy); host.append(header);
  if (state.canEdit && norm(entity.name) === 'applicants') {
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'edit-record-button'; edit.textContent = 'Edit record';
    edit.addEventListener('click', () => openEditor(person, detail));
    header.append(edit);
  }
  if (state.canDelete && norm(entity.name) === 'applicants') {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete-record-button'; remove.textContent = 'Delete';
    remove.addEventListener('click', () => confirmDelete(person, detail));
    header.append(remove);
  }
  if (norm(entity.name) === 'applicants' && entity.columns.includes(STATUS_FIELD)) header.append(statusControl(person, detail));

  const categories = ['Contact Details', 'Attachments', 'Emails', 'All Notes', 'Funding Applications', 'Other Records'];
  const categorized = new Map(categories.map((label) => [label, []]));
  detail.groups.forEach((group) => categorized.get(recordCategory(group)).push(group));
  const tabs = document.createElement('div'); tabs.className = 'profile-tabs'; tabs.setAttribute('role', 'tablist');
  const panels = document.createElement('div'); panels.className = 'profile-tab-panels';
  const showTab = (name) => {
    tabs.querySelectorAll('button').forEach((button) => { const active = button.dataset.tab === name; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
    panels.querySelectorAll('.profile-tab-panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
  };
  categories.forEach((name, index) => {
    const list = categorized.get(name);
    if (name === 'Other Records' && !list.length) return;
    const tab = document.createElement('button'); tab.type = 'button'; tab.className = `profile-tab${index === 0 ? ' active' : ''}`; tab.dataset.tab = name; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(index === 0));
    tab.textContent = `${name}${list.length ? ` (${list.reduce((sum, group) => sum + group.records.length, 0)})` : ''}`;
    tab.addEventListener('click', () => showTab(name)); tabs.append(tab);
    const panel = document.createElement('section'); panel.className = 'profile-tab-panel'; panel.dataset.panel = name; panel.setAttribute('role', 'tabpanel'); panel.hidden = index !== 0;
    if (name === 'Contact Details') {
      const profile = document.createElement('div'); profile.className = 'profile-fields';
      entity.columns.forEach((field) => {
        const item = document.createElement('div'); item.className = 'profile-field';
        const label = document.createElement('span'); label.textContent = norm(field) === 'applicantstatusid' ? 'Applicant Status' : field;
        const value = document.createElement('strong'); value.textContent = displayRecordField(detail.record, field);
        item.append(label, value); profile.append(item);
      });
      panel.append(profile);
    }
    const groupHost = document.createElement('div'); groupHost.className = 'related-groups';
    if (!list.length) {
      const empty = document.createElement('div'); empty.className = 'no-related'; empty.textContent = name === 'Contact Details' ? 'The main person record is shown above. No additional contact records were linked.' : `No ${name.toLowerCase()} were linked to this entry.`; groupHost.append(empty);
    } else list.forEach((group) => groupHost.append(makeRelatedGroup(group, person.key)));
    panel.append(groupHost); panels.append(panel);
  });
  host.append(tabs, panels);
}

function makeRelatedGroup(group, personKey) {
  const details = document.createElement('details'); details.className = 'related-group'; details.open = true;
  const summary = document.createElement('summary');
  const title = document.createElement('span'); title.className = 'related-group-title'; title.textContent = group.table.name;
  const key = document.createElement('span'); key.className = 'related-group-key'; key.textContent = `${group.field} = ${displayValue(personKey)}`;
  const meta = document.createElement('span'); meta.className = 'related-group-meta'; meta.textContent = `${group.records.length.toLocaleString()} records`;
  summary.append(title, key, meta); details.append(summary);
  const wrap = document.createElement('div'); wrap.className = 'related-table-wrap';
  const table = document.createElement('table'); table.className = 'related-table';
  const columns = group.table.columns;
  const header = document.createElement('thead'), headRow = document.createElement('tr');
  columns.forEach((column) => { const th = document.createElement('th'); th.textContent = norm(column) === 'applicantstatusid' ? 'Applicant Status' : column; headRow.append(th); }); header.append(headRow); table.append(header);
  const body = document.createElement('tbody');
  const pageSize = 50;
  function drawPage(page) {
    const start = page * pageSize; body.replaceChildren();
    group.records.slice(start, start + pageSize).forEach((record) => {
      const tr = document.createElement('tr'); columns.forEach((column) => { const td = document.createElement('td'); td.textContent = displayRecordField(record, column); td.title = td.textContent; tr.append(td); }); body.append(tr);
    });
    pageNote.textContent = group.records.length > pageSize ? `Showing ${start + 1}–${Math.min(start + pageSize, group.records.length)} of ${group.records.length.toLocaleString()}` : '';
    previous.disabled = page === 0; next.disabled = start + pageSize >= group.records.length;
  }
  table.append(body); wrap.append(table); details.append(wrap);
  const pager = document.createElement('div'); pager.className = 'related-pager';
  const previous = document.createElement('button'), next = document.createElement('button'), pageNote = document.createElement('span');
  previous.textContent = '← Previous'; next.textContent = 'Next →';
  previous.addEventListener('click', () => { const page = Number(pager.dataset.page || 0) - 1; pager.dataset.page = String(Math.max(0, page)); drawPage(Number(pager.dataset.page)); });
  next.addEventListener('click', () => { const page = Number(pager.dataset.page || 0) + 1; pager.dataset.page = String(page); drawPage(page); });
  pager.append(previous, pageNote, next); details.append(pager); drawPage(0);
  return details;
}

// ---- Export ----

/** The server builds the CSV (everyone in this phase, with their linked records). */
async function exportPeople() {
  const button = $('#exportUsersButton');
  button.disabled = true; button.textContent = 'Preparing CSV…';
  $('#loadStatus').textContent = `Collecting linked records for ${state.people.length.toLocaleString()} people…`;
  try {
    const response = await fetch(`/api/staff/people/export.csv?view=${encodeURIComponent(state.listMode)}`, { credentials: 'same-origin' });
    if (response.status === 401) { window.location.reload(); return; }
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `The server returned ${response.status}.`);
    const name = /filename="?([^";]+)"?/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'NgatiKuri_All_Users.csv';
    const link = document.createElement('a'); link.href = URL.createObjectURL(await response.blob()); link.download = name;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    $('#loadStatus').textContent = `Exported ${state.people.length.toLocaleString()} people with their linked records to CSV.`;
  } catch (error) {
    $('#loadStatus').textContent = `Could not export: ${error.message}`;
  } finally {
    button.disabled = false; button.textContent = 'Export all users';
  }
}

// ---- Start ----

async function init() {
  $('#loadStatus').textContent = 'Loading the register…';
  try {
    const data = await getJson('/api/staff/people');
    state.table = data.table; state.keyField = data.keyField;
    state.applicantStatuses = new Map(data.statuses);
    state.all = data.people.map(makePerson);
    $('#loadStatus').textContent = '';
    loadPeople();
  } catch (error) { $('#loadStatus').textContent = error.message; showEmptyDetail('Database unavailable', error.message); }
}

$('#peopleSearch').addEventListener('input', renderPeople);
$('#peopleList').addEventListener('click', (event) => {
  const button = event.target.closest('.person-list-item');
  if (button) selectPerson(state.people.find((person) => String(person.key) === button.dataset.key)?.key ?? button.dataset.key);
});
$('#applicationsNav').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-mode]');
  if (button) setListMode(button.dataset.mode);
});
$('#sortNameButton').addEventListener('click', () => {
  state.nameDescending = !state.nameDescending;
  $('#sortNameButton').textContent = `Name: ${state.nameDescending ? 'Z–A' : 'A–Z'}`;
  loadPeople(state.selectedKey);
});
$('#exportUsersButton').addEventListener('click', exportPeople);

function setListMode(mode) {
  const phase = PHASES[mode] ?? PHASES.all;
  state.listMode = PHASES[mode] ? mode : 'all';
  document.querySelectorAll('#applicationsNav button[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.listMode));
  $('#viewBreadcrumb').textContent = phase.label;
  $('#pageHeading').textContent = phase.label;
  $('#pageIntro').textContent = phase.intro;
  $('#peopleListLabel').textContent = phase.status === null ? 'All database entries' : `${phase.label} applications`;
  if (state.all.length) loadPeople();
}

// ?view=processing (etc.) opens a phase directly.
const initialView = new URLSearchParams(window.location.search).get('view');
if (initialView && PHASES[initialView]) setListMode(initialView);

init();

// Approvers see Maintenance → Member requests; Admins also see Operators (staff invites and roles).
fetch('/api/me', { credentials: 'same-origin' })
  .then((response) => (response.ok ? response.json() : null))
  .then((me) => {
    if (me?.role === 'Admin' || me?.role === 'Approver') {
      state.canEdit = true;
      if (state.selectedKey !== null) selectPerson(state.selectedKey);
      $('#maintenanceNav').hidden = false;
      $('#addPersonRow').hidden = false;
      $('#addPersonNav').hidden = false;
    }
    if (me?.role === 'Admin') {
      $('#operatorsButton').hidden = false;
      state.canDelete = true;
      if (state.selectedKey !== null) selectPerson(state.selectedKey);
    }
  })
  .catch(() => {});
$('#operatorsButton').addEventListener('click', () => { window.location.href = 'admin.html'; });
$('#reviewButton').addEventListener('click', () => { window.location.href = 'review.html'; });
$('#addPersonButton').addEventListener('click', () => { window.location.href = 'add-person.html'; });
$('#addPersonNav').addEventListener('click', () => { window.location.href = 'add-person.html'; });
