param location string = resourceGroup().location
param jobName string
param environmentId string
param starterPrincipalIds array

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  identity: { type: 'None' }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [{
        name: 'runner'
        image: 'node:22-bookworm-slim'
        command: ['node', '-e', 'console.log("An explicit scoped verification request is required")']
        resources: { cpu: 2, memory: '4Gi' }
      }]
    }
  }
}

resource starterRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, jobName, 'verification-starter')
  properties: {
    roleName: '${jobName} starter'
    description: 'Start only the isolated verification job; no resource write or tenant data permissions.'
    type: 'CustomRole'
    permissions: [{ actions: ['Microsoft.App/jobs/read', 'Microsoft.App/jobs/start/action'], notActions: [] }]
    assignableScopes: [resourceGroup().id]
  }
}
resource assignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in starterPrincipalIds: {
  name: guid(job.id, principalId, starterRole.id)
  scope: job
  properties: { roleDefinitionId: starterRole.id, principalId: principalId, principalType: 'ServicePrincipal' }
}]
output jobResourceId string = job.id