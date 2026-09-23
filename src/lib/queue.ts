import { ServiceBusClient } from "@azure/service-bus";
import { ManagedIdentityCredential } from "@azure/identity";
import { env, serviceBusNamespace } from "@/lib/env";

let client: ServiceBusClient | undefined;

function serviceBusClient(){if(client)return client;const namespace=serviceBusNamespace();if(namespace)client=new ServiceBusClient(namespace,new ManagedIdentityCredential());else if(env.AZURE_SERVICE_BUS_CONNECTION_STRING)client=new ServiceBusClient(env.AZURE_SERVICE_BUS_CONNECTION_STRING);else throw new Error("Azure Service Bus is not configured.");return client;}

export async function enqueueTransformation(message: { runId: string; tenantId: string; requestedBy: string; dispatchId?:string }) {
  const sender = serviceBusClient().createSender(env.AZURE_SERVICE_BUS_QUEUE);
  try {
    await sender.sendMessages({
      messageId: message.dispatchId||message.runId,
      correlationId: message.runId,
      subject: "modernization.run.requested",
      contentType: "application/json",
      body: message,
      applicationProperties: { tenantId: message.tenantId, correlationId: message.runId },
    });
  } finally {
    await sender.close();
  }
}

export async function enqueueAgentInstruction(message: { runId: string; tenantId: string; requestedBy: string; agentType: string; instruction: string }) {
  const sender = serviceBusClient().createSender(env.AZURE_SERVICE_BUS_QUEUE);
  try {
    await sender.sendMessages({ messageId: `${message.runId}-${Date.now()}`, subject: "modernization.agent.instruction", contentType: "application/json", body: message, applicationProperties: { tenantId: message.tenantId, agentType: message.agentType } });
  } finally { await sender.close(); }
}