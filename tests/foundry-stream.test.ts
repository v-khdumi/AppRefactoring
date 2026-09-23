import assert from "node:assert/strict";
import test from "node:test";
import { readFoundryStream } from "../src/lib/foundry-stream";

function responseFor(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  }}));
}

test("streams only public content across fragmented SSE and UTF-8 chunks", async () => {
  const snapshots: string[] = [];
  const event = { choices: [{ delta: { content: 'const label = "caf\u00e9";', reasoning_content: "private" } }] };
  const output = await readFoundryStream(responseFor(`data: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\n\n`), async text => { snapshots.push(text); });
  assert.equal(output, 'const label = "caf\u00e9";');
  assert.equal(snapshots.at(-1), output);
  assert.ok(!output.includes("private"));
});

test("rejects truncated streams and incomplete model output", async () => {
  await assert.rejects(readFoundryStream(responseFor('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), async () => {}), /before the plan was complete/);
  await assert.rejects(readFoundryStream(responseFor('data: {"choices":[{"finish_reason":"length"}]}\n\n'), async () => {}), /length/);
});