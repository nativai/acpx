// The OpenRouter model-rewrite shim, embedded as a string so it survives the
// tsdown bundle without a separate copy step. Written to a temp file at spawn
// time. Only responsibility: rewrite the `model` field in POST /v1/messages*
// requests from Claude Code's internal alias (e.g. claude-haiku-4-5-20251001)
// to the configured OpenRouter model id, then forward to openrouter.ai with
// the real API key injected. Reads config from env: OR_MODEL, OPENROUTER_API_KEY.
// On startup writes "PORT=<n>\n" to stdout so the caller learns the bound port.
export const OPENROUTER_SHIM_CODE = `
import http from 'node:http'
import https from 'node:https'

const API_KEY = process.env.OPENROUTER_API_KEY
const MODEL   = process.env.OR_MODEL
if (!API_KEY || !MODEL) {
  process.stderr.write('[or-shim] OPENROUTER_API_KEY and OR_MODEL are required\\n')
  process.exit(1)
}

const OR_HOST = 'openrouter.ai'
const OR_BASE = '/api/v1'

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    let body = Buffer.concat(chunks)
    if (req.method === 'POST' && req.url && req.url.startsWith('/v1/messages')) {
      try {
        const obj = JSON.parse(body.toString('utf8'))
        obj.model = MODEL
        body = Buffer.from(JSON.stringify(obj), 'utf8')
      } catch { /* leave body unchanged */ }
    }
    const fwdHeaders = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => k !== 'host')
    )
    fwdHeaders['host'] = OR_HOST
    fwdHeaders['authorization'] = 'Bearer ' + API_KEY
    fwdHeaders['content-length'] = String(body.length)
    const opts = {
      hostname: OR_HOST, port: 443,
      path: OR_BASE + (req.url ?? ''),
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
