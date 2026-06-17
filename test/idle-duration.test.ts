import assert from "node:assert/strict";
import test from "node:test";
import { formatIdleDuration } from "../src/cli/idle-duration.js";

const NOW = Date.parse("2026-06-17T12:00:00.000Z");

test("formats sub-minute idle as seconds", () => {
  assert.equal(formatIdleDuration("2026-06-17T11:59:15.000Z", NOW), "45s");
  assert.equal(formatIdleDuration("2026-06-17T12:00:00.000Z", NOW), "0s");
});

test("formats sub-hour idle as whole minutes", () => {
  assert.equal(formatIdleDuration("2026-06-17T11:13:00.000Z", NOW), "47m");
  assert.equal(formatIdleDuration("2026-06-17T11:59:00.000Z", NOW), "1m");
});

test("formats sub-day idle as hours and minutes", () => {
  assert.equal(formatIdleDuration("2026-06-17T09:47:00.000Z", NOW), "2h13m");
  assert.equal(formatIdleDuration("2026-06-17T11:00:00.000Z", NOW), "1h0m");
});

test("formats multi-day idle as days and hours", () => {
  assert.equal(formatIdleDuration("2026-06-14T08:00:00.000Z", NOW), "3d4h");
});

test("clamps future timestamps (clock skew) to 0s", () => {
  assert.equal(formatIdleDuration("2026-06-17T12:05:00.000Z", NOW), "0s");
});

test("returns null for an unparseable timestamp", () => {
  assert.equal(formatIdleDuration("not-a-date", NOW), null);
  assert.equal(formatIdleDuration("", NOW), null);
});
