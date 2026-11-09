// Harbour on Azure: Azure SQL (Basic) + App Service (Linux, Node), New Zealand North.
// Deploy with scripts/azure-setup.sh, which also creates the Entra app registration.

@description('Azure region. New Zealand North keeps the data in Aotearoa.')
param location string = resourceGroup().location

@description('Short prefix for resource names.')
param prefix string = 'ngatikuri'

@description('Entra user who administers the SQL server (sign-in name).')
param sqlAdminLogin string

@description('Object ID of that Entra user.')
param sqlAdminObjectId string

@description('Client ID of the Entra app registration used for staff sign-in. Leave empty on the first deployment.')
param authClientId string = ''

@description('Refuse staff sessions that did not use multi-factor authentication. Turn on once MFA is enforced in the tenant.')
param requireStaffMfa bool = false

@description('Monthly budget for this resource group, in the billing currency (USD for sponsorship credits).')
param monthlyBudget int = 40

@description('Emails for budget alerts at 80% and 100%. Leave empty to skip the budget.')
param budgetEmails array = []

@description('First day of the current month; the budget starts here.')
param budgetStartDate string = utcNow('yyyy-MM-01')

var suffix = take(uniqueString(resourceGroup().id), 6)
var sqlServerName = '${prefix}-sql-${suffix}'
var databaseName = 'harbour'
var webAppName = '${prefix}-harbour-${suffix}'
var tenantId = subscription().tenantId
var tags = { project: 'ngatikuri-db' }

resource sqlServer 'Microsoft.Sql/servers@2023-08-01' = {
  name: sqlServerName
  location: location
  tags: tags
  properties: {
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    administrators: {
      administratorType: 'ActiveDirectory'
      azureADOnlyAuthentication: true // no SQL passwords at all
      login: sqlAdminLogin
      sid: sqlAdminObjectId
      tenantId: tenantId
      principalType: 'User'
    }
  }
}

// Lets the web app reach the server. Every connection still needs an Entra identity with access to the database.
resource allowAzureServices 'Microsoft.Sql/servers/firewallRules@2023-08-01' = {
  parent: sqlServer
  name: 'AllowAllWindowsAzureIps'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource database 'Microsoft.Sql/servers/databases@2023-08-01' = {
  parent: sqlServer
  name: databaseName
  location: location
  tags: tags
  // Basic (5 DTU, 2 GB): always on, fixed price, ample for this database (~15 MB). Scale to S0 in the portal if it feels slow.
  sku: { name: 'Basic', tier: 'Basic', capacity: 5 }
  properties: {
    maxSizeBytes: 2147483648 // 2 GB
    requestedBackupStorageRedundancy: 'Local' // backups stay in New Zealand North
    zoneRedundant: false
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${prefix}-plan-${suffix}'
  location: location
  tags: tags
  kind: 'linux'
  sku: { name: 'B1', tier: 'Basic' }
  properties: { reserved: true }
}

resource webApp 'Microsoft.Web/sites@2024-04-01' = {
  name: webAppName
  location: location
  tags: tags
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'npm start'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      healthCheckPath: '/healthz'
      appSettings: [
        { name: 'SQL_SERVER', value: sqlServer.properties.fullyQualifiedDomainName }
        { name: 'SQL_DATABASE', value: databaseName }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'WEB_URL', value: 'https://${prefix}-harbour-${suffix}.azurewebsites.net' }
        { name: 'REQUIRE_STAFF_MFA', value: string(requireStaffMfa) }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
      ]
    }
  }
}

resource ftpCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: webApp
  name: 'ftp'
  properties: { allow: false }
}

// Staff sign-in with Microsoft Entra ID (App Service Authentication). The app itself decides
// which pages need which role, so unauthenticated requests are passed through to it.
resource auth 'Microsoft.Web/sites/config@2024-04-01' = if (!empty(authClientId)) {
  parent: webApp
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      requireAuthentication: false
      unauthenticatedClientAction: 'AllowAnonymous'
    }
    httpSettings: { requireHttps: true }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authClientId
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [ authClientId, 'api://${authClientId}' ]
        }
      }
    }
    login: {
      tokenStore: { enabled: false }
    }
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = if (!empty(budgetEmails)) {
  name: 'harbour-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      actual80: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 80, thresholdType: 'Actual', contactEmails: budgetEmails }
      actual100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Actual', contactEmails: budgetEmails }
      forecast100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Forecasted', contactEmails: budgetEmails }
    }
  }
}

output webAppName string = webApp.name
output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output webAppPrincipalId string = webApp.identity.principalId
output sqlServerName string = sqlServer.name
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
output databaseName string = databaseName
