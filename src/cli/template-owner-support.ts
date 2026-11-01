/**
 * The CLI side of personal templates (TEMPLATES CONCEPTION §8.1; brick 4608e926; build block T1 of brick
 * fcef527e). `command-handlers.ts` is shared by several streams, so the template verbs only WIRE these.
 *
 * The rules themselves live below the CLI: the key grammar (`template-name-key.ts`), typed-name resolution
 * and the fixed-owner rule (`template-owner.ts`), attribution (`template-actor.ts`).
 */
import { readPeopleFile, reportSkippedPeopleRows } from "../session/persistence/people-file.js";
import { isPersonId } from "../session/persistence/person.js";
import { isVisibleTemplateKey, parseNameKey } from "../session/persistence/template-name-key.js";
import {
  callerPrincipalId,
  canonicalMarkBase,
  isQualifiedTemplateName,
  planMarkKey,
  resolvePersonRef,
  resolveQualifiedTemplateKey,
} from "../session/persistence/template-owner.js";
import type { PersistedActor, SessionRecord } from "../types.js";

/**
 * `--owner <ref>` to a person id, and the whole owner/slug rule checked against what the record already
 * carries, BEFORE the mark closes the session: a refusal here changes nothing. The people list decides
 * (handle, former handle, id or full name); an id the box does not list is refused too, because a mark
 * WRITES a key and a key must name a real person.
 */
export async function resolveMarkOwner(
  flags: { owner?: string; slug?: string },
  existingKey: string | undefined,
): Promise<string | undefined> {
  const ownerId =
    flags.owner === undefined
      ? undefined
      : await resolvePersonRef(flags.owner, { acceptUnlistedId: false, where: " (--owner)" });
  const base = flags.slug === undefined ? undefined : canonicalMarkBase(flags.slug);
  planMarkKey(existingKey, ownerId, base);
  return ownerId;
}

/**
 * `--disable`: a SOFT retract (K10). The block, its slug and its version stay and `enabled` turns false, so
 * `--enable` restores it as the same version. A record with no template block has nothing to retract.
 */
export function softRetract(record: SessionRecord, actor: PersistedActor | undefined): void {
  if (record.template === undefined) {
    return;
  }
  record.template = {
    ...record.template,
    enabled: false,
    ...(actor === undefined ? {} : { updated_actor: actor }),
  };
}

/**
 * `sessions templates`: machine-wide templates plus the caller's principal's own (`ACPX_PRINCIPAL_ID`);
 * machine-wide only in a bare shell. Another person's template, and an invalid key, are never listed.
 */
export function visibleTemplateRecords(
  records: readonly SessionRecord[],
  env: NodeJS.ProcessEnv = process.env,
): SessionRecord[] {
  const principal = callerPrincipalId(env);
  return records.filter((record) => isVisibleTemplateKey(record.template?.slug, principal));
}

/** `templates rollback <name>`: a qualified name is turned into its stored key, a plain one is used as typed. */
export async function resolveRollbackKey(typed: string): Promise<string> {
  return isQualifiedTemplateName(typed) ? await resolveQualifiedTemplateKey(typed) : typed;
}

/**
 * What an agent types for a stored key: `<base>`, or `<handle>/<base>` for a person's. DISPLAY ONLY — the
 * handle comes from the people list, and when that cannot be read or does not list the person the stored
 * key itself is shown, so a broken list never hides a template or fails a mark that already succeeded.
 */
export async function templateAgentName(key: string | undefined): Promise<string | undefined> {
  if (key === undefined) {
    return undefined;
  }
  const parsed = parseNameKey(key);
  if (parsed.owner !== "person") {
    return key;
  }
  const read = await readPeopleFile().catch(() => undefined);
  if (read !== undefined) {
    reportSkippedPeopleRows(read);
  }
  const rows = read?.rows ?? [];
  const row = rows.find((candidate) => candidate.id === parsed.personId);
  return row === undefined ? key : `${row.handle}/${parsed.base}`;
}

/** The owner as the API spells it (C7.2): `box` for machine-wide, the person id for a personal template. */
function templateOwnerOf(key: string | undefined): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  const parsed = parseNameKey(key);
  if (parsed.owner === "person") {
    return isPersonId(parsed.personId) ? parsed.personId : undefined;
  }
  return parsed.owner === "machine" ? "box" : undefined;
}

/** The template block's part of `sessions template`'s JSON result. `slug` stays the STORED key. */
export function templateBlockResultFields(
  template: SessionRecord["template"],
  agentName: string | undefined,
) {
  const block = template ?? {};
  return {
    created_at: block.created_at,
    source_session_id: block.source_session_id,
    auto_prompt: block.auto_prompt,
    slug: block.slug,
    owner: templateOwnerOf(block.slug),
    agent_name: agentName,
    version: block.version,
    created_actor: block.created_actor,
    updated_actor: block.updated_actor,
  };
}
