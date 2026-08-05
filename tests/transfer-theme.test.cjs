const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");

const source = readFileSync(new URL("../transfer-theme.js", `file://${__filename}`), "utf8");

test("Team Invitations transfer theme replaces only the generic utility chrome", () => {
  assert.match(source, /styleMarkers/);
  assert.match(source, /style\.remove\(\)/);
  assert.doesNotMatch(source, /Tahoma/);
  assert.match(source, /dialog-header/);
});
