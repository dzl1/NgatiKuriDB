const $ = (selector) => document.querySelector(selector);
let options = null;
let checked = false; // true once staff have seen the similar-records check for the current entries

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', 'X-Harbour': '1' } : { 'X-Harbour': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) {
    window.location.href = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(window.location.pathname)}`;
    return new Promise(() => {});
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The server returned ${response.status}.`);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function status(message, isError = false) {
  const node = $('#pageStatus');
  node.textContent = message;
  node.classList.toggle('error', isError);
}

function control(field) {
  const id = `f_${field.name}`;
  let input;
  if (field.type === 'choice') {
    input = el('select', { id, name: field.name }, ...field.options.map(([value, label]) => el('option', { value, textContent: label })));
  } else if (field.type === 'long') {
    input = el('textarea', { id, name: field.name, maxLength: field.max });
  } else {
    input = el('input', { id, name: field.name, type: field.type === 'date' ? 'date' : field.type === 'email' ? 'email' : 'text', autocomplete: 'off' });
    if (field.max) input.maxLength = field.max;
    if (field.type === 'date') input.max = new Date().toISOString().slice(0, 10);
  }
  const required = field.name === 'FirstName' || field.name === 'LastName';
  input.required = required;
  return el('label', { className: `person-field${field.type === 'long' ? ' wide' : ''}`, htmlFor: id }, `${field.label}${required ? ' *' : ''}`, input);
}

function values() {
  const form = $('#personForm');
  const result = {};
  for (const field of [...options.fields, ...options.extra]) {
    const input = form.elements.namedItem(field.name);
    if (input) result[field.name] = input.value.trim();
  }
  result.ReceivedOn = $('#receivedOn').value;
  result.statusId = Number($('#statusId').value);
  result.notes = $('#staffNotes').value.trim();
  return result;
}

function display(value) {
  if (!value) return '—';
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function showSimilar(rows) {
  const box = $('#similar');
  box.hidden = false;
  box.replaceChildren(
    el('h2', { textContent: 'Is this person already on the register?' }),
    el('p', { className: 'similar-intro', textContent: `We found ${rows.length} similar record${rows.length === 1 ? '' : 's'}. Open them to check. If none is the same person, add them as new.` }),
    el('table', { className: 'match-table' },
      el('thead', {}, el('tr', {}, ...['ID', 'Name', 'DOB', 'Email', 'Address', 'Status', ''].map((text) => el('th', { textContent: text })))),
      el('tbody', {}, ...rows.map((row) => el('tr', {},
        el('td', { className: 'score', textContent: row.ApplicantID }),
        el('td', { textContent: [row.LastName, [row.FirstName, row.MiddleNames].filter(Boolean).join(' ')].filter(Boolean).join(', ') }),
        el('td', { textContent: display(row.DOB) }),
        el('td', { textContent: row.Email || '—' }),
        el('td', { textContent: [row.Address0, row.Address2].filter(Boolean).join(', ') || '—' }),
        el('td', { textContent: row.ApplicantStatus || '' }),
        el('td', {}, el('a', { href: `users.html?person=${row.ApplicantID}`, target: '_blank', rel: 'noopener', textContent: 'Open ↗' })))))));
  $('#saveButton').textContent = 'None of these — add as new person';
  checked = true;
}

async function save(event) {
  event.preventDefault();
  const form = $('#personForm');
  const missing = [...form.querySelectorAll('[required]')].find((input) => !input.value.trim());
  if (missing) { status('First name and last name are needed.', true); missing.focus(); return; }
  const bad = [...form.querySelectorAll('input')].find((input) => !input.checkValidity());
  if (bad) { status(`Check “${bad.closest('label')?.firstChild?.textContent?.replace(' *', '') ?? 'this field'}”.`, true); bad.focus(); return; }

  const button = $('#saveButton');
  button.disabled = true;
  try {
    const entry = values();
    if (!checked) {
      status('Checking for people already on the register…');
      const similar = await api('POST', '/api/staff/applicants/similar', entry);
      if (similar.length) {
        status('');
        showSimilar(similar);
        $('#similar').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    status('Adding…');
    const { applicantId } = await api('POST', '/api/staff/applicants', entry);
    status('');
    form.hidden = true;
    $('#done').hidden = false;
    $('#doneTitle').textContent = `${entry.FirstName} ${entry.LastName} added`;
    $('#doneText').textContent = `Applicant ID ${applicantId}, status “${options.statuses.find((item) => item.id === entry.statusId)?.label ?? ''}”.`;
    $('#openRecord').href = `users.html?person=${applicantId}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    status(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function reset() {
  $('#personForm').reset();
  $('#statusId').value = String(options.defaultStatus);
  $('#similar').hidden = true;
  $('#saveButton').textContent = 'Check and add person';
  checked = false;
}

async function init() {
  try {
    options = await api('GET', '/api/staff/applicants/form');
  } catch (error) {
    status(error.message, true);
    return;
  }
  $('#personFields').append(...options.fields.map(control));
  $('#whakapapaFields').append(...options.extra.filter((field) => field.name !== 'AlreadyRegistered').map(control));
  $('#statusId').append(...options.statuses.map((item) => el('option', { value: item.id, textContent: item.label, selected: item.id === options.defaultStatus })));
  $('#receivedOn').max = new Date().toISOString().slice(0, 10);
  $('#personForm').hidden = false;
  $('#personForm').addEventListener('submit', save);
  // Changing a name, date of birth or email means the similar-records check must run again.
  $('#personForm').addEventListener('input', (event) => {
    if (checked && ['FirstName', 'LastName', 'DOB', 'Email'].includes(event.target.name)) {
      checked = false;
      $('#similar').hidden = true;
      $('#saveButton').textContent = 'Check and add person';
    }
  });
  $('#addAnother').addEventListener('click', () => { reset(); $('#done').hidden = true; $('#personForm').hidden = false; });
}

api('GET', '/api/me').then((me) => {
  if (me.role === 'Admin') $('#operatorsLink').hidden = false;
}).catch(() => {});
init();
