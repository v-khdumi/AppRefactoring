process.env.SERVICE_NAME ||= "modernize-outbox";
await import("../scripts/migrate.mjs");
await import("./outbox.ts");
