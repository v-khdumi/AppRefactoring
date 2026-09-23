import assert from "node:assert/strict";
import test from "node:test";
import { cleanWorkspaceUrl, emptyLiveRun, mergeRunSnapshot } from "../src/lib/execution-state";

test("live runs never start with sample files, agents or progress", () => {
  const run = emptyLiveRun("tenant-run");
  assert.equal(run.mode, "live");
  assert.equal(run.progress, 0);
  assert.deepEqual(run.files, []);
  assert.deepEqual(run.agents, []);
});

test("removes only obsolete demo probe parameter preserving authentication fragment", () => {
  assert.equal(cleanWorkspaceUrl("https://example.test/?demo-handshake-final=123&run=abc#code=callback"), "/?run=abc#code=callback");
});

test("overall and stage progress cannot regress within the same attempt", () => {
  const current = {...emptyLiveRun("run"),version:5,status:"running" as const,progress:80,attemptStartedAt:"2026-09-05T10:00:00Z",stages:[{id:"planning",title:"Planning",detail:"",status:"running" as const,progress:80}]};
  const latest = {...current,version:6,progress:78,stages:current.stages.map(stage=>({...stage,progress:78}))};
  const merged = mergeRunSnapshot(current,latest);
  assert.equal(merged.progress,80);
  assert.equal(merged.stages[0].progress,80);
  assert.equal(merged.version,6);
  assert.equal(mergeRunSnapshot(current,{...latest,version:4,status:"failed"}),current);
});

test("a new attempt or explicit retry can reset progress", () => {
  const current = {...emptyLiveRun("run"),version:5,progress:80,attemptStartedAt:"2026-09-05T10:00:00Z"};
  assert.equal(mergeRunSnapshot(current,{...current,version:6,status:"retrying",progress:0}).progress,0);
  assert.equal(mergeRunSnapshot(current,{...current,version:7,status:"running",progress:10,attemptStartedAt:"2026-09-05T11:00:00Z"}).progress,10);
  assert.equal(mergeRunSnapshot(current,{...current,id:"other-run",progress:0}).progress,0);
});