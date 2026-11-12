// brick a0182aed (TE F1) — the per-copy rule of the accepted-id registry the close's custody sweep reads.
import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetMessageAccepted,
  noteMessageAccepted,
  noteMessageCancelled,
  resetAcceptedMessageIdsForTests,
  wasAnotherCopyCancelled,
  wasMessageAcceptedByAnotherCopy,
} from "../src/cli/queue/accepted-message-ids.js";

test("a copy of an id another copy of which was accepted reads as delivered", () => {
  resetAcceptedMessageIdsForTests();
  noteMessageAccepted("s", "m", "copy-1");
  assert.equal(wasMessageAcceptedByAnotherCopy("s", "m", "copy-2"), true);
});

test("negative: a request's OWN acceptance never makes it a duplicate (context split's held half, N-A1-7)", () => {
  resetAcceptedMessageIdsForTests();
  noteMessageAccepted("s", "m", "copy-1");
  assert.equal(wasMessageAcceptedByAnotherCopy("s", "m", "copy-1"), false);
});

test("negative: a first copy that ended failed no longer vouches for a later copy, which is the re-drive", () => {
  resetAcceptedMessageIdsForTests();
  noteMessageAccepted("s", "m", "copy-1");
  forgetMessageAccepted("s", "m", "copy-1");
  assert.equal(wasMessageAcceptedByAnotherCopy("s", "m", "copy-2"), false);
  assert.equal(wasAnotherCopyCancelled("s", "m", "copy-2"), false);
});

test("F3: a first copy that ended cancelled stops a later copy, and no longer reads as delivered", () => {
  resetAcceptedMessageIdsForTests();
  noteMessageAccepted("s", "m", "copy-1");
  noteMessageCancelled("s", "m", "copy-1");
  assert.equal(wasAnotherCopyCancelled("s", "m", "copy-2"), true);
  assert.equal(wasMessageAcceptedByAnotherCopy("s", "m", "copy-2"), false);
});

test("F3 negative: a request's OWN cancel never stops itself", () => {
  resetAcceptedMessageIdsForTests();
  noteMessageCancelled("s", "m", "copy-1");
  assert.equal(wasAnotherCopyCancelled("s", "m", "copy-1"), false);
});

test("negative: another session, or an id never accepted, is never a duplicate", () => {
  resetAcceptedMessageIdsForTests();
  noteMessageAccepted("s", "m", "copy-1");
  assert.equal(wasMessageAcceptedByAnotherCopy("other", "m", "copy-2"), false);
  assert.equal(wasMessageAcceptedByAnotherCopy("s", "never", "copy-2"), false);
});
