const $ = (selector) => document.querySelector(selector);
let state = { staff: [], me: null, roles: [] };

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

function show(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function when(value) {
  if (!value) return '—';
  const date = new Date(value);
  return `${date.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })} ${date.toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' })}`;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

async function load() {
  try {
    const data = await api('GET', '/api/admin/staff');
    state = data;
    const pill = $('#mfaPolicy');
    pill.textContent = data.requireMfa ? 'MFA required for every sign-in' : 'MFA recorded, not yet required';
    pill.classList.toggle('warn', !data.requireMfa);
    render();
    show($('#staffStatus'), '');
  } catch (error) {
    show($('#staffStatus'), error.message, true);
  }
}

function render() {
  const table = $('#staffTable');
  const body = table.querySelector('tbody');
  body.replaceChildren(...state.staff.map(row));
  table.hidden = state.staff.length === 0;
  if (!state.staff.length) show($('#staffStatus'), 'No operators yet.');
}

function row(person) {
  const isMe = person.StaffUserId === state.me;
  const statusLabel = person.Status === 'invited' && person.Expired ? 'expired' : person.Status;

  const role = el('select', { disabled: isMe, title: isMe ? 'Another Admin must change your role.' : '' },
    ...state.roles.map((name) => el('option', { value: name, textContent: name, selected: name === person.Role })));
  role.addEventListener('change', () => update(person, { role: role.value }, role));

  const actions = el('div', { className: 'staff-actions' });
  if (person.Status === 'invited') {
    const resend = el('button', { type: 'button', textContent: 'Resend invite' });
    resend.addEventListener('click', () => resendInvite(person, resend));
    actions.append(resend);
  }
  if (!isMe) {
    const disabling = person.Status !== 'disabled';
    const toggle = el('button', { type: 'button', textContent: disabling ? 'Turn off access' : 'Turn on access', className: disabling ? 'danger' : '' });
    toggle.addEventListener('click', () => {
      if (disabling && !window.confirm(`Turn off Harbour access for ${person.DisplayName || person.Email}?`)) return;
      update(person, { status: disabling ? 'disabled' : 'active' }, toggle);
    });
    actions.append(toggle);
  }

  const mfa = person.LastSignInMfa === null ? '—' : person.LastSignInMfa ? 'Yes' : 'No';
  return el('tr', {},
    el('td', {}, el('strong', { textContent: `${person.DisplayName || person.Email}${isMe ? ' (you)' : ''}` }), el('small', { textContent: person.Email })),
    el('td', {}, role),
    el('td', {}, el('span', { className: `staff-status ${statusLabel}`, textContent: statusLabel }),
      person.Status === 'invited' ? el('small', { textContent: `${person.Expired ? 'Expired' : 'Expires'} ${when(person.InviteExpiresAt)}` }) : null),
    el('td', { textContent: when(person.LastSignInAt) }),
    el('td', { textContent: mfa, title: 'Whether their latest sign-in used multi-factor authentication' }),
    el('td', {}, actions));
}

async function update(person, changes, control) {
  control.disabled = true;
  try {
    await api('PATCH', `/api/admin/staff/${person.StaffUserId}`, changes);
    show($('#staffStatus'), `Updated ${person.DisplayName || person.Email}.`);
  } catch (error) {
    show($('#staffStatus'), error.message, true);
  }
  await load();
}

async function resendInvite(person, button) {
  button.disabled = true;
  try {
    const result = await api('POST', `/api/admin/staff/${person.StaffUserId}/resend`);
    show($('#staffStatus'), result.message);
  } catch (error) {
    show($('#staffStatus'), error.message, true);
  }
  await load();
}

$('#inviteForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('#inviteEmail').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    show($('#inviteResult'), 'Enter a valid email address.', true);
    return;
  }
  const button = $('#inviteButton');
  button.disabled = true;
  show($('#inviteResult'), 'Sending invite…');
  try {
    const result = await api('POST', '/api/admin/staff', { email, displayName: $('#inviteName').value.trim(), role: $('#inviteRole').value });
    show($('#inviteResult'), result.message);
    $('#inviteForm').reset();
    $('#inviteRole').value = 'Approver';
    await load();
  } catch (error) {
    show($('#inviteResult'), error.message, true);
  } finally {
    button.disabled = false;
  }
});

api('GET', '/api/me').then((me) => { $('#whoAmI').textContent = me.email || me.name; }).catch(() => {});
load();
