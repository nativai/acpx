/**
 * **THE ID THAT DETERMINES WHICH MODEL SERVES THE SESSION** — the string a
 * caller sends as `--model` / `sessionOptions.model` for a given catalogue row
 * on a given harness.
 *
 * Brick c4da2ff2 problem 1: acpx-ui's picker was sending the catalogue row's
 * `id` (`qwen/qwen3.8-max-0902`) to a harness that advertises
 * `openrouter/qwen/qwen3.8-max-0902`, and the user saw their own model listed as
 * available inside the refusal.
 *
 * ## ⚠️ ON THE NAME — the DEFINITION is authoritative, not the word "wire"
 *
 * This module was written when the id a caller sends and the id on the ACP wire
 * were the same thing on every route acpx had, so "wire id" named it exactly.
 * They **diverge on claude via the OpenRouter shim** (brick 007eaac8): the
 * **slug** determines the served model, while the id going to the adapter stays
 * a **claude alias**. The field's answer there is the slug — the alias is an
 * implementation detail of the shim route. **Where the two disagree, follow
 * "determines which model serves", not the filename.** (Ruled by the acpx lead,
 * 2026-09-06; the name is kept only so the import path stays stable for the
 * lane building that route.)
 *
 * ## Why this is per-(MODEL, AGENT) and cannot live on the model
 *
 * Measured on every harness (report
 * `4145fe1e/reports/W2-wire-id-shapes-and-reason-split.md`):
 *
 *     claude       bare alias, no prefix, no bracket   `sonnet`
 *     codex        no prefix, bracket MANDATORY        `gpt-5.6-sol[medium]`
 *     pi           source + "/" + id                   `openrouter/qwen/qwen3-coder-flash`
 *
 * One harness prefixes, three do not, and one of the three fuses a rung in. So a
 * per-model field cannot carry the answer, and the tempting UI-side rule
 * `source === "openrouter" ? \`openrouter/${id}\` : id` is correct for pi
 * and **silently wrong for codex**. Both terms come from the harness
 * descriptor — {@link ModelIdForm} and `depth.mechanism` — never from the
 * agent's NAME.
 *
 * ## Relationship to `composeEffectiveModelId`
 *
 * `src/models/model-slug-validation.ts` composes the id acpx spawns with once a
 * user has ALREADY chosen a rung: it resolves the `source:` prefix away and
 * fuses the requested effort. This function answers the neighbouring question —
 * *what does a caller send for this row, before any effort is chosen* — so it
 * emits the row's OWN default rung, which `composeEffectiveModelId` then
 * overrides from an explicit `--reasoning-effort` (its precedence is
 * `explicit ?? ref.bracket ?? depth.default`). The two therefore agree by
 * construction on a row where nothing is requested, and
 * `test/models-wire-model-id.test.ts` pins that agreement rather than assuming
 * it.
 */

import type { ModelIdForm } from "../acp/harness-capabilities.js";
import type { CatalogueModel } from "./types.js";

/** The parts of a catalogue row the wire id is built from. */
export type WireModelIdRow = Pick<CatalogueModel, "id" | "source" | "depth">;

/**
 * The id to send for `row` on a harness with this id-form and depth mechanism.
 *
 * `null` means acpx cannot state one: a harness that fuses depth into the id, on
 * a row whose ladder offers no default rung, has no id that is valid on its own.
 * **`null` is not "send the bare id"** — for codex a bare family is REFUSED, so
 * guessing here would ship a string that fails at the adapter. A caller with no
 * wire id must not offer the row.
 */
export function deriveWireModelId(params: {
  row: WireModelIdRow;
  idForm: ModelIdForm;
  /** From the descriptor (`depth.mechanism === "compose-into-id"`), never from an agent name. */
  depthFusedIntoId: boolean;
}): string | null {
  const { row } = params;
  const base = params.idForm === "source-prefixed" ? `${row.source}/${row.id}` : row.id;
  if (!params.depthFusedIntoId) {
    return base;
  }
  const rung = row.depth.kind === "ladder" ? row.depth.default : null;
  return rung === null ? null : `${base}[${rung}]`;
}
