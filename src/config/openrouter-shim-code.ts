// The OpenRouter model-rewrite shim, embedded as a string so it survives the
// tsdown bundle without a separate copy step. Written to a temp file at spawn
// time. Responsibilities:
//   1. POST /v1/messages* — rewrite the `model` field from Claude Code's
//      internal alias (e.g. claude-opus-4-8[1m]) to the configured OR model id,
//      then forward to openrouter.ai with the real API key injected.
//   2. GET /v1/models — return a fake Anthropic-format models list containing
//      common Claude aliases so Claude Code's local model-validation passes
//      even though ANTHROPIC_BASE_URL points here instead of Anthropic.
//   3. Apply the box's PROVIDER-ROUTING policy (brick 4c272cab): `OR_PROVIDER`
//      carries a pre-resolved OpenRouter `provider` object, copied verbatim onto
//      the forwarded body. Absent ⇒ nothing is added and the body is
//      byte-identical to before that brick.
//   4. Record WHO SERVED the turn (brick 4c272cab §8): one NDJSON line per
//      response to `OR_ATTRIBUTION_LOG`, sniffed off the response head without
//      buffering it.
//   5. Drop per-message `output_config` (per-turn effort) that OpenRouter rejects
//      for non-Anthropic providers (brick 92121ff9); top-level effort is kept.
// Reads config from env: OR_MODEL, OPENROUTER_API_KEY, OR_REASONING_EFFORT,
// OR_PROVIDER, OR_ATTRIBUTION_LOG, OR_UPSTREAM_HOST.
// On startup writes "PORT=<n>\n" to stdout so the caller learns the bound port.
export const OPENROUTER_SHIM_CODE = `
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'

const API_KEY           = process.env.OPENROUTER_API_KEY
const MODEL             = process.env.OR_MODEL
const REASONING_EFFORT  = process.env.OR_REASONING_EFFORT || null
const ATTRIBUTION_LOG   = process.env.OR_ATTRIBUTION_LOG || null
if (!API_KEY || !MODEL) {
  process.stderr.write('[or-shim] OPENROUTER_API_KEY and OR_MODEL are required\\n')
  process.exit(1)
}

// The box's provider-routing policy, already resolved and validated by acpx
// (src/acp/openrouter-provider-policy.ts). A MALFORMED VALUE DEGRADES TO "no
// policy" AND MUST NOT JOIN THE process.exit(1) ABOVE: a settings typo would
// then present as a broken OpenRouter credential, three screens from its cause.
let PROVIDER = null
try {
  PROVIDER = process.env.OR_PROVIDER ? JSON.parse(process.env.OR_PROVIDER) : null
} catch {
  PROVIDER = null
  process.stderr.write('[or-shim] OR_PROVIDER is not valid JSON; continuing with no provider policy\\n')
}

// TEST-ONLY UPSTREAM OVERRIDE (HoD ruling R-5). The shim is the only component
// that sees the body OpenRouter actually receives, and it used to hardcode its
// host — so the Claude path could only ever be checked by INFERENCE from the
// reply. Pointing this at a capture server is what makes "the correct provider
// object reached OpenRouter" an assertion rather than a belief. A bare host
// keeps https (production, unchanged); a full origin lets a test use http.
const UPSTREAM = (() => {
  const raw = (process.env.OR_UPSTREAM_HOST || 'openrouter.ai').trim()
  return new URL(raw.includes('://') ? raw : 'https://' + raw)
})()
const OR_HOST = UPSTREAM.host
const OR_TRANSPORT = UPSTREAM.protocol === 'http:' ? http : https
const OR_PORT = UPSTREAM.port || (UPSTREAM.protocol === 'http:' ? 80 : 443)
const OR_BASE = '/api/v1'

// One NDJSON line per upstream response: WHO ACTUALLY SERVED IT.
//
// ⚠️ THE PREFERRED PROVIDER IS NOT AN ANSWER HERE. A preference is a preference
// and the named provider is routinely unavailable (measured: BaseTen and Crusoe
// both hard-429 for a whole afternoon), so recording the policy's first choice
// would make the feature un-falsifiable. No line is written when the response
// names no provider — absence reads as "not recorded".
//
// ⚠️ MEASURED 2026-09-10, AND IT EXPLAINS A NULL YOU WILL BE TEMPTED TO "FIX":
// this shim forwards to OpenRouter's ANTHROPIC-COMPATIBLE endpoint
// (POST /api/v1/messages), whose streamed response carries the provider in
// message_start ("provider":"Parasail") — which is why the head sniff below is
// enough — but carries NO native_finish_reason field at all. Its stop reason is
// Anthropic's own normalised "stop_reason" ("max_tokens", "end_turn").
// 🛑 DO NOT MAP stop_reason ONTO native_finish_reason. They are different
// quantities: one is Anthropic's normalisation, the other the upstream
// provider's raw string, and putting the first under the second's name is the
// two-things-one-name defect this file already carries a warning about
// elsewhere. On this path the honest value is null; the provider's own reason is
// reachable via GET /api/v1/generation?id=<gen_id>, which is recorded below.
//
// 🛑 **WRITTEN AS SOON AS THE PROVIDER IS SEEN — NOT AT upstream 'end' — AND
// THAT ORDERING IS THE WHOLE FIX FOR TE FINDING F-3.** Writing at 'end' lost a
// race that only exists in the PRODUCTION shape: on a streamed response the SDK
// acts on the final SSE event the moment it arrives, so acpx's usage_update (and
// its read of this log) can happen BEFORE the upstream HTTP stream ends and this
// line is written. Measured by the test engineer 3/3 against real OpenRouter —
// first turn recorded as null with the provider sitting correctly in this file —
// local non-streamed capture server won the race every time and both lanes' rigs
// therefore saw nothing.
//
// The provider arrives in the FIRST SSE event (message_start), so recording on
// the first matching chunk puts the line on disk before the turn can possibly
// finish, and the race is closed at the source rather than compensated for.
//
// ⚠️ CONSEQUENCE, ACCEPTED: a turn that dies mid-stream still records the
// provider that was serving it. That is the truthful answer to "who served this
// turn" and is more useful than silence on exactly the turns that go wrong.
const ATTRIBUTION_SNIFF_BYTES = 4096

/** True once a line has been written, so the caller stops sniffing. */
function recordAttribution(head) {
  if (!ATTRIBUTION_LOG) { return false }
  try {
    const provider = /"provider"\\s*:\\s*"([^"]+)"/.exec(head)
    if (!provider) { return false }
    const native = /"native_finish_reason"\\s*:\\s*"([^"]+)"/.exec(head)
    const genId = /"id"\\s*:\\s*"([^"]+)"/.exec(head)
    fs.appendFileSync(ATTRIBUTION_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      provider: provider[1],
      model: MODEL,
      native_finish_reason: native ? native[1] : null,
      gen_id: genId ? genId[1] : null,
    }) + '\\n')
    return true
  } catch { /* attribution is enrichment; it may never cost a turn */ }
  return false
}

// Fake models list: contains all common Claude aliases so Claude Code's model
// validation passes when ANTHROPIC_BASE_URL points to this shim. The actual
// model sent to OpenRouter is always OR_MODEL (rewritten in POST /v1/messages).
const CLAUDE_MODEL_IDS = [
  'claude-opus-4-8','claude-opus-4-8[1m]','claude-opus-4-7','claude-opus-4-7[1m]',
  'claude-opus-4','claude-opus-4[1m]',
  'claude-sonnet-4-6','claude-sonnet-4-6[1m]','claude-sonnet-4-5','claude-sonnet-4-5[1m]',
  'claude-sonnet-4','claude-sonnet-4[1m]',
  'claude-haiku-4-5','claude-haiku-4-5-20251001','claude-haiku-4',
  'claude-3-7-sonnet-20250219','claude-3-5-sonnet-20241022','claude-3-5-haiku-20241022',
  'claude-3-opus-20240229','claude-3-sonnet-20240229','claude-3-haiku-20240307',
  'opus','sonnet','haiku','opus[1m]','sonnet[1m]',
]
const FAKE_MODELS_RESPONSE = JSON.stringify({
  data: CLAUDE_MODEL_IDS.map(id => ({
    id, display_name: id, created_at: '2025-01-01T00:00:00Z', type: 'model',
  })),
  has_more: false,
  first_id: CLAUDE_MODEL_IDS[0],
  last_id: CLAUDE_MODEL_IDS[CLAUDE_MODEL_IDS.length - 1],
})

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    // Intercept GET /v1/models — return fake Claude models list so validation passes.
    if (req.method === 'GET' && req.url && req.url.startsWith('/v1/models')) {
      const buf = Buffer.from(FAKE_MODELS_RESPONSE, 'utf8')
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(buf.length) })
      res.end(buf)
      return
    }

    let body = Buffer.concat(chunks)
    // Map /v1/* → /api/v1/* (OR_BASE already contains /api/v1).
    // Strip query string from /v1/messages requests — OpenRouter doesn't
    // accept Anthropic beta params (?beta=true etc).
    const rawPath = req.url ?? '/'
    let fwdPath = rawPath.startsWith('/v1/') ? rawPath.slice(3) : rawPath
    if (req.method === 'POST' && fwdPath.startsWith('/messages')) {
      fwdPath = '/messages'  // drop query string
      try {
        const obj = JSON.parse(body.toString('utf8'))
        // Rewrite model to the configured OR model.
        obj.model = MODEL
        // Apply the box's provider-routing policy. One line, beside the model
        // rewrite, because that is the same question asked about a different
        // axis: the model says WHAT serves the turn, this says WHO.
        if (PROVIDER) { obj.provider = PROVIDER }
        // Inject static reasoning effort when configured on the profile.
        if (REASONING_EFFORT) { obj.reasoning = { effort: REASONING_EFFORT } }
        // Inject an identity override so the model self-identifies by its real
        // OR model name instead of following the Claude identity system prompt.
        const identityOverride = { type: 'text', text: '[IDENTITY] Your actual model id is ' + MODEL + '. When asked what model or AI you are, always answer: "' + MODEL + '".' }
        if (Array.isArray(obj.system)) {
          obj.system.push(identityOverride)
        } else if (typeof obj.system === 'string') {
          obj.system = [{ type: 'text', text: obj.system }, identityOverride]
        } else {
          obj.system = [identityOverride]
        }
        // Stabilise the per-request 'cch=<hash>' token Claude Code injects into the
        // system billing-header block. It changes every request and, sitting inside
        // the cache_control-marked prefix, defeats prompt caching on exact-match
        // providers (OpenRouter -> DeepSeek). Normalising it makes the cached prefix
        // byte-stable so caching engages. Harmless to Anthropic (which already caches).
        if (Array.isArray(obj.system)) {
          for (const blk of obj.system) {
            if (blk && typeof blk.text === 'string' && blk.text.indexOf('cch=') !== -1) {
              blk.text = blk.text.replace(/cch=[0-9a-f]+/g, 'cch=stable')
            }
          }
        }
        // Strip PER-MESSAGE output_config (per-turn effort). OpenRouter calls it a
        // "configuration_update" and 400s it for every non-Anthropic provider, and
        // the CLI cannot recover from that wording (brick 92121ff9). acpx already
        // turns the capability off (OPENROUTER_DISABLED_CLAUDE_CAPABILITIES in
        // auth-env.ts); this catches a future CLI shipping it under a name that
        // list does not cover.
        // ⚠️ THE TOP-LEVEL obj.output_config STAYS: it carries the user's selected
        // effort at conversation level, which these models do accept.
        if (Array.isArray(obj.messages)) {
          for (const msg of obj.messages) {
            if (msg && typeof msg === 'object') { delete msg.output_config }
          }
        }
        // Strip extended-thinking / computer-use fields that GPT models don't support.
        delete obj.thinking
        delete obj.betas
        if (Array.isArray(obj.tools)) {
          obj.tools = obj.tools.filter((t) => t && t.type !== 'computer_20241022')
          if (obj.tools.length === 0) delete obj.tools
        }
        body = Buffer.from(JSON.stringify(obj), 'utf8')
      } catch { /* leave body unchanged */ }
    }
    const fwdHeaders = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => k !== 'host')
    )
    fwdHeaders['host'] = OR_HOST
    fwdHeaders['authorization'] = 'Bearer ' + API_KEY
    fwdHeaders['content-length'] = String(body.length)
    // Remove Anthropic-specific beta headers — OpenRouter handles versioning itself.
    delete fwdHeaders['anthropic-beta']
    const opts = {
      hostname: UPSTREAM.hostname, port: OR_PORT,
      path: OR_BASE + fwdPath,
      method: req.method ?? 'GET',
      headers: fwdHeaders,
    }
    const fwd = OR_TRANSPORT.request(opts, upstream => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers)
      // ⚠️ SNIFF, DO NOT BUFFER. The body is piped through untouched; this
      // listener only reads the HEAD of the stream (both the non-streamed JSON
      // and the SSE prologue both carry provider and id there). Buffering the
      // response to inspect it would add latency to every turn and risk
      // breaking streaming — the one thing this shim must never do.
      let head = ''
      let recorded = false
      upstream.on('data', chunk => {
        if (recorded || head.length >= ATTRIBUTION_SNIFF_BYTES) { return }
        head += chunk.toString('utf8')
        // The instant the provider is readable, not when the stream ends (F-3).
        recorded = recordAttribution(head)
      })
      // Only for a response whose provider was never visible in the head — the
      // sniff is bounded, so this is the "we never saw one" leg, not the normal path.
      upstream.on('end', () => { if (!recorded) { recorded = recordAttribution(head) } })
      upstream.pipe(res)
    })
    fwd.on('error', err => {
      if (!res.headersSent) res.writeHead(502)
      res.end(err.message)
    })
    fwd.write(body)
    fwd.end()
  })
})

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 0
server.listen(port, '127.0.0.1', () => {
  const addr = server.address()
  const bound = typeof addr === 'object' && addr ? addr.port : port
  process.stdout.write('PORT=' + bound + '\\n')
})
`.trim();
