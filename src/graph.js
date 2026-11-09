// Microsoft Graph calls for staff invites, made as the web app's managed identity (on App Service)
// or the Azure CLI account (locally). The identity needs two Graph application permissions:
//   User.Read.All   – find whether the email already has an account in the tenant
//   User.Invite.All – invite people from outside the organisation as guests
// It cannot change roles, groups or other apps, and needs no secrets.

import { DefaultAzureCredential } from '@azure/identity';

const credential = new DefaultAzureCredential();
const GRAPH = 'https://graph.microsoft.com/v1.0';

async function graph(method, path, body) {
  const { token } = await credential.getToken('https://graph.microsoft.com/.default');
  const response = await fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `Microsoft Graph returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function odataString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Finds an existing user (member or guest) in the tenant by email. */
export async function findUserByEmail(email) {
  const value = odataString(email);
  const result = await graph('GET', `/users?$select=id,displayName,mail,userPrincipalName,userType&$filter=mail eq ${value} or userPrincipalName eq ${value}`);
  return result.value?.[0] ?? null;
}

/**
 * Makes sure `email` can sign in to Harbour and tells them about it.
 * - Someone already in the organisation: nothing to create; returns { objectId, emailed: false }.
 * - Anyone else (or an existing guest): Microsoft sends an invitation email; returns { objectId, emailed: true }.
 */
export async function inviteToTenant({ email, displayName, redirectUrl, invitedByName }) {
  const existing = await findUserByEmail(email);
  if (existing && existing.userType === 'Member') {
    return { objectId: existing.id, emailed: false, displayName: existing.displayName };
  }
  const invitation = await graph('POST', '/invitations', {
    invitedUserEmailAddress: email,
    invitedUserDisplayName: displayName || undefined,
    inviteRedirectUrl: redirectUrl,
    sendInvitationMessage: true,
    invitedUserMessageInfo: {
      customizedMessageBody: `${invitedByName} has invited you to Harbour, the Ngāti Kuri beneficiary database. Accept this invitation, then set up multi-factor authentication when asked.`,
    },
  });
  return { objectId: invitation.invitedUser.id, emailed: true, displayName: displayName || existing?.displayName };
}
