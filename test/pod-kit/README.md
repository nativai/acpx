# test/pod-kit — the tier-0 fakes (block X1)

Fakes built to `CONTRACTS-r4.md` (design: `INTEGRATION-ENV-r4.md`, tier 0). Each is ONE file, Node standard
library only, erasable TypeScript (no enums / namespaces / parameter properties), so the same file is

- imported by acpx tests: `import { startFakeBroker } from "./pod-kit/fake-broker.js"` (the test file is compiled
  into `dist-test/`), and
- run as a process by any repo (Node >= 22.18 strips the types itself):
  `node test/pod-kit/<fake>.ts --port 0 --script <file | inline json>` — the first stdout line is one JSON object,
  `{"fake":"broker"|"kube-api"|"atrium","host":"127.0.0.1","port":<n>,…}`; SIGTERM stops it.

Self-tests sit at the top level of `test/` (`pod-kit-*.test.ts`) because the suite globs only `test/*.test.ts`.
Every fake has the same kit surface, in-process and over HTTP:

|                   | in-process                                                     | process                               |
| ----------------- | -------------------------------------------------------------- | ------------------------------------- |
| start             | `await startFakeX(script, { port?, host? })` → `.url`, `.port` | `--port --script`                     |
| record            | `.requests` (every request, in order)                          | `GET /_kit/record` → `{requests:[…]}` |
| re-script         | `.setScript(script)`                                           | `POST /_kit/script` (body = script)   |
| forget the record | `.reset()`                                                     | `POST /_kit/reset`                    |
| stop              | `await .close()` — the port then refuses connections           | SIGTERM                               |

## fake-broker.ts — C4, kind `agent`

`POST /v1/agents/<key>` (streamed `text/plain`: progress lines, then exactly one final line), `DELETE /v1/agents/<key>`,
`GET /v1/agents`. Script (`BrokerScript`): `default` · `jobs[]` (the 1st Job created gets `jobs[0]`, the 2nd `jobs[1]`, …) ·
`keys{<key>: behaviour}` (wins) · `delete{delayMs,status}` · `status{…}` for `GET /v1/agents` (what is not given is derived
from the live Jobs). A behaviour:

```
{ steps: ["scheduling", {line:"pulling", delayMs:300}],      // progress lines, per-step delay
  final: {ready:{ip,pod,uid,node,placement}} | {refused:{reason,live,cap}} | {error:"start_failed"} | "<raw line>",
  finalDelayMs: 100,
  hang: true,                                  // the steps, then never a final line (until DELETE / close)
  drop: {afterLines:1, times:1, beforeHeaders:false}, // cut the stream; the Job goes on
  respond: {status:503, body:"busy"} }         // a plain HTTP failure instead of a stream
```

A Job exists per key from its first `POST`; a second `POST` for the key **follows the same Job** (gets the whole line
history; `joinedExistingJob` in its record) until `DELETE` removes it. A request with `contract` other than `1` is answered
`error unsupported_contract` and starts nothing. Record entry: `method, path, key, headers, body, problems, jobSeq,
joinedExistingJob, linesSent, outcome` — `problems` names every departure of the request from C4's shape (never rejected;
assert it is empty): `field_missing:<f>`, `field_invalid:<f>`, `releases_missing:<tool>` (C9: only `pi-extensions` may be
absent), `releases_invalid:<tool>`, `key_mismatch` (key ≠ SHA-256(sessionId)[:24]), `invalid_json`, `contract_missing`.
`wellFormedAgentRequest(sessionId, overrides)` builds a correct body and its key.

`DELETE /v1/agents/<key>?uid=<pod uid>`: a wrong uid deletes nothing and answers 200 with the body exactly
`refused reason=uid_mismatch\n`; a matching uid (also on a pod terminating during the scripted `delete.delayMs`) deletes and answers
200 empty; no pod of the key, with or without a uid, answers 200 empty. A Job's pod uid is the one its `ready` line carries
(`final.ready.uid`, or generated). A utility request (`harness: "utility"`, key `util-pool` / `util-home`,
`wellFormedUtilityRequest(placement)`) carries no `seat` and no `sessionId`: their absence is right, their presence is
`field_present:<f>`.

Assumptions C4 does not settle (agreed with the stream HoD and infra, 2026-11-21): every `POST` stream is HTTP 200 with
`refused` / `error` as the final line; `DELETE` answers 200, empty; `pool.state` is a free string (default `"ready"`); a body
that is not JSON gets `error invalid_request`.

## fake-apiserver.ts — the C3.3 death proof, and the pod list

Plain HTTP, the real Kubernetes shapes. The two requests acpx's death proof makes
(`/wisdom/Bricks/8d85cb47-604b-4d0f-9b79-b010bcedfb2d/reports/DEATH-PROOF-QUERIES.md`): `GET /api/v1/namespaces/<ns>/pods/<name>`
and `GET /api/v1/nodes/<name>`, answered as a Pod / Node, or a `Status` 404. Point acpx at it with its test seam (honoured
only under `NODE_TEST_CONTEXT`): `ACPX_POD_API_URL=<fake .url>`, `ACPX_POD_SA_DIR=<dir with token, namespace>`. Also, for the
atrium server's agent-pod set: pod and node lists with label / field selectors and `?watch=true` (ADDED for the current set,
then MODIFIED / DELETED; `resourceVersion` replays); `fieldSelector=metadata.uid=…` is a 400 as on the real API.

Script (`ApiScript`): `namespace` (default `"default"`) · `pods[{name, namespace?, uid?, node?, phase?, podIP?, labels?,
annotations?, deleting?}]` · `nodes[{name, ready: "True"|"False"|"Unknown"|null}]` (`null` = no Ready condition) · `token`
(then a missing / wrong bearer is a 401 `Status`) · `faults[{mode, path?, method?, status?, delayMs?, times?}]`.

| Death-proof answer | Build it with                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exists`           | a pod with that uid, phase not terminal (`deleting: true` too)                                                                                                    |
| `gone`             | no pod of the name (or another uid) and the node `ready:"True"` or absent; or the pod with phase `Succeeded` / `Failed`                                           |
| `unknown`          | node `ready:"False"` / `"Unknown"` / `null`; or a fault: `status` (401, 403, 5xx), `hang`, `reset`, `malformed` (200, not JSON), `slow` (answers after `delayMs`) |

Move the cluster between two asks: `addPod`, `setPodPhase`, `removePod`, `addNode`, `setNodeReady`, `removeNode`,
`setFaults` (process: `POST /_kit/op` with `{op:"addPod", pod:{…}}` etc.).

## recorded-atrium.ts — C6, atrium's port 3456

`POST /api/acpx/call` (C6.2) · `POST /api/sessions/<id>/message` · `POST /api/seats/<id>/message` · `POST /api/agent-pods/<key>/ready|ended` (C6.3).
Script (`AtriumScript`): `phases[]` · `calls[{argvPrefix?, answer, times?, loseAnswer?}]` · `messages{status?,body?}` · `hints{status?,body?}`.
A call answer is `{exit, stdout?, stderr?, delivery?}` (HTTP 200) or `{status, body}` (e.g. `400 {"error":"class-not-passable"}`).
The same `call_id` returns the answer the first one made (`replayed` in the record); `loseAnswer` runs the call and cuts the connection
before answering — the lost-answer retry.

**Modes**, as `phases` (each ends after `forMs` or after `forRequests` answered requests; the last is for ever):

| mode      | what a client meets                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `normal`  | answers from the script                                                                                       |
| `away`    | the forwarder's answer: `503`, `Retry-After: 5`, `{"error":"atrium-away"}`                                    |
| `refused` | the port refuses connections (real `ECONNREFUSED`; open connections cut); back on the same port after `forMs` |
| `hang`    | accepts, never answers                                                                                        |

"Away for N s, then back": `[{mode:"away",forMs:N*1000},{mode:"normal"}]`. **Compressing the client's 600 s budget:** use
`[{mode:"away",forRequests:3},{mode:"normal"}]` (no clock at all — back after the 3rd refused attempt), or short `forMs`; the budget
override itself belongs to the client under test (honoured only under `NODE_TEST_CONTEXT`). `setMode(mode, forMs?)` / `POST /_kit/mode`
switch at once. `refused` cannot be left over HTTP (nothing is listening): give it a `forMs`.
Record entry: `route` (`call|session_message|seat_message|hint_ready|hint_ended`), `target`, `body`, `stdin` (a call's decoded
`stdin_b64`), `problems` (departures from C6.2 / C6.3's shapes — `contract`, `call_id`, `argv`, `stdin_b64`, `stdin_b64_too_large`,
`caller.<f>`, `deadline_ms`…, never rejected), `mode` at the time, `outcome`, `callId`, `replayed`. An away call is still recorded
as a `call` with the client's `call_id`, so a test can assert the retries reuse it.
