/**
 * A by-the-way side-thread ("byway") is a HUMAN's side conversation, opened from another
 * session's transcript in atrium (`sessions copy --ephemeral --parent-id <src>`). Its record
 * carries `parent_session_id = <src>`, so every lineage walk reads it as the source agent's
 * child — and agents have closed, re-parented and counted them as their own (brick 6867bbfc).
 *
 * THE ONE acpx DEFINITION. Every acpx surface that must keep a byway out of an agent's hands
 * (the `sessions close` guard, the `session-started` stamp skip, the `set-parent` refusal,
 * `sessions list --local`, the archive companion rule) asks this, never `metadata.byway` raw.
 *
 * ⚠️ DO NOT NARROW THIS TO `=== "1"`. `copyMetadata` writes `"1"` today, but a SUPERSET on the
 * flag is the safe direction everywhere it is read: here it only hides or refuses more, and in
 * the archive (`archive/record-view.ts`) failing to recognise a byway is what loses data. The
 * negative case for a non-`"1"` value lives in `test/byway-guard.test.ts`.
 */
export function isBywaySessionRecord(record: {
  readonly metadata?: Readonly<Record<string, unknown>>;
}): boolean {
  return record.metadata?.byway != null;
}
