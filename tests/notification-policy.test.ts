import assert from "node:assert/strict";
import test from "node:test";
import {notificationDefaults,notificationItems} from "../src/lib/notification-policy";

test("notification preferences filter actual run states and never invent unread events",()=>{
  const runs=["running","failed","blocked","awaiting-approval","pull-request-created","publication-failed"].map(status=>({status,progress:75,repository:"owner/repo"}));
  assert.equal(notificationItems([],notificationDefaults).length,0);
  assert.equal(notificationItems(runs,notificationDefaults).length,5);
  assert.equal(notificationItems(runs,{failures:false,approvals:false,completed:false,digest:false}).length,0);
  const items=notificationItems(runs,{failures:false,approvals:true,completed:false,digest:true});
  assert.equal(items.length,2);
  assert.equal(items[0].title,"Portfolio summary");
  assert.match(items[1].title,/awaiting-approval/);
});
