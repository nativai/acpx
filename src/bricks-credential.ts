/**
 * THE BRICKS-REALM CREDENTIAL FAMILY — one definition, and the strip every spawn path uses.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ THE CONTRACT'S PRESCRIBED REMEDY CLOSES ONE LAYER OF THREE. DO NOT BUILD TO THE SENTENCE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * C0 §3.5 rule 2 says: every spawn path strips the credential, and points at `auth-env.ts`'s
 * `{...process.env}` minus a delete list. That is necessary and it is NOT sufficient. Measured
 * census of every site that spawns `acpx` or `brick` — 11 subjects, 0 unknown, three positive
 * controls fired:
 *
 *   LAYER 1 — acpx-ui, 9 sites, all `env: acpxChildEnv()`. `server/acpxChildEnv.ts` is, in full, a
 *             `{...env}` copy that normalises a trailing slash and DELETES NOTHING. This is the
 *             FIRST HOP, and acpx-ui is the process that HOLDS the credential (§3.5 rule 1), so the
 *             leak begins one layer ABOVE the file the contract names.
 *   LAYER 2 — acpx `auth-env.ts`'s delete list. The adapter spawn path. The contract's remedy.
 *   LAYER 3 — acpx, 2 sites that spawn the BRICK CLI ITSELF and pass NO `env` option at all, so the
 *             child inherits `process.env` wholesale:
 *                 src/acp/brick-context.ts        (brick context, at session spawn)
 *                 src/cli/session/brick-link.ts   (brick show, resolving a --brick ref)
 *             ⚠️ NEITHER EVER REACHES `auth-env.ts`. A delete list there — prefix-based or not —
 *             cannot cover them, because the list is never consulted on those paths. The env must
 *             be CONSTRUCTED deliberately rather than inherited, which is what this module is for.
 *
 * So the honest baseline before this change was **11 of 11 paths propagating the parent environment
 * intact**, and the has-env / no-env split was cosmetic rather than protective. An implementation
 * that adds a prefix strip to `auth-env.ts` and stops would PASS a test written from the contract's
 * own wording while the credential still reached the brick CLI. Build to the PROPERTY: the
 * credential must not be readable by any child on any of the eleven paths, nor from
 * `/proc/1/environ`.
 */

/**
 * 🛑 THE TRAILING `S` IS LOAD-BEARING. WIDENING THIS TO `ACPX_BRICK` IS A FLEET-WIDE OUTAGE.
 *
 * `ACPX_BRICKS_*` (with the S) is the CREDENTIAL family — `ACPX_BRICKS_CREDENTIAL_FILE` today.
 * `ACPX_BRICK_*` (no S) is ordinary, legitimately-inherited configuration: `ACPX_BRICK_POOL_DIR`,
 * `ACPX_BRICK_DB_PATH`, `ACPX_BRICK_DB_EXPORT_DIR`, `ACPX_BRICK_REALM`, plus `ACPX_BRICK` and
 * `ACPX_BRICK_PATH`, which every agent needs. Stripping on `ACPX_BRICK` would take the pool dir out
 * of every agent on every box and break `brick context` everywhere. The two families were named
 * apart precisely so this rule could be a prefix.
 *
 * ⚠️ TWO REPOS, ONE VALUE. `acpx-ui` declares the same constant in `brick/module/realm.ts`
 * (`BRICKS_CREDENTIAL_ENV_PREFIX`). acpx cannot import from acpx-ui, so the string is re-declared
 * and the two MUST stay in agreement — a rename on one side silently stops the other from matching,
 * with nothing failing. Treat a rename as a both-repos change.
 *
 * WHY A PREFIX AND NOT A NAME LIST: a delete list is ALLOW-BY-OMISSION — a variable nobody names is
 * inherited. `auth-env.ts`'s own comments record three separate bricks fixing variables its list
 * missed (brick://6530d3b4, brick://1820be37, brick://cb214e48), each a name somebody had to think
 * of first. A prefix cannot be defeated by a SECOND credential variable added later.
 */
export const ACPX_BRICKS_CREDENTIAL_ENV_PREFIX = "ACPX_BRICKS_";

/** Delete the whole credential family from `env`, in place. */
export function deleteBricksCredentialEnv(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith(ACPX_BRICKS_CREDENTIAL_ENV_PREFIX)) {
      delete env[name];
    }
  }
}

/**
 * `brickChildEnv()` — acpx's peer of acpx-ui's `acpxChildEnv()`, applying the SAME deny-by-prefix
 * policy at the acpx->brick leaf hop.
 *
 * ⚠️ THE CONTRACT NAMES THE CONSTRUCTION POINT, NOT MERELY THE DELETION (C0-RULES (b2)). The two
 * leaf sites pass NO `env` option at all, so they never reach `auth-env.ts` and its deletion CANNOT
 * RUN ON THEM — deleting from an environment the hop never builds is a no-op. This is why layer 2
 * is closed on its own rather than only transitively.
 *
 * ⚠️ PASSING THIS IS NOT OPTIONAL AT THOSE SITES, AND OMITTING IT LOOKS LIKE NOTHING. A `spawn`
 * with no `env` option inherits the parent's environment silently and successfully; there is no
 * error, no warning, and the child works perfectly. The only observable difference is that the
 * credential is now readable by the brick CLI and everything it spawns.
 */
export function brickChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  deleteBricksCredentialEnv(childEnv);
  return childEnv;
}
