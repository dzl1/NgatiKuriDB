// Profile icon + menu for every Harbour page (public and staff).
// Put <span data-session="dark|light"></span> where it should appear; "dark" for the green public
// header, "light" for the staff app's top bar. Signed out, it shows a "Sign in" link
// (data-signin="member" or "staff" chooses which sign-in; default member).

const STYLE = `
.nk-session{position:relative;display:inline-flex;align-items:center;font-family:inherit}
.nk-signin{color:inherit;text-decoration:none;padding:8px 10px;border-radius:6px}
.nk-signin:hover{background:#ffffff14}
.nk-avatar{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;border:2px solid transparent;font-weight:600;font-size:13px;line-height:1;font-family:inherit;letter-spacing:.02em;cursor:pointer;padding:0}
.nk-session[data-theme=dark] .nk-avatar{background:#b3d78d;color:#032306}
.nk-session[data-theme=dark] .nk-avatar:hover,.nk-session[data-theme=dark] .nk-avatar[aria-expanded=true]{border-color:#e6efdf}
.nk-session[data-theme=light] .nk-avatar{width:30px;height:30px;font-size:11px;background:#285d47;color:#fff}
.nk-session[data-theme=light] .nk-avatar:hover,.nk-session[data-theme=light] .nk-avatar[aria-expanded=true]{border-color:#b9c9b8}
.nk-avatar:focus-visible{outline:3px solid #b3d78d;outline-offset:2px}
.nk-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:50;min-width:250px;max-width:min(320px,calc(100vw - 24px));background:#fff;color:#1d2a1f;border:1px solid #dfe5da;border-radius:10px;box-shadow:0 12px 32px #03230624;padding:6px;text-align:left}
.nk-menu[hidden]{display:none}
.nk-menu-head{padding:10px 10px 12px;border-bottom:1px solid #eef1ea;margin-bottom:4px}
.nk-menu-head strong{display:block;font-size:15px;overflow-wrap:anywhere}
.nk-menu-head span{display:block;font-size:13px;color:#5c675d;overflow-wrap:anywhere;margin-top:2px}
.nk-badge{display:inline-block;font-style:normal;margin-top:8px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:#eef3e8;color:#346431}
.nk-menu a{display:flex;align-items:center;gap:10px;padding:10px;border-radius:6px;color:#1d2a1f;text-decoration:none;font-size:14px}
.nk-menu a:hover,.nk-menu a:focus-visible{background:#eef3e8;outline:none}
.nk-menu a span{width:18px;text-align:center;color:#346431}
.nk-menu .nk-signout{border-top:1px solid #eef1ea;margin-top:4px;border-radius:0 0 6px 6px;color:#7f2619}
.nk-menu .nk-signout span{color:#7f2619}
`;

function initials(name, email) {
  const words = String(name || '').replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return String(email || '?').slice(0, 1).toUpperCase();
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function item(href, icon, text, className = '') {
  return el('a', { href, className, role: 'menuitem' }, el('span', { textContent: icon, ariaHidden: 'true' }), text);
}

function render(mount, session) {
  const theme = mount.dataset.session === 'light' ? 'light' : 'dark';
  const box = el('span', { className: 'nk-session' });
  box.dataset.theme = theme;

  if (!session?.signedIn) {
    const staff = mount.dataset.signin === 'staff';
    box.append(el('a', {
      className: 'nk-signin',
      href: staff ? '/.auth/login/aad?post_login_redirect_uri=/users.html' : '/.auth/login/members?post_login_redirect_uri=/member.html',
      textContent: 'Sign in',
    }));
    mount.replaceChildren(box);
    return;
  }

  const here = window.location.pathname;
  const menuId = `nk-menu-${Math.random().toString(36).slice(2, 8)}`;
  const button = el('button', {
    type: 'button', className: 'nk-avatar', textContent: initials(session.name, session.email),
    title: `Signed in as ${session.email || session.name}`, ariaLabel: `Account menu for ${session.name || session.email}`,
  });
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', menuId);

  const roleText = session.kind === 'member' ? 'Member' : session.role ? `Staff · ${session.role}` : 'Staff (no Harbour access)';
  const links = [
    session.profileUrl && here !== session.profileUrl ? item(session.profileUrl, '👤', 'My profile') : null,
    session.appUrl && !here.startsWith('/users') ? item(session.appUrl, '▤', 'Open Harbour') : null,
    here !== '/' && here !== '/index.html' ? item('/', '⌂', 'Home page') : null,
    item('/.auth/logout?post_logout_redirect_uri=%2F', '⇥', 'Sign out', 'nk-signout'),
  ];
  const menu = el('div', { id: menuId, className: 'nk-menu', hidden: true, role: 'menu' },
    el('div', { className: 'nk-menu-head' },
      el('strong', { textContent: session.name || 'Signed in' }),
      session.email ? el('span', { textContent: session.email }) : null,
      el('em', { className: 'nk-badge', textContent: roleText })),
    ...links);

  const open = (focusFirst) => {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    if (focusFirst) menu.querySelector('a')?.focus();
  };
  const close = (focusButton) => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  };
  button.addEventListener('click', () => (menu.hidden ? open(false) : close(false)));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(true); }
  });
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('a')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
    if (event.key === 'Tab') close(false);
  });
  document.addEventListener('click', (event) => { if (!box.contains(event.target)) close(false); });

  box.append(button, menu);
  mount.replaceChildren(box);
}

async function init() {
  const mounts = document.querySelectorAll('[data-session]');
  if (!mounts.length) return;
  if (!document.getElementById('nk-session-style')) document.head.append(el('style', { id: 'nk-session-style', textContent: STYLE }));
  let session = null;
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    if (response.ok) session = await response.json();
  } catch {
    session = null;
  }
  mounts.forEach((mount) => render(mount, session));
  document.dispatchEvent(new CustomEvent('harbour:session', { detail: session }));
}

init();
