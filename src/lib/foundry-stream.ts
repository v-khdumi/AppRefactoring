import { createParser } from "eventsource-parser";

export class IncompleteGenerationError extends Error {
  constructor(message = "Microsoft Foundry returned an incomplete generation. No generated changes were accepted.") {
    super(message);
    this.name = "IncompleteGenerationError";
  }
}

export async function readFoundryStream(response: Response, onOutput: (output: string) => Promise<void>) {
  if (!response.body) throw new Error("Foundry returned no response stream.");
  let output = "";
  let complete = false;
  let failure: Error | undefined;
  const parser = createParser({ onEvent(event) {
    if (event.data === "[DONE]") { complete = true; return; }
    try {
      const chunk = JSON.parse(event.data);
      if (chunk.error) throw new Error("Foundry interrupted the generation stream.");
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason === "length") throw new IncompleteGenerationError("Foundry generation stopped at its output limit (length). No generated changes were accepted.");
      if (choice?.finish_reason && choice.finish_reason !== "stop") throw new Error(`Foundry generation stopped: ${choice.finish_reason}.`);
      if (typeof choice?.delta?.content === "string") output += choice.delta.content;
      if (output.length > 4_000_000) throw new Error("Generated output exceeded the preview limit.");
    } catch (error) { failure = error instanceof Error ? error : new Error("Invalid Foundry stream."); }
  }});
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lastSaved = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.feed(decoder.decode(chunk.value, { stream: true }));
      if (failure) throw failure;
      if (Date.now() - lastSaved >= 1000 && output) { await onOutput(output); lastSaved = Date.now(); }
    }
    parser.feed(decoder.decode());
    if (failure) throw failure;
    if (!complete || !output) throw new IncompleteGenerationError("Foundry stream ended before the plan was complete. No generated changes were accepted.");
    await onOutput(output);
    return output;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}