# test/pod-kit — the tier-0 fakes (block X1)

Fakes of the services the pod plane talks to. **The rule: a fake follows the REAL counterpart** — `broker.py` (argocd
`ap/agent-pods`), atrium's `server/` (`acpxCall/passThrough.ts`, `message-routes.ts`, `agentPods/hints.ts`, `callerGate`
on acpx-ui `agent-pods`), the real Kubernetes API. Where the real side and the contract text (C4 / C6 / C3.3) differ, the real
side wins and the difference is listed in `TESTER-PLAN.md` "Contract notes". Each fake is ONE file, Node standard library only,
erasable TypeScript, so the same file is

- imported by acpx tests: `import { startFakeBroker } from "./pod-kit/fake-broker.js"` (the test file is compiled into `dist-test/`), and
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

## fake-broker.ts — C4, kind `agent` (follows `broker.py`)

`POST /v1/agents/<key>` (streamed `text/plain`: progress lines, then exactly one final line), `DELETE /v1/agents/<key>[?uid=]`,
`GET /v1/agents`. A request is judged as `parse_agent_body` does (the contract first, then the key, the fields, the utility rules,
the releases): what it refuses is answered `error invalid_request` (a body over 64 KiB, a key outside `^([0-9a-f]{24}|util-pool|util-home)$`,
a seat that is no label value, a sessionId or release name outside its charset, a release object over 4096 bytes, `util-pool` with placement
`home`, a sessionId on a utility request, …) or `error unsupported_contract`, and creates nothing; the real reason is in the record's `problems`.
`wellFormedAgentRequest(sessionId, overrides)` / `wellFormedUtilityRequest(placement)` build correct bodies and their keys.

**A Job per key** from its first admitted `POST`. A later `POST` for the key **follows** it — told where the pod is NOW (the last step, or the
`ready` line; never the history, a step it already sent is not repeated). A Job whose final line was not `ready` (refused, error), or whose pod
ended (`endPod(key)` / `POST /_kit/end-pod {key}`), is NOT replayed: the next `POST` is a new request — admission is evaluated again, a
new Job with a new uid, the next scripted behaviour. **Admission** is `admission_refusal` in order: `live ≥ cap` or (class not `interactive` and
`live ≥ cap − reserve`) → `refused reason=agent_cap`; quota used ≥ hard → `quota`; target `home` with home live ≥ home cap → `home_full`. `auto` goes to
the pool while `pool.state` is `ready`, else home. Limits come from the script's `status` (`cap` 100, `reserve` 1, `home.cap` **0** as the real default,
`quota.hard` = cap — a box WITH its quota patch; the real default hard 0 refuses every create as `quota`, script `quota:{used:0,hard:0}` to see it;
`live` / `used` derived from the Jobs unless scripted); `GET /v1/agents` reports the same numbers.

**DELETE**: `?uid=<pod uid>`: a wrong uid deletes nothing and answers 200 with the body exactly `refused reason=uid_mismatch\n`; a matching uid (also on a
pod terminating during the scripted `delete.delayMs`) deletes and answers 200 empty; no pod of the key answers 200 empty; **an EMPTY `?uid=` is no uid** —
it deletes the key's Job unconditionally (the real `uid or None`: A-1's hazard, consumers must never send it empty). While a DELETE of a key runs, and
for every `POST` that began before its answer, the final line is `error deleted` (never re-created); a `POST` that starts after the answer is a new request.
`delete.status` 504 / 502 answer the real bodies `error timeout` / `error kube_api_error`.

Script (`BrokerScript`): `default` · `jobs[]` (the 1st Job CREATED gets `jobs[0]`, the 2nd `jobs[1]`, …; a refused POST consumes none) · `keys{<key>: behaviour}` (wins) ·
`delete{delayMs,status}` · `status{…}`. A behaviour:

```
{ steps: ["scheduling", {line:"pulling", delayMs:300}],      // progress lines, per-step delay
  final: {ready:{ip,pod,uid,node,placement}} | {refused:{reason,live,cap}} | {error:"start_failed"} | "<raw line>",
  finalDelayMs: 100,
  hang: true,                                  // the steps, then never a final line (until DELETE / close)
  drop: {afterLines:1, times:1, beforeHeaders:false}, // cut the stream; the Job goes on
  respond: {status:503, body:"busy"} }         // a plain HTTP failure instead of a stream
```

Record entry: `method, path, query, key, headers, body, problems, jobSeq, joinedExistingJob, linesSent, outcome`. C9: only `pi-extensions` may be absent from `releases`.

Assumptions the real broker confirms (agreed with the stream HoD and infra, 2026-11-21): every `POST` stream is HTTP 200 with `refused` / `error` as the
final line; `DELETE` answers 200, empty; `pool.state` is a free string; a body that is not JSON gets `error invalid_request`.
Not modelled (list in TESTER-PLAN): the pool→home overflow, `error timeout`, `error kube_api_error`, HTTP/1.0 close-delimited framing.

## fake-apiserver.ts — the C3.3 death proof, and the pod list

Plain HTTP, the real Kubernetes shapes. The two requests acpx's death proof makes
(`/wisdom/Bricks/8d85cb47-604b-4d0f-9b79-b010bcedfb2d/reports/DEATH-PROOF-QUERIES.md`): `GET /api/v1/namespaces/<ns>/pods/<name>`
and `GET /api/v1/nodes/<name>`, answered as a Pod / Node, or a `Status` 404. Point acpx at it with its test seam (honoured
only under `NODE_TEST_CONTEXT`): `ACPX_POD_API_URL=<fake .url>`, `ACPX_POD_SA_DIR=<dir with token, namespace>`. Also, for the
atrium server's agent-pod set: pod and node lists with label / field selectors (`spec.nodeName`, `spec.serviceAccountName`, `status.phase`, node
`spec.unschedulable`, …; `fieldSelector=metadata.uid=…` is a 400 as on the real API) and `?watch=true` (ADDED for the current set, then MODIFIED / DELETED;
`resourceVersion` replays; after `compact()` a watch from an older version gets the ERROR event `410 Expired`).

Measured against the real API (TE, 2026-11-22): list items carry no `kind`/`apiVersion`; timestamps have second precision; an unscheduled Pending pod has no
`spec.nodeName` key and no Ready condition (`PodScheduled False` only); a Ready=False node's reason is `KubeletNotReady`. The fake does the same. Not modelled:
`limit` / `continue`.

Script (`ApiScript`): `namespace` (default `"default"`) · `pods[{name, namespace?, uid?, node?, serviceAccount?, phase?, podIP?, labels?,
annotations?, deleting?, ready?, readyTransitionTime?}]` (the pod's Ready condition and its `lastTransitionTime`, A-1) ·
`nodes[{name, ready: "True"|"False"|"Unknown"|null, readyTransitionTime?, unschedulable?}]` (`null` = no Ready condition) · `token`
(then a missing / wrong bearer is a 401 `Status`) · `faults[{mode, path?, method?, status?, delayMs?, variant?, times?}]`.

The 404 for an absent pod / node is exactly the real `Status` of DEATH-PROOF-QUERIES.md v1.1 (`kind:"Status"`, `reason:"NotFound"`,
`details.kind` = `pods`/`nodes`, `details.name` = the asked name). Fault `notfound` answers a WRONG 404 even where the object exists — acpx must
read each as `unknown`: `variant` `text` (text/plain) · `empty` · `other_reason` · `other_name` · `other_kind`.

| Death-proof answer | Build it with                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exists`           | a pod with that uid, phase not terminal (`deleting: true` too)                                                                                                                                              |
| `gone`             | no pod of the name (or another uid) and the node `ready:"True"` or absent; or the pod with phase `Succeeded` / `Failed`                                                                                     |
| `unknown`          | node `ready:"False"` / `"Unknown"` / `null`; or a fault: `status` (401, 403, 5xx), `hang`, `reset`, `malformed` (200, not JSON), `slow` (answers after `delayMs`), `notfound` (a 404 that is not the proof) |

Move the cluster between two asks: `addPod`, `setPodPhase`, `setPodReady` (moves `lastTransitionTime` too), `removePod`, `addNode`, `setNodeReady`,
`removeNode`, `setFaults`, `compact` (process: `POST /_kit/op` with `{op:"addPod", pod:{…}}` etc.).

## recorded-atrium.ts — C6, atrium's port 3456 (follows atrium's `server/`)

`POST /api/acpx/call` · `POST /api/sessions/<id>/message` · `POST /api/seats/<id>/message` · `POST /api/agent-pods/<key>/ready|ended`. Only
`Content-Type: application/json` is parsed (`express.json`): any other leaves an EMPTY body (a call then fails `unsupported-contract`, a message `text is
required`); a malformed JSON body is the framework's 400 HTML.

**The call** is judged as `parseCallBody` does, in its order — `unsupported-contract` (+`contract`), `bad-call-id`, `bad-argv`, `bad-stdin` / 413
`stdin-too-large`, `bad-caller` (+`field`), `bad-admission-class`, `bad-inherit`, `inherit-not-string` (+`name`), `bad-deadline` (+`max_ms`) — then: the
claimed caller against the calling pod (`callerClass: "agent-pod"` + `agentPod`: `403 caller-mismatch`), `bad-caller` for a call with no caller from a `local`
peer, `inherit-not-allowed` (+`name`; the closed list `INHERIT_ALLOWED`), then **acpx's class table**: the kit loads acpx's synchronous `classifyArgv` from the compiled
`src/pod/command-classes.js` when it can (in acpx's suite). A verdict that does not pass is `400 class-not-passable` (+`reason`: `unclassified` · `help` · `class` · `target-unresolved` ·
`own-session` · `no-caller` · `file-argument` · `table-unavailable`). **The kit never touches a store it was not given**: the test process's own HOME is never read or written.
A record / owner-if-pod target resolves only against `stateHome` — the HOME (holding `.acpx`) of the control pod's store, which a test seeds with its own sessions (`addRecord`); then a
long-lived child process runs acpx's own `resolveTargetRecordId` with HOME = `stateHome` (every `ACPX_*` variable removed). Without `stateHome` a target is `target-unresolved`, unless
`resolveTargetAs` says it exists. In a BARE process (`node recorded-atrium.ts`, where acpx's `.js` specifiers do not resolve) a conservative fallback is used, as the real door is
for an unloaded table: only the create paths pass (`--format json sessions new …` is read as `sessions new`: global value flags are skipped), `-h` is help, everything else is
`table-unavailable`. A leading `acpx` is read as an agent name (measured), so the A-24 shape is NOT refused by the table. A **create** (class `create`, not `sessions handover`) then needs `record-id-required` /
`call-id-mismatch` (A-27) / `more-than-one-first-message`; its first message (`--prompt <t>`, `--prompt-file -` + stdin) is taken OUT of the argv acpx is run with.
`cwd` is ignored (A-9); a present one is the recorded problem `cwd_present`. Nothing runs for a refusal (no rule consumed).

**At most once** is atrium's, not the kit's: a create whose first message was recorded under `call_id` is a **replay** — acpx IS run again (the next rule answers) and
the answer carries `delivery:{delivery_id, to, status:"queued", replay:true}`; another sender reusing the id is `409 delivery-id-conflict`; a replay with another
first message is `200 {exit:2, error:"create-replay-mismatch"}` and nothing runs. Everything else — a create without a message, a non-create, a changed `--record-id` —
is run again as sent. Acpx's own at-most-once is modelled: a create whose record id exists is answered from the record only for the SAME `--created-by-call`; a repeat WITHOUT it (or with another call id) is
refused by acpx — `exit 1`, `record-id destination already exists; refusing to create another ACP session`, no `delivery`, never `replay:true`. `loseAnswer` runs the call (the first message stays recorded) and cuts the connection before answering. `firstMessageHold` marks the first
message `delivery.held`; `forkNotice` / `templatePrompt` are what acpx's answer carries for atrium to queue besides the caller's message (the notice's wire id is `uuid5(call_id, "fork-notice")`; `delivery`
names the message, else the notice; both ids are conflict-checked). With `--format json` a create-replay-mismatch is a JSON-RPC error on STDOUT and stderr is empty.

A rule: `calls[{argvPrefix?, answer, times?, loseAnswer?}]` matches the argv acpx is RUN with; `answer` is `{exit, stdout?, stderr?}` (wrapped as `{exit,stdout,stderr,delivery?}`)
or `{status, body}` (a whole HTTP answer).

**Messages**: `text` (or content blocks: `bad-content` for a malformed list / block, `bad-task-options`, `task-options-too-large`) required, `delivery_id` a lowercase uuid (`400 bad-delivery-id`) and echoed — and
owned by its first sender (`409 delivery-id-conflict` for another, shared with the call route's ids); `from` = the body's, else `X-Source-Session`, else `anonymous`. Every accepted message is **202** `{delivery_id, from, to,
to_seat?, status:"queued"}`; a held one adds `held:{since, reason, ahead}` and `message` (atrium's `heldSentence`: `pod_starting`, `agent_cap`, `paused`, `held-by-policy`, else "no room"; the recipient's NAME from
`messages.names`) — `status` stays `queued`. `messages{answers?[], default?, seats?, seatOf?, names?, recipients?}`: `"queued"` · `"held"` / `{held:{reason, ahead?}}` · `{status, body}`; `seats` maps a seat to its holder's record id
(`to` on the seat route), `seatOf` a session to its seat (`to_seat`); `recipients` scripts what the route refuses about the recipient — seat route: `unknown`/`not-a-seat` (404 `not-a-seat`), `vacant` (409 SEAT_VACANT); session route:
`unknown` (404); both: `archived` (409 SESSION_ARCHIVED), `template`, `closing` (409 SESSION_CLOSING), `closed` (409 SESSION_CLOSED unless the body says `reopen:true`).

**Hints**: key `^[0-9a-f]{24}$` else `400 bad-key`; a present `contract` ≠ 1 is `400 unsupported-contract`; `ready` answers `{ok:true, redriven}` (`hints.redriven`), `ended`
`{ok:true}`; the `ended` reason is an open set. Shape departures atrium does not refuse are `problems`.

**Modes**, as `phases` (each ends after `forMs` or after `forRequests` answered requests; the last is for ever):

| mode        | what a client meets                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `normal`    | answers from the script                                                                                                                                                                                                                                      |
| `away`      | the forwarder's answer: `503`, `Retry-After: 5`, `Connection: close`, `{"error":"atrium-away"}` — every route                                                                                                                                                |
| `refused`   | the port refuses connections (real `ECONNREFUSED`; open connections cut); back on the same port after `forMs`                                                                                                                                                |
| `hang`      | accepts, never answers                                                                                                                                                                                                                                       |
| `forbidden` | the gate's final 403 with the REAL body (`code:"CALLER_NOT_ALLOWED"`, `caller_class`, `route_class:"control"`) on the pass-through only — the `messaging` (both message routes) and `public` (the hints) classes are open to every caller, as in `isAllowed` |

"Away for N s, then back": `[{mode:"away",forMs:N*1000},{mode:"normal"}]`. **Compressing the client's 600 s budget:** use
`[{mode:"away",forRequests:3},{mode:"normal"}]` (no clock at all — back after the 3rd refused attempt), or short `forMs`; the budget override itself belongs to the
client under test (honoured only under `NODE_TEST_CONTEXT`). `setMode(mode, forMs?)` / `POST /_kit/mode` switch at once. `refused` cannot be left over HTTP (nothing is
listening): give it a `forMs`.
Record entry: `route` (`call|session_message|seat_message|hint_ready|hint_ended`), `target`, `body`, `stdin`, `ranArgv`, `problems`, `mode`, `outcome` (`answered`,
`refused:<error>`, `replayed`, `lost_answer`, `held`, `away`, `forbidden`, `hang`), `callId`, `replayed`. An away call is still recorded as a `call` with the client's `call_id`.
