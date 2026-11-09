#!/usr/bin/env bash
# One-time (re-runnable) Azure setup for Harbour.
#
#   az login
#   ./scripts/azure-setup.sh
#
# 1. Deploys infra/main.bicep into the resource group (SQL server + database, App Service).
# 2. Creates the Entra app registration for staff sign-in and turns on App Service Authentication.
# 3. Lets the web app's managed identity send staff invites (Graph User.Invite.All + User.Read.All).
# 4. Copies data/BMSData.accdb into Azure SQL and makes you the first Harbour Admin.
# 5. Gives the web app's managed identity read/write access to the database.
# 6. Deploys the app.
#
# Optional: BUDGET_EMAILS="a@x.org,b@x.org" sets up monthly budget alerts (MONTHLY_BUDGET, default 40 USD).
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-ngatikuri-rg}"
LOCATION="${LOCATION:-newzealandnorth}"
APP_DISPLAY_NAME="${APP_DISPLAY_NAME:-Ngati Kuri Harbour}"
BUDGET_EMAILS="${BUDGET_EMAILS:-}"
MONTHLY_BUDGET="${MONTHLY_BUDGET:-40}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { printf '\n==> %s\n' "$*"; }

say "Signed-in Azure account"
ADMIN_UPN="$(az ad signed-in-user show --query userPrincipalName -o tsv)"
ADMIN_OID="$(az ad signed-in-user show --query id -o tsv)"
az account show --query "{subscription:name, user:user.name}" -o table

az group create -n "$RESOURCE_GROUP" -l "$LOCATION" --tags project=ngatikuri-db -o none

BUDGET_JSON="$(node -e "console.log(JSON.stringify(process.argv[1].split(',').map(s => s.trim()).filter(Boolean)))" "$BUDGET_EMAILS")"
deploy_infra() {
  az deployment group create -g "$RESOURCE_GROUP" -n harbour-infra -f infra/main.bicep \
    -p sqlAdminLogin="$ADMIN_UPN" sqlAdminObjectId="$ADMIN_OID" authClientId="${1:-}" \
       budgetEmails="$BUDGET_JSON" monthlyBudget="$MONTHLY_BUDGET" \
    --query properties.outputs -o json
}

say "Deploying infrastructure (first run takes a few minutes)"
OUTPUTS="$(deploy_infra "")"
out() { node -e "console.log(JSON.parse(process.argv[1])[process.argv[2]].value)" "$OUTPUTS" "$1"; }
WEB_APP="$(out webAppName)"; WEB_URL="$(out webAppUrl)"
SQL_SERVER_NAME="$(out sqlServerName)"; SQL_FQDN="$(out sqlServerFqdn)"; SQL_DB="$(out databaseName)"

say "Entra app registration for staff sign-in"
APP_ID="$(az ad app list --display-name "$APP_DISPLAY_NAME" --query "[0].appId" -o tsv)"
if [ -z "$APP_ID" ]; then
  APP_ID="$(az ad app create --display-name "$APP_DISPLAY_NAME" --sign-in-audience AzureADMyOrg \
    --web-redirect-uris "$WEB_URL/.auth/login/aad/callback" --enable-id-token-issuance true --query appId -o tsv)"
else
  az ad app update --id "$APP_ID" --web-redirect-uris "$WEB_URL/.auth/login/aad/callback" --enable-id-token-issuance true
fi
SP_ID="$(az ad sp show --id "$APP_ID" --query id -o tsv 2>/dev/null || az ad sp create --id "$APP_ID" --query id -o tsv)"
# Anyone in the tenant (including invited guests) can reach Harbour's sign-in; Harbour itself
# only lets in people on its Operators list (app.StaffUsers).
az ad sp update --id "$SP_ID" --set appRoleAssignmentRequired=false

say "Letting the web app send staff invites (Microsoft Graph User.Invite.All, User.Read.All)"
WEB_APP_PRINCIPAL="$(out webAppPrincipalId)"
GRAPH_SP="$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)"
for PERMISSION in User.Invite.All User.Read.All; do
  ROLE_ID="$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query "appRoles[?value=='$PERMISSION'].id | [0]" -o tsv)"
  EXISTS="$(az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/$WEB_APP_PRINCIPAL/appRoleAssignments" \
    --query "length(value[?appRoleId=='$ROLE_ID'])" -o tsv)"
  if [ "$EXISTS" = "0" ]; then
    az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/$WEB_APP_PRINCIPAL/appRoleAssignments" \
      --headers Content-Type=application/json \
      --body "{\"principalId\":\"$WEB_APP_PRINCIPAL\",\"resourceId\":\"$GRAPH_SP\",\"appRoleId\":\"$ROLE_ID\"}" -o none
  fi
done

say "Turning on App Service Authentication"
deploy_infra "$APP_ID" > /dev/null

say "Opening the SQL firewall to this computer for the migration"
MY_IP="$(curl -fsS https://api.ipify.org)"
RULE="setup-$(echo "$MY_IP" | tr . -)"
az sql server firewall-rule create -g "$RESOURCE_GROUP" -s "$SQL_SERVER_NAME" -n "$RULE" \
  --start-ip-address "$MY_IP" --end-ip-address "$MY_IP" -o none
trap 'az sql server firewall-rule delete -g "$RESOURCE_GROUP" -s "$SQL_SERVER_NAME" -n "$RULE" -o none || true' EXIT

export SQL_SERVER="$SQL_FQDN" SQL_DATABASE="$SQL_DB"
say "Copying data/BMSData.accdb into Azure SQL"
npm run --silent migrate

say "Making $ADMIN_UPN the first Harbour Admin"
node scripts/bootstrap-admin.js "$ADMIN_UPN" "$ADMIN_OID" "$(az ad signed-in-user show --query displayName -o tsv)"

say "Granting the web app access to the database"
node scripts/grant-webapp.js "$WEB_APP"

say "Deploying the app"
RESOURCE_GROUP="$RESOURCE_GROUP" WEB_APP="$WEB_APP" ./scripts/deploy.sh

say "Done: $WEB_URL"
