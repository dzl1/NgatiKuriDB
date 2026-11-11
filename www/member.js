const $ = (selector) => document.querySelector(selector);
const LOGIN = '/.auth/login/members?post_login_redirect_uri=/member.html';
let state = null;

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', 'X-Harbour': '1' } : { 'X-Harbour': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Something went wrong (${response.status}). Please try again.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function message(text, isError = false) {
  const node = $('#message');
  node.textContent = text;
  node.classList.toggle('error', isError);
  if (text) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setHeading(title, lead) {
  $('#title').textContent = title;
  $('#lead').textContent = lead;
}

function display(field, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'choice') return field.options.find(([key]) => key === value)?.[1] ?? value;
  if (field.type === 'date') {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  return value;
}

function when(value) {
  return new Date(value).toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Builds an input for a field definition from the server. */
function input(field, value, { readOnly = false } = {}) {
  const id = `f_${field.name}`;
  let control;
  if (field.type === 'choice') {
    control = el('select', { id, name: field.name }, ...field.options.map(([key, label]) => el('option', { value: key, textContent: label, selected: (value ?? field.options[0][0]) === key })));
  } else if (field.type === 'long') {
    control = el('textarea', { id, name: field.name, maxLength: field.max, value: value ?? '' });
  } else {
    control = el('input', {
      id, name: field.name, value: value ?? '', readOnly,
      type: field.type === 'date' ? 'date' : field.type === 'email' ? 'email' : field.name.match(/Phone|Mobile/) ? 'tel' : 'text',
      autocomplete: { FirstName: 'given-name', MiddleNames: 'additional-name', LastName: 'family-name', DOB: 'bday', Email: 'email', Mobile: 'tel', PhoneNumber: 'tel', Address0: 'address-line1', Address1: 'address-line2', Address2: 'address-level2', Address3: 'country-name' }[field.name] || 'off',
    });
    if (field.max) control.maxLength = field.max;
    if (field.type === 'date') control.max = new Date().toISOString().slice(0, 10);
  }
  if (field.required) control.required = true;
  const wide = field.type === 'long' || field.name === 'Address0';
  return el('div', { className: `field${wide ? ' wide' : ''}` },
    el('label', { htmlFor: id, textContent: `${field.label}${field.required ? ' *' : ''}` }),
    control);
}

function formValues(form, fields) {
  const values = {};
  for (const field of fields) {
    const control = form.elements.namedItem(field.name);
    if (control) values[field.name] = control.value.trim();
  }
  return values;
}

// ---- Screens ----

function signedOut() {
  setHeading('Sign in to the iwi register', 'Create an account or sign in with your email address to register or to see your details.');
  $('#content').replaceChildren(el('div', { className: 'panel' },
    el('h2', { textContent: 'New here, or already registered?' }),
    el('p', { textContent: 'Use the same button either way. If you do not have an account yet, choose “Sign up” on the next screen. We will email you a code to confirm your address.' }),
    el('div', { className: 'form-actions' }, el('a', { className: 'button button-green', href: LOGIN, textContent: 'Register or sign in' }))));
}

function registrationForm(previous, { editing = false } = {}) {
  if (editing) setHeading('Change my registration', 'Update anything that needs fixing. Fields marked * are needed. Our team has not checked it yet, so your changes replace what you sent.');
  else setHeading('Register with Ngāti Kuri', 'Tell us about yourself and your whakapapa. Fields marked * are needed.');
  const prefill = { FirstName: state.givenName, LastName: state.familyName, Email: state.email, ...(previous ?? {}) };
  const form = el('form', { className: 'panel', noValidate: true },
    el('h2', { textContent: 'About you' }),
    el('div', { className: 'form-grid' }, ...state.fields.map((field) => input(field, prefill[field.name]))),
    el('h2', { textContent: 'Your whakapapa', style: 'margin-top:28px' }),
    el('p', { textContent: 'This helps us confirm your connection to Ngāti Kuri and find you if you are already on the register.' }),
    el('div', { className: 'form-grid' }, ...state.extra.map((field) => input(field, prefill[field.name]))),
    el('label', { className: 'consent' },
      el('input', { type: 'checkbox', name: 'Consent', required: true }),
      el('span', { textContent: 'I confirm these details are true, and I agree to the Ngāti Kuri Trust Board holding them for the iwi register and contacting me about iwi matters.' })),
    el('div', { className: 'form-actions' },
      el('button', { className: 'button button-green', type: 'submit', textContent: editing ? 'Save my changes' : 'Send my registration' }),
      editing ? el('button', { className: 'button button-quiet', type: 'button', textContent: 'Cancel', onclick: () => { message(''); pending(); } }) : null));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const missing = [...form.querySelectorAll('[required]')].find((control) => (control.type === 'checkbox' ? !control.checked : !control.value.trim()));
    if (missing) {
      message(missing.type === 'checkbox' ? 'Please tick the box to agree to how your information is used.' : `Please fill in “${form.querySelector(`label[for="${missing.id}"]`)?.textContent.replace(' *', '')}”.`, true);
      missing.focus();
      return;
    }
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await api(editing ? 'PUT' : 'POST', '/api/member/registration', { ...formValues(form, [...state.fields, ...state.extra]), Consent: form.elements.namedItem('Consent').checked });
      message(editing ? 'Thank you. Your registration has been updated.' : 'Thank you. We have your registration.');
      await load();
    } catch (error) {
      message(error.message, true);
      button.disabled = false;
    }
  });
  $('#content').replaceChildren(form);
}

function pending() {
  setHeading('Thank you, we have your registration', `Sent ${when(state.submittedAt)}. Our team is checking your details against the register. Sign in again later to see when it is done.`);
  $('#content').replaceChildren(el('div', { className: 'panel' },
    el('h2', { textContent: 'What happens next' }),
    el('p', { textContent: 'If you are already on the register, we link your account to your existing record. If you are not, we add you. Once that is done you can see your details here and ask for changes.' }),
    el('p', { textContent: 'Need to change something you sent? You can until our team has checked it.' }),
    el('div', { className: 'form-actions' }, el('button', { className: 'button button-green', type: 'button', textContent: 'Change my registration', onclick: () => { message(''); registrationForm(state.details, { editing: true }); } }))));
}

function rejected() {
  setHeading('We need more information', 'We could not confirm your registration yet.');
  message(state.reviewNote ? `Note from our team: ${state.reviewNote}` : 'Please check your details and send them again, or contact us.', true);
  registrationForm(state.details);
  $('#title').textContent = 'Please check your registration';
}

function linked() {
  const { applicant } = state;
  setHeading(`Kia ora, ${applicant.values.FirstName || 'e hoa'}`, 'These are your details on the Ngāti Kuri register.');
  const details = el('div', { className: 'panel' },
    el('div', { className: 'portal-bar' }, el('h2', { textContent: 'My details' }), applicant.status ? el('span', { className: 'status-pill', textContent: applicant.status }) : null),
    el('div', { className: 'details-list' }, ...state.fields.map((field) => el('div', {}, el('span', { textContent: field.label }), el('strong', { textContent: display(field, applicant.values[field.name]) })))),
    el('div', { className: 'form-actions' }, el('button', { className: 'button button-green', type: 'button', textContent: 'Ask to change my details', onclick: () => changeForm() })));
  $('#content').replaceChildren(details, history());
}

function changeForm() {
  const { applicant } = state;
  const form = el('form', { className: 'panel', noValidate: true },
    el('h2', { textContent: 'Ask to change my details' }),
    el('p', { textContent: 'Change what needs updating. Our team checks every change before it is saved to the register.' }),
    el('div', { className: 'form-grid' }, ...state.fields.map((field) => input(field, applicant.values[field.name]))),
    el('div', { className: 'field', style: 'margin-top:16px' },
      el('label', { htmlFor: 'changeNote', textContent: 'Note for our team (optional)' }),
      el('textarea', { id: 'changeNote', name: 'note', maxLength: 1000 })),
    el('div', { className: 'form-actions' },
      el('button', { className: 'button button-green', type: 'submit', textContent: 'Send for checking' }),
      el('button', { className: 'button button-quiet', type: 'button', textContent: 'Cancel', onclick: () => { message(''); linked(); } })));

  form.addEventListener('input', (event) => {
    const field = state.fields.find((item) => item.name === event.target.name);
    if (field) event.target.classList.toggle('changed', (event.target.value.trim() || null) !== (applicant.values[field.name] ?? null));
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = formValues(form, state.fields);
    const changes = Object.fromEntries(Object.entries(values).filter(([name, value]) => (value || null) !== (applicant.values[name] ?? null)));
    if (!Object.keys(changes).length) { message('You have not changed anything yet.', true); return; }
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await api('POST', '/api/member/changes', { changes, note: form.elements.namedItem('note').value });
      message('Thank you. Your change has been sent to our team to check.');
      await load();
    } catch (error) {
      message(error.message, true);
      button.disabled = false;
    }
  });
  $('#content').replaceChildren(form);
  form.querySelector('input,select')?.focus();
}

function history() {
  const labels = Object.fromEntries(state.fields.map((field) => [field.name, field]));
  const statusText = { pending: 'Waiting for review', approved: 'Approved', rejected: 'Not approved', withdrawn: 'Withdrawn' };
  return el('div', { className: 'panel' },
    el('h2', { textContent: 'My change requests' }),
    state.requests.length
      ? el('ul', { className: 'history' }, ...state.requests.map((request) => el('li', {},
        el('div', { className: 'meta' }, el('span', { textContent: `Sent ${when(request.SubmittedAt)}` }), el('span', { className: `status-pill ${request.Status}`, textContent: statusText[request.Status] ?? request.Status })),
        el('ul', {}, ...Object.entries(request.Changes).map(([name, change]) => el('li', { textContent: `${labels[name]?.label ?? name}: ${display(labels[name] ?? {}, change.to)}` }))),
        request.ReviewNote ? el('p', { className: 'note', textContent: `Note from our team: ${request.ReviewNote}` }) : null,
        request.Status === 'pending' ? el('button', { className: 'link-button', type: 'button', textContent: 'Withdraw this request', onclick: () => withdraw(request.ChangeRequestId) }) : null)))
      : el('p', { textContent: 'You have not asked for any changes yet.' }));
}

async function withdraw(id) {
  if (!window.confirm('Withdraw this change request?')) return;
  try {
    await api('POST', `/api/member/changes/${id}/withdraw`);
    message('Your request has been withdrawn.');
    await load();
  } catch (error) {
    message(error.message, true);
  }
}

function disabled() {
  setHeading('Your account is not active', 'Please contact us at enquiries@ngatikuri.iwi.nz.');
  $('#content').replaceChildren();
}

async function load() {
  try {
    state = await api('GET', '/api/member/me');
  } catch (error) {
    if (error.status === 401) { signedOut(); return; }
    setHeading('Something went wrong', '');
    message(error.message, true);
    return;
  }
  $('#signedInAs').textContent = state.email ? `Signed in as ${state.email}` : '';
  ({ new: () => registrationForm(), pending, rejected, linked, disabled })[state.state]?.();
}

load();
