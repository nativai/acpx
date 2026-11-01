import assert from "node:assert/strict";
import test from "node:test";
import {
  inheritedPrincipalEntries,
  principalContextFields,
  principalEntriesOf,
  principalEnvOf,
  recordedPrincipalOf,
  withRecordedPrincipal,
} from "../src/session/persistence/principal.js";

// PERSON-CONTRACT v3.1 C8.3 / CONCEPTION §4.2: what a new session records as its principal, and what the
// agent environment reads back. Pure functions; the CLI legs are in principal-spawn-paths.test.ts.

const P = "p-9df6e3afab610ff30d1a"; // Brammertz (V1)
const Q = "p-fb566154c0bf245b7538"; // Laatz (V2)

test("a creator with a recorded person is inherited: via=inherited, the person copied, principal_from = the creator", () => {
  const creator = {
    acpxRecordId: "creator-1",
    principal: {
      principal_via: "started",
      principal_id: P,
      principal_name: "Daniel Brammertz",
    },
  };
  assert.deepEqual(withRecordedPrincipal(undefined, creator), {
    principal_via: "inherited",
    principal_id: P,
    principal_name: "Daniel Brammertz",
    principal_from: "creator-1",
  });
});

test("an inherited nobody stays nobody: via=inherited, no id, principal_from still names the creator", () => {
  for (const via of ["none", "inherited"]) {
    assert.deepEqual(
      inheritedPrincipalEntries({ acpxRecordId: "c", principal: { principal_via: via } }),
      { principal_via: "inherited", principal_from: "c" },
      via,
    );
  }
});

test("a chain of inheritance copies the answer, and principal_from is always the IMMEDIATE creator", () => {
  const root = {
    acpxRecordId: "root",
    principal: { principal_via: "started", principal_id: Q, principal_name: "Daniel Laatz" },
  };
  const child = withRecordedPrincipal(undefined, root);
  const grandchild = withRecordedPrincipal(undefined, { acpxRecordId: "child", principal: child });
  assert.deepEqual(grandchild, {
    principal_via: "inherited",
    principal_id: Q,
    principal_name: "Daniel Laatz",
    principal_from: "child",
  });
});

test("a creator that predates the keys, or lives on another box, gives nothing to copy: no keys are written", () => {
  assert.equal(
    withRecordedPrincipal(undefined, { acpxRecordId: "legacy", principal: {} }),
    undefined,
  );
  assert.equal(withRecordedPrincipal(undefined, { acpxRecordId: "cross-box" }), undefined);
  const other = { brick: "b" };
  assert.deepEqual(withRecordedPrincipal(other, { acpxRecordId: "legacy", principal: {} }), other);
});

test("no creator at all (a bare shell) records principal_via=none, keeping the caller's other metadata", () => {
  assert.deepEqual(withRecordedPrincipal(undefined, undefined), { principal_via: "none" });
  assert.deepEqual(withRecordedPrincipal({ brick: "b" }, undefined), {
    brick: "b",
    principal_via: "none",
  });
});

test("explicit principal_* metadata wins over the creator, verbatim — atrium's own create paths pass it", () => {
  const explicit = { principal_via: "started", principal_id: Q, principal_name: "Daniel Laatz" };
  const creator = {
    acpxRecordId: "c",
    principal: { principal_via: "started", principal_id: P, principal_name: "x" },
  };
  assert.equal(withRecordedPrincipal(explicit, creator), explicit);
  assert.equal(withRecordedPrincipal(explicit, undefined), explicit);
  // even a lone key is "explicit": the caller took the writer's job, acpx adds nothing beside it.
  const lone = { principal_via: "armer" };
  assert.equal(withRecordedPrincipal(lone, creator), lone);
});

test("atrium creating for someone (started_by_*) leaves the principal to atrium — acpx does not write `none` over its walk", () => {
  const byAtrium = { started_by_name: "Ada", started_by_kind: "human" };
  assert.equal(withRecordedPrincipal(byAtrium, undefined), byAtrium);
  const creator = {
    acpxRecordId: "c",
    principal: { principal_via: "started", principal_id: P, principal_name: "x" },
  };
  assert.equal(withRecordedPrincipal(byAtrium, creator), byAtrium);
});

test("near-miss keys do not count as principal_* or started_by_* (prefix, case, position)", () => {
  const near = { Principal_via: "x", not_principal_via: "x", principal: "x", startedby_name: "x" };
  assert.deepEqual(principalEntriesOf(near), undefined);
  assert.deepEqual(withRecordedPrincipal(near, undefined), { ...near, principal_via: "none" });
});

test("principal_* values that are not strings are never picked up (metadata is Record<string,string>)", () => {
  assert.deepEqual(
    principalEntriesOf({ principal_via: "started", principal_id: 7, principal_x: { a: 1 } }),
    {
      principal_via: "started",
    },
  );
  assert.equal(principalEntriesOf(null), undefined);
  assert.equal(principalEntriesOf([["principal_via", "x"]]), undefined);
});

test("recordedPrincipalOf: null without principal_via (not recorded); empty values read as absent", () => {
  assert.equal(recordedPrincipalOf(undefined), null);
  assert.equal(recordedPrincipalOf({ principal_id: P }), null);
  assert.deepEqual(
    recordedPrincipalOf({ principal_via: "none", principal_id: "", principal_name: "  " }),
    {
      via: "none",
      id: null,
      name: null,
      from: null,
    },
  );
});

test("principalEnvOf: a well-formed id (and its name) only; nobody, a malformed id or a control character give no variable", () => {
  assert.deepEqual(
    principalEnvOf({
      principal_via: "started",
      principal_id: P,
      principal_name: "Daniel Brammertz",
    }),
    {
      id: P,
      name: "Daniel Brammertz",
    },
  );
  assert.deepEqual(principalEnvOf({ principal_via: "started", principal_id: P }), {
    id: P,
    name: null,
  });
  assert.equal(principalEnvOf({ principal_via: "none" }), null);
  assert.equal(principalEnvOf({ principal_via: "inherited", principal_from: "c" }), null);
  for (const bad of [
    "P-9df6e3afab610ff30d1a",
    "p-9df6e3afab610ff30d1",
    `${P}\n`,
    "p-9DF6E3AFAB610FF30D1A",
  ]) {
    assert.equal(
      principalEnvOf({ principal_via: "started", principal_id: bad }),
      null,
      JSON.stringify(bad),
    );
  }
  assert.deepEqual(
    principalEnvOf({ principal_via: "started", principal_id: P, principal_name: "Ada\nLovelace" }),
    {
      id: P,
      name: null,
    },
  );
});

test("principalContextFields: null (never absent) for no principal, so a leg that forgot the spread differs from one that asked", () => {
  assert.deepEqual(principalContextFields({ principal_via: "none" }), {
    principalId: null,
    principalName: null,
  });
  assert.deepEqual(principalContextFields(undefined), { principalId: null, principalName: null });
  assert.deepEqual(
    principalContextFields({
      principal_via: "started",
      principal_id: Q,
      principal_name: "Daniel Laatz",
    }),
    {
      principalId: Q,
      principalName: "Daniel Laatz",
    },
  );
});
