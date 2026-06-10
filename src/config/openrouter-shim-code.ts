// The OpenRouter model-rewrite shim, embedded as a string so it survives the
// tsdown bundle without a separate copy step. Written to a temp file at spawn
// time. Responsibilities:
//   1. POST /v1/messages* — rewrite the `model` field from Claude Code's
//      internal alias (e.g. claude-opus-4-8[1m]) to the configured OR model id,
//      then forward to openrouter.ai with the real API key injected.
//   2. GET /v1/models — return a fake Anthropic-format models list containing
//      common Claude aliases so Claude Code's local model-validation passes
//      even though ANTHROPIC_BASE_URL points here instead of Anthropic.
// Reads config from env: OR_MODEL, OPENROUTER_API_KEY.
// On startup writes "PORT=<n>\n" to stdout so the caller learns the bound port.
export const OPENROUTER_SHIM_CODE = `
import http from 'node:http'
import https from 'node:https'

const API_KEY           = process.env.OPENROUTER_API_KEY
const MODEL             = process.env.OR_MODEL
const REASONING_EFFORT  = process.env.OR_REASONING_EFFORT || null
if (!API_KEY || !MODEL) {
  process.stderr.write('[or-shim] OPENROUTER_API_KEY and OR_MODEL are required\\n')
  process.exit(1)
}

const OR_HOST = 'openrouter.ai'
const OR_BASE = '/api/v1'

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
      hostname: OR_HOST, port: 443,
      path: OR_BASE + fwdPath,
      method: req.method ?? 'GET',
      headers: fwdHeaders,
    }
    const fwd = https.request(opts, upstream => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers)
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
