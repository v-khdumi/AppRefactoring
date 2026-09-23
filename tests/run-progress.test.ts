import assert from "node:assert/strict";
import test from "node:test";
import { planningProgress, canDeleteRun } from "../src/lib/run-progress";

test("planning advances only from reported agent milestones", () => {
  const agents = ["architect", "frontend", "backend", "cloud", "testing", "security"].map(agent_type => ({agent_type, status:"queued", has_output:false}));
  const progress = () => planningProgress("running", "parallel-agent-planning", 35, "fullstack", agents);
  assert.equal(progress(), 35);
  agents[0].status = "running";
  agents[0].has_output = true;
  assert.ok(progress() > 35);
  const streaming = progress();
  agents[0].status = "passed";
  assert.ok(progress() > streaming);
  agents.forEach(agent => agent.status = "passed");
  assert.equal(progress(), 74);
});

test("scope exclusions and terminal progress remain truthful", () => {
  const agents = [{agent_type:"frontend",status:"passed"},{agent_type:"backend",status:"queued"}];
  assert.equal(planningProgress("running","parallel-agent-planning",35,"frontend",agents),74);
  assert.equal(planningProgress("failed","parallel-agent-planning",0,"fullstack",agents),0);
  assert.equal(planningProgress("awaiting-approval","human-approval",90,"fullstack",agents),90);
});

test("deletion is denied during execution and publication", () => {
  for (const status of ["running","queued","retrying","approved","unknown"]) assert.equal(canDeleteRun(status),false);
  for (const status of ["failed","cancelled","pull-request-created","awaiting-approval"]) assert.equal(canDeleteRun(status),true);
});