import assert from "node:assert/strict";
import test from "node:test";
import { mapConcurrent } from "../src/lib/agent-concurrency";

test("does not expose failure to retry until already-started agents finish",async()=>{
  let release!:()=>void;
  const gate = new Promise<void>(resolve=>{release=resolve;});
  const started:number[]=[];
  const failure = new Error("Invalid model output");
  let settled = false;
  const result = mapConcurrent([1,2,3,4],2,async item=>{
    started.push(item);
    if (item === 1) throw failure;
    await gate;
    return item;
  });
  const checked = assert.rejects(result,error=>error===failure).then(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);
  assert.deepEqual(started,[1,2]);
  release();
  await checked;
  assert.deepEqual(started,[1,2]);
});

test("successful concurrent agent results retain input order",async()=>{
  assert.deepEqual(await mapConcurrent([1,2,3],2,async value=>value*2),[2,4,6]);
});