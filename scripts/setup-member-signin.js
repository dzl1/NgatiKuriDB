// Configures member sign-in in the Entra External ID tenant (re-runnable):
//   1. App registration "Ngati Kuri Member Portal" with the Harbour callback URL and the email/name claims
//   2. Admin consent for openid/profile/email
//   3. Self-service sign-up flow: email + password, collecting first and last name
//   4. Conditional Access: every member sign-in needs a second factor (an emailed one-time code)
//   5. Sign-in page colours
//   6. A client secret, stored only in Key Vault (created on first run, or with --rotate-secret)
//
//   node scripts/setup-member-signin.js <members-tenant-id> <web-url> <key-vault-name> [--rotate-secret]
// Prints the member app's client ID for infra/main.bicep (memberAuthClientId).
//
// Runs as the account signed in to the Azure CLI, which must be an administrator of the members tenant.

import { execFileSync } from 'node:child_process';

const [tenantId, webUrl, keyVaultName] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const rotateSecret = process.argv.includes('--rotate-secret');
if (!tenantId || !webUrl || !keyVaultName) {
  console.error('Usage: node scripts/setup-member-signin.js <members-tenant-id> <web-url> <key-vault-name> [--rotate-secret]');
  process.exit(1);
}

const APP_NAME = 'Ngati Kuri Member Portal';
const FLOW_NAME = 'Ngati Kuri members sign up and sign in';
const POLICY_NAME = 'Members must use MFA';
const SECRET_NAME = 'members-client-secret';
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const SCOPES = { openid: '37f7f235-527c-4136-accd-4a02d197296e', profile: '14dad69e-099b-42c9-810b-d002981feec1', email: '64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0', offline_access: '7427e0e9-2fba-42fe-b0c0-848c9e6a8182' };

const az = (...args) => execFileSync('az', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const token = az('account', 'get-access-token', '--tenant', tenantId, '--resource-type', 'ms-graph', '--query', 'accessToken', '-o', 'tsv');

async function graph(method, path, body, { version = 'v1.0', allow404 = false, headers = {} } = {}) {
  const response = await fetch(`https://graph.microsoft.com/${version}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (allow404 && response.status === 404) return null;
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${data.error?.message ?? text}`);
  return data;
}
const filter = (expression) => `$filter=${encodeURIComponent(expression)}`;
const step = (message) => console.log(`==> ${message}`);

// 1. App registration
step('Member sign-in app registration');
const appBody = {
  displayName: APP_NAME,
  signInAudience: 'AzureADMyOrg',
  web: { redirectUris: [`${webUrl}/.auth/login/members/callback`], implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false } },
  optionalClaims: { idToken: ['email', 'given_name', 'family_name'].map((name) => ({ name, essential: false })) },
  requiredResourceAccess: [{ resourceAppId: GRAPH_APP_ID, resourceAccess: Object.values(SCOPES).map((id) => ({ id, type: 'Scope' })) }],
};
let app = (await graph('GET', `/applications?${filter(`displayName eq '${APP_NAME}'`)}`)).value[0];
if (app) await graph('PATCH', `/applications/${app.id}`, appBody);
else app = await graph('POST', '/applications', appBody);
console.log(`    client ID ${app.appId}`);

let sp = (await graph('GET', `/servicePrincipals?${filter(`appId eq '${app.appId}'`)}`)).value[0];
if (!sp) sp = await graph('POST', '/servicePrincipals', { appId: app.appId });

// 2. Admin consent for the sign-in scopes
step('Admin consent for openid, profile, email');
let graphSp = (await graph('GET', `/servicePrincipals?${filter(`appId eq '${GRAPH_APP_ID}'`)}`)).value[0];
if (!graphSp) graphSp = await graph('POST', '/servicePrincipals', { appId: GRAPH_APP_ID });
const scope = Object.keys(SCOPES).join(' ');
const grant = (await graph('GET', `/oauth2PermissionGrants?${filter(`clientId eq '${sp.id}' and resourceId eq '${graphSp.id}'`)}`)).value[0];
if (grant) await graph('PATCH', `/oauth2PermissionGrants/${grant.id}`, { scope });
else await graph('POST', '/oauth2PermissionGrants', { clientId: sp.id, consentType: 'AllPrincipals', resourceId: graphSp.id, scope });

// 3. Sign-up / sign-in user flow
step('Self-service sign-up flow (email + password, first and last name)');
const flows = (await graph('GET', '/identity/authenticationEventsFlows')).value;
let flow = flows.find((item) => item.displayName === FLOW_NAME);
if (!flow) {
  const input = (attribute, label, hidden = false) => ({
    attribute, label, inputType: 'text', hidden, editable: !hidden, writeToDirectory: true, required: true, validationRegEx: '^.*', options: [], defaultValue: null,
  });
  flow = await graph('POST', '/identity/authenticationEventsFlows', {
    '@odata.type': '#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow',
    displayName: FLOW_NAME,
    description: 'Members of the Ngāti Kuri iwi register',
    onInteractiveAuthFlowStart: { '@odata.type': '#microsoft.graph.onInteractiveAuthFlowStartExternalUsersSelfServiceSignUp', isSignUpAllowed: true },
    onAuthenticationMethodLoadStart: { '@odata.type': '#microsoft.graph.onAuthenticationMethodLoadStartExternalUsersSelfServiceSignUp', identityProviders: [{ id: 'EmailPassword-OAUTH' }] },
    onAttributeCollection: {
      '@odata.type': '#microsoft.graph.onAttributeCollectionExternalUsersSelfServiceSignUp',
      attributes: [{ id: 'email' }, { id: 'givenName' }, { id: 'surname' }],
      attributeCollectionPage: {
        views: [{ inputs: [
          { ...input('email', 'Email address', true), validationRegEx: "^[a-zA-Z0-9.!#$%&’'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*$" },
          input('givenName', 'First name'),
          input('surname', 'Last name'),
        ] }],
      },
    },
  });
}
const linked = (await graph('GET', `/identity/authenticationEventsFlows/${flow.id}/conditions/applications/includeApplications`)).value;
if (!linked.some((item) => item.appId === app.appId)) {
  await graph('POST', `/identity/authenticationEventsFlows/${flow.id}/conditions/applications/includeApplications`, {
    '@odata.type': '#microsoft.graph.authenticationConditionApplication', appId: app.appId,
  });
}

// 4. MFA: emailed one-time code as the second factor, required for every member sign-in.
step('MFA for members (emailed one-time code)');
// The Azure CLI may not be allowed to change these policies; if so, print the portal steps instead.
let mfaManual = false;
try {
  await graph('PATCH', '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/Email', {
    '@odata.type': '#microsoft.graph.emailAuthenticationMethodConfiguration', state: 'enabled',
    includeTargets: [{ targetType: 'group', id: 'all_users', isRegistrationRequired: false }],
  });
} catch (error) {
  console.warn(`    could not confirm the email one-time code method (${error.message.split(':').pop().trim()})`);
  mfaManual = true;
}
try {
  const policies = (await graph('GET', '/identity/conditionalAccess/policies')).value;
  const policyBody = {
    displayName: POLICY_NAME,
    state: 'enabled',
    conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: [app.appId] }, clientAppTypes: ['all'] },
    grantControls: { operator: 'OR', builtInControls: ['mfa'] },
  };
  const policy = policies.find((item) => item.displayName === POLICY_NAME);
  if (policy) await graph('PATCH', `/identity/conditionalAccess/policies/${policy.id}`, policyBody);
  else await graph('POST', '/identity/conditionalAccess/policies', policyBody);
  console.log(`    Conditional Access policy "${POLICY_NAME}" is on`);
} catch (error) {
  console.warn(`    could not create the Conditional Access policy (${error.message.split(':').pop().trim()})`);
  mfaManual = true;
}
if (mfaManual) {
  console.warn(`    Finish MFA in the Entra admin centre, signed in to the members tenant (${tenantId}):
      a. Entra ID → Authentication methods → Policies → Email OTP → Enable, target All users
      b. Entra ID → Conditional Access → New policy "${POLICY_NAME}": Users = All users;
         Target resources = "${APP_NAME}"; Grant = Require multifactor authentication; Enable policy = On`);
}

// 5. Sign-in page look
step('Sign-in page colours');
try {
  const org = (await graph('GET', '/organization')).value[0];
  const branding = { backgroundColor: '#032306', signInPageText: 'Ngāti Kuri Iwi Register', usernameHintText: 'Email address' };
  // 'Accept-Language: 0' addresses the default (all languages) branding.
  await graph('PATCH', `/organization/${org.id}/branding`, branding, { headers: { 'Accept-Language': '0' } });
} catch (error) {
  console.warn(`    (skipped: ${error.message})`);
}

// 6. Client secret → Key Vault
step('Client secret');
let hasSecret = true;
try { az('keyvault', 'secret', 'show', '--vault-name', keyVaultName, '--name', SECRET_NAME, '--query', 'id', '-o', 'tsv'); } catch { hasSecret = false; }
if (!hasSecret || rotateSecret) {
  const expires = new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const password = await graph('POST', `/applications/${app.id}/addPassword`, { passwordCredential: { displayName: 'App Service Authentication', endDateTime: expires } });
  execFileSync('az', ['keyvault', 'secret', 'set', '--vault-name', keyVaultName, '--name', SECRET_NAME, '--file', '/dev/stdin', '--expires', expires, '-o', 'none'], { input: password.secretText });
  console.log(`    new secret stored in Key Vault ${keyVaultName} (expires ${expires.slice(0, 10)})`);
  // Remove older secrets (including any from a run that failed before saving to Key Vault).
  // The web app picks up the new value from Key Vault when it restarts.
  const current = await graph('GET', `/applications/${app.id}?$select=passwordCredentials`);
  for (const credential of current.passwordCredentials.filter((item) => item.keyId !== password.keyId)) {
    await graph('POST', `/applications/${app.id}/removePassword`, { keyId: credential.keyId });
    console.log(`    removed old secret ${credential.hint}…`);
  }
} else {
  console.log(`    already in Key Vault ${keyVaultName}`);
}

console.log(`\nmemberAuthClientId=${app.appId}`);
