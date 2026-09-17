// The acpx OpenRouter LIVE-ROUTING extension for pi sessions, embedded as a
// string for the same reason the shim is (openrouter-shim-code.ts): it must
// land as a standalone `.js` file inside the per-session config dir, and a
// template survives the tsdown bundle without a copy step.
//
// ## Why this exists — brick 5fee840d (measured 2026-09-13)
//
// pi reads `models.json` ONCE at process start, and acpx regenerates the
// config dir only at adapter spawn — so a provider-routing policy saved in
// `~/.acpx/ui-settings.json` AFTER a session spawned never reaches it. Measured
// on prod session 01a09cce (pi, openrouter/z-ai/glm-5.3-flash): spawned
// 22:06:40Z, models.json written 22:06:43Z (no policy existed yet), the order
// saved 22:09:00Z, the 22:11:09Z turn served by Z.AI — the default provider,
// outside the saved order. The spawn-time projection (brick 4c272cab,
// `writePiModelsConfig`) is correct and stays; this extension adds the missing
// LIVE half: re-resolve the box policy before EVERY provider request.
//
// pi's extension contract used: `before_provider_request` fires after the
// payload is built, and a handler's return value REPLACES the payload
// (`sdk.js onPayload` → `runner.emitBeforeProviderRequest`). Errors thrown by
// a handler are caught and reported by the runner — but this extension never
// throws anyway: every failure mode degrades to "leave the payload exactly as
// pi built it", i.e. the spawn-time models.json compat still applies, which is
// today's behaviour.
//
// ## Sticky session affinity — brick c2df657e
//
// The same handler also sets a top-level `session_id` body field on every
// OpenRouter-model request, taken from `ACPX_SESSION_RECORD_ID` (seeded by
// `buildAgentEnvironment`): OpenRouter's explicit sticky-routing key, which
// pins provider prompt-cache routing from the FIRST successful request and
// survives compaction/resume — where pi-ai's own affinity path would key on
// pi's session uuid (unstable) or nothing at all. `sendSessionAffinityHeaders`
// stays false everywhere: the header route keys on the wrong id.
//
// ## Semantics — a deliberate MIRROR of `resolveProviderObject`
//
// The extension runs inside the pi process; there is no channel back to acpx,
// so the resolver is necessarily a second copy. Kept minimal and pinned by
// `test/pi-routing-extension.test.ts`, which asserts the extension's resolver
// and acpx's `resolveProviderObject` agree on a matrix of valid AND invalid
// policies:
//
//   - the whole `openrouterRouting` object is validated first; an INVALID
//     policy is dropped WHOLE (never partially applied) — and behaves as "no
//     policy in force", matching acpx's drop-whole rule;
//   - `perModel[slug]` merges OVER the box-wide bounds key by key;
//   - `allow_fallbacks` defaults true (`false` is the measured 429 hazard);
//   - the quantization ladder expands a floor to a SET, appending `unknown`
//     unless `allowUnknownQuantization === false` (the fleet-wide 404 guard);
//   - `{}` resolution ⇒ no `provider` key at all — a truthy `{}` would put
//     `"provider": {}` on every request (the shape nobody authored).
//
// ## Scoping — only OpenRouter bodies are touched
//
// The scope decision is the request's LIVE model provider (ctx.model.provider
// === "openrouter"), the same id pi itself keys compat.openRouterRouting on —
// see the block above the handler for why a spawn-time snapshot was a real,
// live-reproduced defect.
//
// Reads config from env, same resolution rule as acpx's `uiSettingsPath`:
// ACPX_UI_SETTINGS_FILE || (ACPX_STATE_HOME || HOME)/.acpx/ui-settings.json.
export const PI_ROUTING_EXTENSION_FILENAME = "acpx-openrouter-routing.js";

export const PI_ROUTING_EXTENSION_CODE = `
import fs from 'node:fs'

// acpx OpenRouter live routing (brick 5fee840d) — seeded by acpx into this
// session's config dir. Re-resolves the box's provider-routing policy from
// ui-settings.json before every provider request, so a policy saved while the
// session is running takes effect. Fail-open: on any surprise the payload pi
// built (spawn-time models.json compat) is left untouched.
//
// brick c2df657e — STICKY SESSION AFFINITY. OpenRouter's provider sticky
// routing keeps consecutive requests on one provider endpoint to maximise
// prompt-cache hits, but WITHOUT an explicit routing key it derives one by
// hashing the first system + first non-system message and only engages after
// a first cache hit — both defeated by agent sessions (compaction and
// system-prompt regeneration change the hash; early turns go unpinned). So
// every OpenRouter-model request here carries an EXPLICIT top-level
// \`session_id\` body field (NOT inside provider — OpenRouter validates the
// provider object strictly and a bad field there 400s every turn) set to
// \`ACPX_SESSION_RECORD_ID\`: the acpx session RECORD id, handed in through
// buildAgentEnvironment. The record id — not the per-spawn ACP session id and
// not pi's own session uuid — is the key that survives a session resume, so
// one conversation keeps one cache key. It is read per request so a
// late-spawned child picks it up without a restart. Absent env ⇒ no opinion:
// the payload is left untouched (fail-open, same contract as the policy).
const SETTINGS_PATH = (() => {
  const explicit = (process.env.ACPX_UI_SETTINGS_FILE || '').trim()
  if (explicit) return explicit
  const base = (process.env.ACPX_STATE_HOME || process.env.HOME || '').trim()
  return base ? base + '/.acpx/ui-settings.json' : null
})()

const QUANTIZATION_LADDER = {
  fp4: ['int4', 'fp4', 'mxfp4', 'nvfp4', 'fp6', 'int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32'],
  fp6: ['fp6', 'int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32'],
  fp8: ['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32'],
  bf16: ['fp16', 'bf16', 'fp32'],
  fp32: ['fp32'],
}
const QUANTIZATIONS_ENUM = Object.keys(QUANTIZATION_LADDER).concat(['unknown'])
const PERCENTILES = ['p50', 'p75', 'p90', 'p99']
const POLICY_KEYS = new Set(['minQuantization', 'allowUnknownQuantization', 'minThroughput', 'ignore', 'perModel'])
const PER_MODEL_KEYS = new Set(['order', 'allowFallbacks'])
const PROVIDER_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkSlugList(value, errors) {
  if (value === undefined) return
  if (!Array.isArray(value)) { errors.push('ignore must be an array'); return }
  for (const entry of value) {
    if (typeof entry !== 'string' || !PROVIDER_SLUG.test(entry)) {
      errors.push('slug list entry must be a bare provider slug')
      return
    }
  }
}

// Mirrors validateRoutingPolicy: ANY error drops the policy whole. Returns
// errors.length === 0.
function policyIsValid(policy) {
  if (!isRecord(policy)) return false
  const errors = []
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.has(key)) { errors.push('unknown key ' + key) }
  }
  if (policy.minQuantization !== undefined) {
    if (typeof policy.minQuantization !== 'string' || !(policy.minQuantization in QUANTIZATION_LADDER)) {
      errors.push('minQuantization must be a ladder rung')
    }
  }
  if (policy.allowUnknownQuantization !== undefined && typeof policy.allowUnknownQuantization !== 'boolean') {
    errors.push('allowUnknownQuantization must be a boolean')
  }
  if (policy.minThroughput !== undefined) {
    if (!isRecord(policy.minThroughput)) {
      errors.push('minThroughput must be an object')
    } else {
      for (const [key, entry] of Object.entries(policy.minThroughput)) {
        if (!PERCENTILES.includes(key) || typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0) {
          errors.push('minThroughput must map percentiles to positive numbers')
          break
        }
      }
    }
  }
  checkSlugList(policy.ignore, errors)
  if (policy.perModel !== undefined) {
    if (!isRecord(policy.perModel)) {
      errors.push('perModel must be an object')
    } else {
      for (const [slug, entry] of Object.entries(policy.perModel)) {
        if (typeof slug !== 'string' || slug.trim().length === 0 || /\\s/.test(slug)) {
          errors.push('perModel slug must not be blank')
          continue
        }
        if (!isRecord(entry)) { errors.push('perModel entry must be an object'); continue }
        for (const key of Object.keys(entry)) {
          if (!PER_MODEL_KEYS.has(key)) { errors.push('unknown perModel key ' + key) }
        }
        if (entry.order !== undefined) {
          if (!Array.isArray(entry.order)) { errors.push('order must be an array') }
          else {
            for (const provider of entry.order) {
              if (typeof provider !== 'string' || !PROVIDER_SLUG.test(provider)) {
                errors.push('order entry must be a bare provider slug')
                break
              }
            }
          }
        }
        if (entry.allowFallbacks !== undefined && typeof entry.allowFallbacks !== 'boolean') {
          errors.push('allowFallbacks must be a boolean')
        }
      }
    }
  }
  return errors.length === 0
}

function expandQuantizationFloor(floor, allowUnknown) {
  const rungs = QUANTIZATION_LADDER[floor]
  if (!rungs) return []
  return allowUnknown ? rungs.concat(['unknown']) : rungs.slice()
}

// Mirrors resolveProviderObject for a session-less caller: perModel[slug]
// (with the openrouter/ selector prefix stripped) merged over the box-wide
// bounds; undefined when nothing applies. NEVER returns {}.
function resolveProviderObject(policy, modelSlug) {
  if (!policy) return undefined
  let perModel = {}
  if (modelSlug && isRecord(policy.perModel)) {
    const exact = policy.perModel[modelSlug]
    if (isRecord(exact)) {
      perModel = exact
    } else if (modelSlug.startsWith('openrouter/')) {
      const stripped = policy.perModel[modelSlug.slice('openrouter/'.length)]
      if (isRecord(stripped)) perModel = stripped
    }
  }
  const object = {}
  if (Array.isArray(perModel.order) && perModel.order.length > 0) {
    object.order = perModel.order.slice()
  }
  if (Array.isArray(policy.ignore) && policy.ignore.length > 0) {
    object.ignore = policy.ignore.slice()
  }
  if (policy.minQuantization) {
    const quantizations = expandQuantizationFloor(
      policy.minQuantization,
      policy.allowUnknownQuantization !== false,
    )
    if (quantizations.length > 0) object.quantizations = quantizations
  }
  if (isRecord(policy.minThroughput) && Object.keys(policy.minThroughput).length > 0) {
    object.preferred_min_throughput = Object.assign({}, policy.minThroughput)
  }
  if (Object.keys(object).length === 0) return undefined
  object.allow_fallbacks = perModel.allowFallbacks !== false
  return object
}

// mtime-gated read: the file is stat'd per request and parsed only when it
// changed. A VALID file yields the policy object; an INVALID one yields null
// (dropped whole); an unreadable one yields undefined (no opinion — the
// caller then leaves the payload untouched instead of stripping routing).
let cachedMtimeMs = null
let cachedSize = null
let cachedPolicy

function readPolicy() {
  if (!SETTINGS_PATH) return null
  let stat
  try {
    stat = fs.statSync(SETTINGS_PATH)
  } catch {
    return undefined
  }
  if (stat.mtimeMs === cachedMtimeMs && stat.size === cachedSize) {
    return cachedPolicy
  }
  cachedMtimeMs = stat.mtimeMs
  cachedSize = stat.size
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    const candidate = settings ? settings.openrouterRouting : undefined
    if (candidate === undefined || candidate === null) {
      cachedPolicy = null
    } else if (isRecord(candidate) && policyIsValid(candidate)) {
      // {} on disk is "auto" — treated as absent, exactly as acpx does.
      const hasScalars = candidate.minQuantization !== undefined || candidate.minThroughput !== undefined
      const hasEntries = (Array.isArray(candidate.ignore) ? candidate.ignore.length : 0)
        + (isRecord(candidate.perModel) ? Object.keys(candidate.perModel).length : 0)
      cachedPolicy = hasScalars || hasEntries > 0 ? candidate : null
    } else {
      cachedPolicy = null
    }
  } catch {
    cachedPolicy = undefined
  }
  return cachedPolicy
}

// Scoping: the LIVE model of THIS request (ctx.model), not a spawn-time
// snapshot. pi keys compat.openRouterRouting on the model's provider id
// ("openrouter") — the extension mirrors exactly that predicate.
//
// 🛑 THE SNAPSHOT THIS REPLACED WAS A REAL DEFECT, REPRODUCED LIVE
// (brick 5fee840d, TE finding, 2026-09-13): the first version built an
// openrouter-id set ONCE at module load from this config dir's
// models-store.json + models.json. For the FIRST pi child of a session spawned
// BEFORE the policy existed, acpx writes NEITHER file (pi already knows the
// slug from its bundled catalogue so no entry is fabricated, and the box cache
// can be empty), so the set was EMPTY at load — and a policy saved
// mid-session never engaged for that child's whole lifetime. pi's own cache
// refresh writes a full models-store.json ~1 s after spawn, but the extension
// never re-read it. Reproduced live: turn 2 of a persistent session, policy
// saved in between (order=[bogus], allow_fallbacks:false), turn SUCCEEDED —
// the provider object never reached OpenRouter. Later children regenerate
// models.json with modelOverrides and engaged — exactly the TE signature
// (first child never engaged, every other child did).
//
export default function (pi) {
  pi.on('before_provider_request', (event, ctx) => {
    try {
      const payload = event && event.payload
      if (!isRecord(payload) || typeof payload.model !== 'string') return undefined
      const model = ctx && ctx.model
      if (!model || model.provider !== 'openrouter') return undefined

      // brick c2df657e — explicit sticky-routing key, INDEPENDENT of the policy
      // below: affinity should hold whether or not any routing policy is in
      // force, and also when the settings file is unreadable. Top-level body
      // field, never inside provider. pi-ai's own header path
      // (compat.sendSessionAffinityHeaders) is deliberately NOT used: it keys
      // on pi's own session uuid, which changes on compaction/branching and
      // per resume — the record id is the stable key.
      const recordId = (process.env.ACPX_SESSION_RECORD_ID || '').trim().slice(0, 256)
      let next = payload
      if (recordId && payload.session_id !== recordId) {
        next = Object.assign({}, payload, { session_id: recordId })
      }

      const policy = readPolicy()
      if (policy === undefined) {
        // Unreadable file: no opinion on ROUTING — but the sticky key, if it
        // was added above, must still reach OpenRouter.
        return next === payload ? undefined : next
      }
      const resolved = resolveProviderObject(policy, payload.model)
      if (resolved) {
        return Object.assign({}, next, { provider: resolved })
      }
      // A valid policy that resolves to nothing for this model means no
      // routing is in force NOW — strip the spawn-time compat so a cleared
      // policy does not keep riding on models.json. (The sticky key, if
      // added, is preserved either way.)
      if (next.provider === undefined) return next === payload ? undefined : next
      const stripped = Object.assign({}, next)
      delete stripped.provider
      return stripped
    } catch {
      return undefined
    }
  })
}

// Test seam: the parity tests import this file directly (jiti loads it the
// same way pi does) and assert these mirrors agree with acpx's own resolver
// on a matrix of valid AND invalid policies.
export const testMirrors = { resolveProviderObject, policyIsValid, expandQuantizationFloor }
`;
