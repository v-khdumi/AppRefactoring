targetScope = 'resourceGroup'

@description('Immutable web container image tag or digest.')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'
@description('Immutable worker container image tag or digest.')
param workerImage string = 'mcr.microsoft.com/k8se/quickstart:latest'
@description('Immutable outbox container image tag or digest.')
param outboxImage string = workerImage
param location string = resourceGroup().location
@minLength(3)
param environmentName string = 'prod'
@secure()
param postgresAdminPassword string
@secure()
param foundryApiKey string
param foundryEndpoint string
param foundryModel string = 'gpt-6-astra'
param entraTenantId string
param entraClientId string
param githubAppId string
@secure()
param githubAppPrivateKey string
@secure()
param githubWebhookSecret string
@secure()
param healthCheckToken string
@description('Operations mailbox that receives production alerts.')
param operationsEmail string
@description('PostgreSQL compute SKU. Validate regional capacity before deployment.')
param postgresSkuName string = 'Standard_D2s_v3'
@allowed([
  'SameZone'
  'ZoneRedundant'
])
param postgresHighAvailability string = 'ZoneRedundant'
@allowed([
  'Enabled'
  'Disabled'
])
param postgresGeoRedundantBackup string = 'Enabled'

var suffix = take(uniqueString(subscription().id, resourceGroup().id, environmentName), 6)
var prefix = 'modernize-${environmentName}-${suffix}'
var databaseConnection = 'postgresql://modernizeadmin:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/modernize?sslmode=require'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-id'
  location: location
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  #disable-next-line BCP334
  name: take(replace('${prefix}acr', '-', ''), 50)
  location: location
  sku: {
    name: 'Premium'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    zoneRedundancy: 'Enabled'
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: {
    retentionInDays: 90
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-appi'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('${prefix}-kv', 24)
  location: location
  properties: {
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enablePurgeProtection: true
    enableSoftDelete: true
    publicNetworkAccess: 'Enabled'
    sku: {
      family: 'A'
      name: 'standard'
    }
  }
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: ['10.42.0.0/16']
    }
  }
}

resource containerSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: network
  name: 'container-apps'
  properties: {
    addressPrefix: '10.42.0.0/23'
    delegations: [
      {
        name: 'container-apps-delegation'
        properties: {
          serviceName: 'Microsoft.App/environments'
        }
      }
    ]
  }
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: network
  name: 'postgresql'
  properties: {
    addressPrefix: '10.42.2.0/28'
    delegations: [
      {
        name: 'postgres-flexible-delegation'
        properties: {
          serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
        }
      }
    ]
  }
}

resource postgresPrivateDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.postgres.database.azure.com'
  location: 'global'
}

resource postgresPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresPrivateDns
  name: '${prefix}-postgres-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: network.id
    }
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: '${prefix}-pg'
  location: location
  sku: {
    name: postgresSkuName
    tier: 'GeneralPurpose'
  }
  properties: {
    administratorLogin: 'modernizeadmin'
    administratorLoginPassword: postgresAdminPassword
    version: '16'
    storage: {
      storageSizeGB: 128
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 35
      geoRedundantBackup: postgresGeoRedundantBackup
    }
    highAvailability: {
      mode: postgresHighAvailability
    }
    network: {
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: postgresPrivateDns.id
    }
  }
  dependsOn: [postgresPrivateDnsLink]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgres
  name: 'modernize'
  properties: {}
}

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-url'
  properties: {
    value: databaseConnection
  }
}

resource foundryKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'foundry-api-key'
  properties: {
    value: foundryApiKey
  }
}

resource githubPrivateKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'github-app-private-key'
  properties: {
    value: githubAppPrivateKey
  }
}

resource githubWebhookSecretResource 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'github-webhook-secret'
  properties: {
    value: githubWebhookSecret
  }
}

resource healthCheckTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'health-check-token'
  properties: {
    value: healthCheckToken
  }
}

resource serviceBus 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: '${prefix}-sb'
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
  }
}

resource queue 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = {
  parent: serviceBus
  name: 'modernization-runs'
  properties: {
    lockDuration: 'PT5M'
    maxDeliveryCount: 5
    deadLetteringOnMessageExpiration: true
    defaultMessageTimeToLive: 'P7D'
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'PT10M'
  }
}

resource serviceBusDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(serviceBus.id, identity.id, 'service-bus-data-owner')
  scope: serviceBus
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '090c5cfd-751d-490a-894a-3ce6f1109419')
  }
}

resource vaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, 'key-vault-secrets-user')
  scope: vault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'acr-pull')
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${prefix}-operations'
  location: 'global'
  properties: {
    groupShortName: 'modernize'
    enabled: true
    emailReceivers: [
      {
        name: 'operations'
        emailAddress: operationsEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource deadLetterAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-dead-letter'
  location: 'global'
  properties: {
    description: 'Modernization messages entered the dead-letter queue.'
    severity: 1
    enabled: true
    scopes: [serviceBus.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'dead-letter-count'
          metricNamespace: 'Microsoft.ServiceBus/namespaces'
          metricName: 'DeadletteredMessages'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Maximum'
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'EntityName'
              operator: 'Include'
              values: [queue.name]
            }
          ]
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
  }
}

resource queueBacklogAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-queue-backlog'
  location: 'global'
  properties: {
    description: 'Modernization queue backlog requires operational attention.'
    severity: 2
    enabled: true
    scopes: [serviceBus.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'active-message-count'
          metricNamespace: 'Microsoft.ServiceBus/namespaces'
          metricName: 'ActiveMessages'
          operator: 'GreaterThan'
          threshold: 10
          timeAggregation: 'Maximum'
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'EntityName'
              operator: 'Include'
              values: [queue.name]
            }
          ]
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-cae'
  location: location
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: containerSubnet.id
      internal: false
    }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var registryConfiguration = [
  {
    server: registry.properties.loginServer
    identity: identity.id
  }
]
var databaseSecretReference = {
  name: 'database-url'
  keyVaultUrl: databaseUrlSecret.properties.secretUriWithVersion
  identity: identity.id
}
var githubSecretReference = {
  name: 'github-key'
  keyVaultUrl: githubPrivateKeySecret.properties.secretUriWithVersion
  identity: identity.id
}

resource migrationJob 'Microsoft.App/jobs@2024-03-01' = {
  name: '${prefix}-migrate'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: registryConfiguration
      secrets: [databaseSecretReference]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: workerImage
          command: ['node', 'scripts/migrate.mjs']
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
          ]
        }
      ]
    }
  }
  dependsOn: [
    vaultSecretsUser
    acrPull
  ]
}

resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: '${prefix}-web'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registryConfiguration
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        databaseSecretReference
        {
          name: 'foundry-key'
          keyVaultUrl: foundryKeySecret.properties.secretUriWithVersion
          identity: identity.id
        }
        githubSecretReference
        {
          name: 'github-webhook'
          keyVaultUrl: githubWebhookSecretResource.properties.secretUriWithVersion
          identity: identity.id
        }
        {
          name: 'health-token'
          keyVaultUrl: healthCheckTokenSecret.properties.secretUriWithVersion
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DEMO_MODE', value: 'false' }
            { name: 'SERVICE_NAME', value: 'modernize-web' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'AZURE_SERVICE_BUS_NAMESPACE', value: '${serviceBus.name}.servicebus.windows.net' }
            { name: 'AZURE_SERVICE_BUS_QUEUE', value: queue.name }
            { name: 'AZURE_AI_FOUNDRY_ENDPOINT', value: foundryEndpoint }
            { name: 'AZURE_AI_FOUNDRY_API_KEY', secretRef: 'foundry-key' }
            { name: 'AZURE_AI_FOUNDRY_MODEL', value: foundryModel }
            { name: 'AZURE_TENANT_ID', value: entraTenantId }
            { name: 'AZURE_CLIENT_ID', value: entraClientId }
            { name: 'NEXT_PUBLIC_AZURE_TENANT_ID', value: entraTenantId }
            { name: 'NEXT_PUBLIC_AZURE_CLIENT_ID', value: entraClientId }
            { name: 'GITHUB_APP_ID', value: githubAppId }
            { name: 'GITHUB_APP_PRIVATE_KEY', secretRef: 'github-key' }
            { name: 'GITHUB_WEBHOOK_SECRET', secretRef: 'github-webhook' }
            { name: 'HEALTH_CHECK_TOKEN', secretRef: 'health-token' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
            { name: 'KEY_VAULT_URL', value: vault.properties.vaultUri }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/api/health', port: 3000 }, initialDelaySeconds: 20, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/api/health', port: 3000 }, initialDelaySeconds: 5, periodSeconds: 10 }
          ]
        }
      ]
      scale: {
        minReplicas: 2
        maxReplicas: 10
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '50' } } }
        ]
      }
    }
  }
  dependsOn: [
    vaultSecretsUser
    acrPull
  ]
}

resource transformationWorker 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: '${prefix}-worker'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registryConfiguration
      secrets: [
        databaseSecretReference
        {
          name: 'foundry-key'
          keyVaultUrl: foundryKeySecret.properties.secretUriWithVersion
          identity: identity.id
        }
        githubSecretReference
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: workerImage
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DEMO_MODE', value: 'false' }
            { name: 'SERVICE_NAME', value: 'modernize-worker' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'AZURE_SERVICE_BUS_NAMESPACE', value: '${serviceBus.name}.servicebus.windows.net' }
            { name: 'AZURE_SERVICE_BUS_QUEUE', value: queue.name }
            { name: 'AZURE_AI_FOUNDRY_ENDPOINT', value: foundryEndpoint }
            { name: 'AZURE_AI_FOUNDRY_API_KEY', secretRef: 'foundry-key' }
            { name: 'AZURE_AI_FOUNDRY_MODEL', value: foundryModel }
            { name: 'GITHUB_APP_ID', value: githubAppId }
            { name: 'GITHUB_APP_PRIVATE_KEY', secretRef: 'github-key' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 5
        rules: [
          {
            name: 'queue-depth'
            custom: {
              type: 'azure-servicebus'
              metadata: {
                queueName: queue.name
                namespace: serviceBus.name
                messageCount: '1'
              }
              identity: identity.id
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    serviceBusDataOwner
    vaultSecretsUser
    acrPull
  ]
}

resource outboxWorker 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: '${prefix}-outbox'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registryConfiguration
      secrets: [
        databaseSecretReference
        githubSecretReference
      ]
    }
    template: {
      containers: [
        {
          name: 'outbox'
          image: outboxImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DEMO_MODE', value: 'false' }
            { name: 'SERVICE_NAME', value: 'modernize-outbox' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'GITHUB_APP_ID', value: githubAppId }
            { name: 'GITHUB_APP_PRIVATE_KEY', secretRef: 'github-key' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
          ]
        }
      ]
      scale: {
        minReplicas: 2
        maxReplicas: 2
      }
    }
  }
  dependsOn: [
    vaultSecretsUser
    acrPull
  ]
}

output applicationUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output managedIdentityPrincipalId string = identity.properties.principalId
output keyVaultName string = vault.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.properties.loginServer
output SERVICE_WEB_NAME string = app.name
output SERVICE_WEB_URI string = 'https://${app.properties.configuration.ingress.fqdn}'
output SERVICE_WORKER_NAME string = transformationWorker.name
output SERVICE_OUTBOX_NAME string = outboxWorker.name
output MIGRATION_JOB_NAME string = migrationJob.name
