process.env.SERVICE_NAME ||= "modernize-worker";
await import("../scripts/migrate.mjs");
await import("./index.ts");
