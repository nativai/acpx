// brick://113073b8 — the L1 preload, loaded via `node --test --import` (see
// `scripts/run-tests.mjs`).
//
// WHY A PRELOAD AND NOT AN IMPORT IN A SHARED HELPER. Coverage here has to hold
// for EVERY test file, including files that import nothing shared and files that
// do not exist yet. Measured on this tree: only 47 of 151 test files import
// `runtime-test-helpers.ts`, and the two dominant owner spawners — `cli.test.ts`
// and `integration.test.ts` — are not among them. A hook that lives in a shared
// module is a hand-maintained list wearing a disguise, and its failure is silent:
// a reaper that matches nothing looks exactly like one that worked.
//
// `--import` is applied by `node --test` to each test-file CHILD process, so
// coverage is by construction rather than by registration. It is deliberately NOT
// `NODE_OPTIONS`: that would also load into every `runCli` CLI subprocess, which
// would then mint its own tag and reap, on exit, the very owner it had just
// spawned. `--import` is not inherited through `spawn()`, only by the test
// runner's own file children — that distinction is load-bearing.

import { installOwnerReaper } from "./owner-reaper.js";

installOwnerReaper();
