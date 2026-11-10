const $ = (selector) => document.querySelector(selector);

const ROLE_TEXT = {
  Viewer: 'Viewer: can view the database',
  Approver: 'Approver: can view, add people, move applications and deal with member requests',
  Admin: 'Admin: everything, plus inviting operators and managing their access',
};

function when(value) {
  return value ? new Date(value).toLocaleString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}

function row(label, value, className = '') {
  const item = document.createElement('div');
  const name = document.createElement('span'); name.textContent = label;
  const text = document.createElement('strong'); text.textContent = value ?? '—'; if (className) text.className = className;
  item.append(name, text);
  return item;
}

async function load() {
  const response = await fetch('/api/staff/profile', { credentials: 'same-origin' });
  if (response.status === 401) {
    window.location.href = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(window.location.pathname)}`;
    return;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    $('#pageStatus').textContent = data.error || `The server returned ${response.status}.`;
    $('#pageStatus').classList.add('error');
    return;
  }
  const account = data.account;
  $('#profileName').textContent = account?.DisplayName || data.name || 'My profile';
  $('#accountDetails').replaceChildren(
    row('Name', account?.DisplayName || data.name),
    row('Email / sign-in', data.email || account?.Email),
    row('Harbour role', ROLE_TEXT[data.role] ?? data.role),
    row('Status', account ? account.Status.replace(/^./, (c) => c.toUpperCase()) : 'Active'),
    row('Invited', account ? `${when(account.InvitedAt)}${account.InvitedBy ? ` by ${account.InvitedBy}` : ''}` : '—'),
    row('Access started', when(account?.ActivatedAt)));
  $('#securityDetails').replaceChildren(
    row('This sign-in used MFA', data.mfa ? 'Yes' : 'No', data.mfa ? 'good' : 'warn'),
    row('Last sign-in recorded', when(account?.LastSignInAt)),
    row('Signed in with', data.provider === 'aad' ? 'Microsoft work account (Entra ID)' : data.provider));

  if (['Approver', 'Admin'].includes(data.role)) {
    $('#maintenanceNav').hidden = false;
    $('#addPersonLink').hidden = false;
  }
  if (data.role === 'Admin') $('#operatorsLink').hidden = false;
}

load();
