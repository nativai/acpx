import assert from "node:assert/strict";
import test from "node:test";
import {
  PRINCIPAL_VIAS,
  recordedPrincipalOf,
  principalEnvOf,
  inheritedPrincipalEntries,
} from "../src/session/persistence/principal.js";

const P = "p-9df6e3afab610ff30d1a";
for (const via of PRINCIPAL_VIAS) {
  test(`R1 C8.8 · acpx recorded principal_via=${via}`, () => {
    const metadata = {
      principal_via: via,
      principal_id: P,
      principal_name: "Daniel",
      principal_from: "creator",
    };
    const record = recordedPrincipalOf(metadata)!;
    assert.equal(record.via, via);
    assert.equal(record.id, via === "none" ? null : P);
    assert.equal(record.from, via === "inherited" ? "creator" : null);
    assert.equal(principalEnvOf(metadata)?.id ?? null, via === "none" ? null : P);
    const inherited = inheritedPrincipalEntries({ acpxRecordId: "parent", principal: metadata })!;
    assert.equal(inherited.principal_via, "inherited");
    assert.equal(inherited.principal_id ?? null, via === "none" ? null : P);
  });
}
test("R1 C8.8 · invalid via or malformed id never names a person", () => {
  assert.equal(principalEnvOf({ principal_via: "invented", principal_id: P }), null);
  assert.equal(principalEnvOf({ principal_via: "assigned", principal_id: "brammertz" }), null);
});
