const $ = (selector) => document.querySelector(selector);
let meta = { fields: [], extra: [] };

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

function when(value) {
  return value ? new Date(value).toLocaleString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}

function labelFor(name) {
  return [...meta.fields, ...meta.extra].find((field) => field.name === name)?.label ?? name;
}

function display(name, value) {
  if (value === null || value === undefined || value === '') return '—';
  const field = [...meta.fields, ...meta.extra].find((item) => item.name === name);
  if (field?.type === 'choice') return field.options.find(([key]) => key === value)?.[1] ?? value;
  if (field?.type === 'date') {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  return String(value);
}

async function load() {
  try {
    const data = await api('GET', '/api/review');
    meta = { fields: data.fields, extra: data.extra };
    renderRegistrations(data.registrations);
    renderChanges(data.changes);
    status('');
  } catch (error) {
    status(error.message, true);
  }
}

// ---- Registrations ----

function renderRegistrations(list) {
  $('#registrationCount').textContent = `${list.length} waiting`;
  $('#registrations').replaceChildren(...(list.length ? list.map(registrationCard) : [el('p', { className: 'review-empty', textContent: 'No new registrations.' })]));
}

function registrationCard(item) {
  const d = item.details;
  const shown = ['FirstName', 'MiddleNames', 'LastName', 'DOB', 'Gender', 'Email', 'Mobile', 'PhoneNumber', 'Address0', 'Address1', 'Address2', 'Address3', 'AlreadyRegistered', 'Mother', 'Father', 'Grandparents', 'RegisteredWhanau', 'Notes'];
  const wide = new Set(['Grandparents', 'RegisteredWhanau', 'Notes']);
  const grid = el('div', { className: 'review-grid' },
    ...shown.filter((name) => d[name]).map((name) => el('div', { className: wide.has(name) ? 'wide' : '' }, el('span', { textContent: labelFor(name) }), el('strong', { textContent: display(name, d[name]) }))));

  const card = el('article', { className: 'review-item' },
    el('h3', { textContent: [d.FirstName, d.MiddleNames, d.LastName].filter(Boolean).join(' ') }, el('small', { textContent: `signed in as ${item.signInEmail || 'unknown'} · ${when(item.submittedAt)}` })),
    grid);

  const matchArea = el('div');
  const showMatches = (rows, heading) => {
    matchArea.replaceChildren(
      el('div', { className: 'review-sub', textContent: heading }),
      rows.length ? matchTable(rows, item, card) : el('p', { className: 'review-empty', textContent: 'No similar records found.' }));
  };
  showMatches(item.matches, 'Possible existing records');

  const search = el('input', { type: 'search', placeholder: 'Search the register by name, email or ID…' });
  const searchButton = el('button', { type: 'button', className: 'secondary', textContent: 'Search' });
  const runSearch = async () => {
    try { showMatches(await api('GET', `/api/review/search?q=${encodeURIComponent(search.value)}`), `Search results for “${search.value}”`); } catch (error) { status(error.message, true); }
  };
  searchButton.addEventListener('click', runSearch);
  search.addEventListener('keydown', (event) => { if (event.key === 'Enter') runSearch(); });

  const note = el('input', { type: 'text', placeholder: 'Note to the member (needed to reject)' });
  const create = el('button', { type: 'button', textContent: 'Add as new applicant' });
  const reject = el('button', { type: 'button', className: 'danger', textContent: 'Reject' });
  create.addEventListener('click', () => {
    if (!window.confirm(`Add ${d.FirstName} ${d.LastName} to the register as a new applicant (status “Application Received”)? Only do this if they are not already on the register.`)) return;
    decideRegistration(item, { action: 'create', note: note.value }, card);
  });
  reject.addEventListener('click', () => decideRegistration(item, { action: 'reject', note: note.value }, card));

  card.append(matchArea, el('div', { className: 'review-actions' }, search, searchButton), el('div', { className: 'review-actions' }, note, create, reject));
  return card;
}

function matchTable(rows, item, card) {
  return el('table', { className: 'match-table' },
    el('thead', {}, el('tr', {}, ...['ID', 'Name', 'DOB', 'Email', 'Address', 'Status', ''].map((text) => el('th', { textContent: text })))),
    el('tbody', {}, ...rows.map((row) => {
      const link = el('button', { type: 'button', textContent: row.AlreadyLinked ? 'Already linked' : 'Link to this record', disabled: Boolean(row.AlreadyLinked) });
      link.addEventListener('click', () => {
        if (!window.confirm(`Link this member to applicant ${row.ApplicantID} (${row.FirstName} ${row.LastName})? They will be able to see that record.`)) return;
        decideRegistration(item, { action: 'link', applicantId: row.ApplicantID }, card);
      });
      return el('tr', {},
        el('td', { className: 'score', textContent: row.ApplicantID }),
        el('td', { textContent: [row.FirstName, row.MiddleNames, row.LastName].filter(Boolean).join(' ') }),
        el('td', { textContent: display('DOB', row.DOB) }),
        el('td', { textContent: row.Email || '—' }),
        el('td', { textContent: [row.Address0, row.Address2].filter(Boolean).join(', ') || '—' }),
        el('td', { textContent: row.ApplicantStatus || '' }),
        el('td', {}, link));
    })));
}

async function decideRegistration(item, body, card) {
  card.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const result = await api('POST', `/api/review/registrations/${item.registrationId}`, body);
    status(body.action === 'reject' ? 'Registration rejected; the member will see your note.' : `Member linked to applicant ${result.applicantId}.`);
    await load();
  } catch (error) {
    status(error.message, true);
    card.querySelectorAll('button').forEach((button) => { button.disabled = false; });
  }
}

// ---- Changes ----

function renderChanges(list) {
  $('#changeCount').textContent = `${list.length} waiting`;
  $('#changes').replaceChildren(...(list.length ? list.map(changeCard) : [el('p', { className: 'review-empty', textContent: 'No changes waiting.' })]));
}

function changeCard(item) {
  const card = el('article', { className: 'review-item' },
    el('h3', { textContent: `${item.name || 'Unknown'} · applicant ${item.applicantId}` }, el('small', { textContent: `${item.signInEmail || ''} · ${when(item.submittedAt)}` })),
    el('table', { className: 'diff-table' },
      el('thead', {}, el('tr', {}, el('th', { textContent: 'Field' }), el('th', { textContent: 'Now' }), el('th', { textContent: 'Change to' }))),
      el('tbody', {}, ...Object.entries(item.changes).map(([name, change]) => el('tr', {},
        el('td', { textContent: labelFor(name) }),
        el('td', { className: 'from', textContent: display(name, change.from) }),
        el('td', { className: 'to', textContent: display(name, change.to) }))))),
    item.note ? el('p', { className: 'review-note', textContent: `Member’s note: ${item.note}` }) : null);

  const note = el('input', { type: 'text', placeholder: 'Note to the member (needed to reject)' });
  const approve = el('button', { type: 'button', textContent: 'Approve and update record' });
  const reject = el('button', { type: 'button', className: 'danger', textContent: 'Reject' });
  const decide = async (action) => {
    card.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      await api('POST', `/api/review/changes/${item.changeRequestId}`, { action, note: note.value });
      status(action === 'approve' ? `Record ${item.applicantId} updated.` : 'Change rejected; the member will see your note.');
      await load();
    } catch (error) {
      status(error.message, true);
      card.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  };
  approve.addEventListener('click', () => decide('approve'));
  reject.addEventListener('click', () => decide('reject'));
  card.append(el('div', { className: 'review-actions' }, note, approve, reject));
  return card;
}

api('GET', '/api/me').then((me) => {
  $('#whoAmI').textContent = me.email || me.name;
  if (me.role === 'Admin') $('#operatorsLink').hidden = false;
}).catch(() => {});
load();
