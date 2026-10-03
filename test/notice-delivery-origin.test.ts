import assert from "node:assert/strict";
import test from "node:test";
import { noticeSender, resolveNoticeDeliveryOrigin } from "../src/cli/session/notice-delivery.js";

// Brick c85c42bf — where `sessions activate` sends the successor's notice. Pure ladder, no I/O:
// the namespace sources are passed in, so no row can reach the box's real acpx-ui.

test("an explicit ACPX_UI_INTERNAL_URL wins over the box namespace, trailing slashes trimmed", () => {
  assert.equal(
    resolveNoticeDeliveryOrigin(
      { ACPX_UI_INTERNAL_URL: " http://127.0.0.1:4010/// " },
      { namespaceFile: "dev-devbox" },
    ),
    "http://127.0.0.1:4010",
  );
});

test("an EMPTY ACPX_UI_INTERNAL_URL is authoritative: no origin, and no fall-through to the box", () => {
  assert.equal(
    resolveNoticeDeliveryOrigin({ ACPX_UI_INTERNAL_URL: "" }, { namespaceFile: "dev-devbox" }),
    undefined,
  );
});

test("unset: the origin is this box's cluster-internal acpx-ui, from the service-account namespace", () => {
  assert.equal(
    resolveNoticeDeliveryOrigin({}, { namespaceFile: "dev-devbox\n" }),
    "http://dev-server.dev-devbox.svc.cluster.local:3456",
  );
});

test("unset and no namespace file: resolv.conf's search domain supplies the namespace", () => {
  assert.equal(
    resolveNoticeDeliveryOrigin(
      {},
      {
        resolvConf: "nameserver 10.0.0.10\nsearch dev-konsiq.svc.cluster.local svc.cluster.local\n",
      },
    ),
    "http://dev-server.dev-konsiq.svc.cluster.local:3456",
  );
});

test("nothing resolvable: undefined — the caller prints the notice instead of guessing a host", () => {
  assert.equal(resolveNoticeDeliveryOrigin({}, {}), undefined);
  assert.equal(resolveNoticeDeliveryOrigin({}, { resolvConf: "search example.com\n" }), undefined);
});

test("the sender is the activator's own session id, else the verb's tag", () => {
  assert.equal(
    noticeSender({ ACPX_SESSION_URL: "https://ui.example.test/?session=abc-123" }),
    "abc-123",
  );
  assert.equal(noticeSender({}), "acpx:sessions-activate");
  assert.equal(noticeSender({ ACPX_SESSION_URL: "not a url" }), "acpx:sessions-activate");
  assert.equal(
    noticeSender({ ACPX_SESSION_URL: "https://ui.example.test/?seat=only-a-seat" }),
    "acpx:sessions-activate",
  );
});
