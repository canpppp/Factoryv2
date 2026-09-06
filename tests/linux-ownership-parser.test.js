"use strict";

const assert = require("node:assert/strict");
const { createLinuxOwnership, INFO_BYTES } = require("../src/adapters/linux-ownership");
// Invalid backend metadata never needs /proc or any subprocess to be refused.
for (const text of ["", "{", "null", "[]", '{"child-pid":1,"pid-namespace":2}', '{"child-pid":2,"pid-namespace":"3"}', '{"child-pid":-1,"pid-namespace":3}']) {
  const owner = createLinuxOwnership(99);
  owner.data(Buffer.from(text)); owner.end();
  assert.equal(owner.observe(), "UNKNOWN");
  assert.equal(owner.receipt().init, null);
  owner.close();
}
const oversized = createLinuxOwnership(99);
oversized.data(Buffer.alloc(INFO_BYTES + 1));
assert.equal(oversized.observe(), "UNKNOWN");
assert.equal(oversized.receipt().infoBytesLimit, INFO_BYTES);
const incomplete = createLinuxOwnership(99);
incomplete.data(Buffer.from('{"child-pid":'));
assert.equal(incomplete.observe(), "PENDING");
incomplete.end(); assert.equal(incomplete.observe(), "UNKNOWN");
const late = createLinuxOwnership(99);
late.data(Buffer.from("{}")); late.end(); late.data(Buffer.from("{}"));
assert.equal(late.observe(), "UNKNOWN");
console.log("Linux backend metadata: bounded/malformed/EOF/late input refusal PASS (no subprocess)");
