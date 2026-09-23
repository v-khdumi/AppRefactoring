import assert from "node:assert/strict";
import test from "node:test";
import { processAndSettle } from "../src/lib/message-processing";

test("expired message lock after successful work never triggers transformation retry",async()=>{
  let retries=0;let settlementErrors=0;
  await processAndSettle(async()=>{},async()=>{throw new Error("MessageLockLost");},async()=>{retries++;},()=>{settlementErrors++;});
  assert.equal(retries,0);assert.equal(settlementErrors,1);
});

test("processing failure follows retry policy and does not complete the message",async()=>{
  let retries=0;let completions=0;
  await processAndSettle(async()=>{throw new Error("Generation failed");},async()=>{completions++;},async()=>{retries++;},()=>assert.fail("Unexpected settlement"));
  assert.equal(retries,1);assert.equal(completions,0);
});