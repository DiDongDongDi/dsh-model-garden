/**
 * model-garden — host carrier + live cost endpoint.
 *
 * The main feature lives in the browser half (`./client.js`, declared via the
 * `dsh.client.platform: "web"` manifest field).
 *
 * This host half additionally serves a small same-origin JSON endpoint used by
 * the picker to show live per-task cost: it reads the REAL provider-reported
 * token usage persisted in the session log (`assistant/message` events carry
 * `usage: TokenUsage`) and sums it — the same approach OpenCode takes (real
 * usage x model price), in contrast to `tokenMeter.measure()` which only
 * returns a heuristic surface estimate.
 *
 *   GET /model-garden/cost?session=<sessionId>
 *   -> { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *        reasoningTokens, steps }
 *
 * @module model-garden
 */
import { createHmac, createHash } from 'node:crypto'

export const name = 'dsh-model-garden'
// Deliberately NO hard inject: profiles without a web stack (minimal or TUI
// profiles) never provide `webServer`, and a hard inject would park this
// fiber forever — dsh-app-boot fails the WHOLE boot when an entry never
// activates. Instead we mount immediately and (re)try route registration as
// services appear (see apply below). Services are read lazily via ctx.get().
export const inject = []

/**
 * Provider locality from the configured baseURL (`llm-pi-ai` settings
 * section). Providers without an explicit baseURL run on their catalog
 * default endpoint, i.e. the public cloud — not local.
 * Local means: loopback, RFC1918/link-local IP, single-label LAN hostname
 * (e.g. an internal gateway name), or a .local/.lan/.internal-style suffix.
 */
function isLocalBaseUrl(url) {
  if (typeof url !== 'string' || url === '') return false
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')) return true
  if (host.indexOf('.') === -1) return true // single-label LAN name
  if (/\.(local|lan|internal|home|corp)$/.test(host)) return true
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
  }
  return false
}

/** Read provider -> baseURL from the llm-pi-ai settings section. */
function providerBaseUrls(settings) {
  const map = {}
  if (settings === undefined) return map
  let section
  try {
    section = settings.get('llm-pi-ai')
  } catch {
    return map
  }
  const providers = section && typeof section === 'object' ? section.providers : undefined
  if (providers && typeof providers === 'object') {
    for (const id in providers) {
      const p = providers[id]
      if (p && typeof p === 'object' && typeof p.baseURL === 'string') map[id] = p.baseURL
    }
  }
  return map
}

/** Aggregate real provider usage for one session from its durable events. */
function aggregateUsage(events) {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let steps = 0
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (!ev || ev.type !== 'assistant/message') continue
      // Durable log events are enveloped: { type, seq, time, data: { usage } }.
      // Accept both the envelope and a flat { usage } shape.
      const usage = ev.usage !== undefined
        ? ev.usage
        : (ev.data && typeof ev.data === 'object' ? ev.data.usage : undefined)
      if (!usage || typeof usage !== 'object') continue
      steps += 1
      inputTokens += typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
      outputTokens += typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
      cacheReadTokens += typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
      cacheWriteTokens += typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0
      reasoningTokens += typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0
    }
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    steps,
  }
}

/**
 * Per-step session cost history with model attribution.
 *
 * `assistant/message` events carry usage but NOT the model. The model in
 * effect is tracked from `request/context` ({ provider, model }) and
 * `request/header` ({ header: { config: { provider, model } } }) events,
 * which precede the request they describe. Every usage step is attributed
 * to the most recent config seen before it — a single pass over the same
 * in-memory event array `/cost` uses, no extra persistence.
 *
 * -> { steps: [newest first, capped], models: [per-model aggregates], totalSteps }
 */
function buildHistory(events, limit) {
  let provider = null
  let model = null
  const steps = []
  const models = {}
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (!ev) continue
      const data = ev.data && typeof ev.data === 'object' ? ev.data : undefined
      if (ev.type === 'request/context' || ev.type === 'request/header') {
        let cfg = null
        if (ev.type === 'request/context') cfg = data
        else if (data && data.header && data.header.config) cfg = data.header.config
        if (cfg && typeof cfg.model === 'string') {
          model = cfg.model
          provider = typeof cfg.provider === 'string' ? cfg.provider : provider
        }
        continue
      }
      if (ev.type !== 'assistant/message' || !data) continue
      const usage = data.usage !== undefined ? data.usage : ev.usage
      if (!usage || typeof usage !== 'object') continue
      // Never drop usage: steps before the first request/context (or in
      // logs without any) are counted under "unknown" so the totals always
      // match /cost instead of silently shrinking.
      const entry = {
        time: typeof ev.time === 'number' ? ev.time : 0,
        provider: provider || '?',
        model: model === null ? 'unknown' : model,
        turn: typeof data.turn === 'number' ? data.turn : undefined,
        step: typeof data.step === 'number' ? data.step : undefined,
        inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
        outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
        cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0,
        cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0,
        reasoningTokens: typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0,
      }
      steps.push(entry)
      const key = entry.provider + '::' + entry.model
      const agg = models[key] || (models[key] = {
        provider: entry.provider, model: entry.model,
        steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      })
      agg.steps += 1
      agg.inputTokens += entry.inputTokens
      agg.outputTokens += entry.outputTokens
      agg.cacheReadTokens += entry.cacheReadTokens
      agg.cacheWriteTokens += entry.cacheWriteTokens
    }
  }
  const max = Math.min(Math.max(1, limit || 40), 200)
  return { steps: steps.slice(-max).reverse(), models: Object.values(models), totalSteps: steps.length }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

/**
 * Model capability catalog straight from the host `llm` service
 * (adapter-owned data, works for local providers too — models.dev only
 * covers the public hosted ones). Cached briefly because
 * `resolveModelInfo` may perform adapter-owned lookups per model.
 *
 *   GET /model-garden/catalog
 *   -> { "provider::model": { context?, maxOutput? } }
 */
const CATALOG_TTL = 600000 // rebuild at most every 10 minutes
let catalogCache = null
let catalogAt = 0
let catalogInflight = null

async function buildCatalog(llm, settings) {
  const out = {}
  // Mirrored internal routes (the vision toolkit duplicates every provider as
  // "vision-toolkit-<provider>" for its own routing) are skipped: they are
  // hidden in the picker, so resolving their ~180 models would be pure waste.
  const SKIP_PREFIXES = ['vision-toolkit-']
  const baseUrls = providerBaseUrls(settings)
  const providers = llm.listProviders()
  await Promise.all((Array.isArray(providers) ? providers : []).map(async (p) => {
    if (!p || typeof p.id !== 'string') return
    if (SKIP_PREFIXES.some((s) => p.id.indexOf(s) === 0)) return
    // Provider-level locality: every model entry inherits it, so the client's
    // "Local" tag/filter reflects the real endpoint, not price availability.
    const local = isLocalBaseUrl(baseUrls[p.id])
    let models = []
    try {
      models = await llm.listModels(p.id)
    } catch {
      return
    }
    await Promise.all((Array.isArray(models) ? models : []).map(async (m) => {
      if (!m || typeof m.id !== 'string') return
      const entry = { local }
      try {
        const info = await llm.resolveModelInfo(p.id, m.id)
        const cw = info && info.context && info.context.contextWindow
        if (typeof cw === 'number') entry.context = cw
        if (info && typeof info.defaultMaxTokens === 'number') entry.maxOutput = info.defaultMaxTokens
      } catch {
        // one unresolvable model must not sink the catalog
      }
      out[p.id + '::' + m.id] = entry
    }))
  }))
  return out
}

async function getCatalog(llm, settings) {
  if (catalogCache !== null && (Date.now() - catalogAt) < CATALOG_TTL) return catalogCache
  if (catalogInflight !== null) return catalogInflight
  catalogInflight = buildCatalog(llm, settings)
    .then((map) => {
      catalogCache = map
      catalogAt = Date.now()
      catalogInflight = null
      return map
    })
    .catch((err) => {
      catalogInflight = null
      if (catalogCache !== null) return catalogCache // stale beats nothing
      throw err
    })
  return catalogInflight
}

/* ------------------------------------------------------------------ *
 * Tencent Cloud TokenHub "Token Plan" balance — host side.
 *
 * One same-origin route the picker polls for the monthly credit (积分)
 * balance of the Tencent Cloud Token Plan subscription behind
 * `api.lkeap.cloud.tencent.com/plan/v3`.
 *
 * Credentials come from the process environment ONLY — never from the
 * browser. When TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY are
 * missing the route answers { enabled: false } and the picker simply
 * hides the badge; nothing else changes.
 *
 *   GET /model-garden/tokenplan
 *   -> { enabled, plan?: { teamId, name, productType, status, stopReason,
 *        unit, totalQuota, totalUsed, cycleQuota, cycleStartTime,
 *        cycleEndTime, expireTime }, error? }
 * ------------------------------------------------------------------ */
const TOKENHUB_HOST = 'tokenhub.tencentcloudapi.com'
const TOKENHUB_SERVICE = 'tokenhub'
const TOKENHUB_VERSION = '2026-03-22'
const TOKENHUB_REGION = 'ap-guangzhou'

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function hmac(key, text) {
  return createHmac('sha256', key).update(text, 'utf8').digest('hex')
}

/** Sign a Tencent Cloud JSON POST (API 3.0 / TC3-HMAC-SHA256). */
function tc3Headers(secretId, secretKey, action, payload) {
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const body = JSON.stringify(payload === undefined ? {} : payload)
  const ct = 'application/json; charset=utf-8'

  // Canonical headers are lower-cased. Host is part of the signature but is
  // NOT sent as a header — undici/Node forbids a manual host header.
  const canonicalHeaders =
    'content-type:' + ct + '\n' +
    'host:' + TOKENHUB_HOST + '\n' +
    'x-tc-action:' + action.toLowerCase() + '\n'
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalRequest =
    'POST\n/\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + sha256Hex(body)

  const credentialScope = date + '/' + TOKENHUB_SERVICE + '/tc3_request'
  const stringToSign =
    'TC3-HMAC-SHA256\n' + timestamp + '\n' + credentialScope + '\n' + sha256Hex(canonicalRequest)

  const kDate = hmac('TC3' + secretKey, date)
  const kService = hmac(kDate, TOKENHUB_SERVICE)
  const kSigning = hmac(kService, 'tc3_request')
  const signature = hmac(kSigning, stringToSign)

  return {
    'content-type': ct,
    'x-tc-action': action,
    'x-tc-timestamp': String(timestamp),
    'x-tc-version': TOKENHUB_VERSION,
    'x-tc-region': TOKENHUB_REGION,
    authorization: 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + credentialScope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
  }
}

async function tc3Post(secretId, secretKey, action, payload) {
  const resp = await fetch('https://' + TOKENHUB_HOST + '/', {
    method: 'POST',
    headers: tc3Headers(secretId, secretKey, action, payload),
    body: JSON.stringify(payload === undefined ? {} : payload),
  })
  const text = await resp.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('tokenhub non-JSON response (' + resp.status + '): ' + text.slice(0, 200))
  }
  const err = json && json.Response && json.Response.Error
  if (!resp.ok || err) {
    throw new Error(err ? (err.Code + ': ' + err.Message) : ('HTTP ' + resp.status))
  }
  return json.Response || json
}

/** DescribeTokenPlanList + DescribeTokenPlan round trip → balance digest. */
async function tokenPlanBalance(secretId, secretKey) {
  const list = await tc3Post(secretId, secretKey, 'DescribeTokenPlanList', { Limit: 20 })
  const set = Array.isArray(list.TokenPlanSet) ? list.TokenPlanSet : []
  if (set.length === 0) return { enabled: true, reason: 'no-token-plan' }
  const first = set[0]
  const detail = await tc3Post(secretId, secretKey, 'DescribeTokenPlan', { TeamId: first.TeamId })
  const pkg = detail.PackageInfo && typeof detail.PackageInfo === 'object' ? detail.PackageInfo : {}
  const summary = detail.TokenSummary && typeof detail.TokenSummary === 'object' ? detail.TokenSummary : {}
  const productType = typeof first.ProductType === 'string' ? first.ProductType : ''
  // 通用/专业套餐按积分（credits）计，*auto/轻享套餐按 token 计。
  const unit = /auto/i.test(productType) ? 'tokens' : 'credits'
  return {
    enabled: true,
    plan: {
      teamId: typeof first.TeamId === 'string' ? first.TeamId : undefined,
      name: typeof first.Name === 'string' ? first.Name : undefined,
      productType: productType || undefined,
      status: typeof first.Status === 'string' ? first.Status : undefined,
      stopReason: typeof first.StopReason === 'string' ? first.StopReason : undefined,
      unit,
      totalQuota: pkg.TotalQuota,
      totalUsed: pkg.TotalUsed,
      cycleQuota: pkg.CycleQuota,
      cycleStartTime: summary.CycleStartTime,
      cycleEndTime: summary.CycleEndTime,
      expireTime: pkg.ExpireTime,
    },
  }
}

/**
 * Host apply: register the live-cost and catalog routes. Kept minimal and
 * side-effect free otherwise; disposable via ctx.effect.
 *
 * Timing: this fiber can mount before the web stack provides `webServer`.
 * Rather than blocking boot on a hard inject (which minimal profiles never
 * satisfy), we retry on every `internal/service` event until the routes are
 * registered once. In profiles without any web stack the plugin simply
 * stays inert.
 *
 * @param ctx - host cordis context.
 */
export function apply(ctx) {
  let mounted = false
  const mount = () => {
    if (mounted) return
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    mounted = true
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/cost',
      handler: (req, res) => {
        const url = new URL(req.url ?? '', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('session')
        if (!sessionId) return writeJson(res, 400, { error: 'missing session' })
        const sessions = ctx.get('sessions')
        const session = sessions === undefined ? undefined : sessions.get(sessionId)
        if (!session) return writeJson(res, 404, { error: 'session not found' })
        try {
          const events = session.events !== undefined ? session.events : []
          const usage = aggregateUsage(events)
          writeJson(res, 200, usage)
        } catch (err) {
          writeJson(res, 500, { error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'model-garden: /model-garden/cost route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/catalog',
      handler: (req, res) => {
        const llm = ctx.get('llm')
        if (llm === undefined) return writeJson(res, 503, { error: 'llm service unavailable' })
        getCatalog(llm, ctx.get('settings'))
          .then((map) => writeJson(res, 200, map))
          .catch((err) => writeJson(res, 500, { error: String(err && err.message ? err.message : err) }))
      },
    }), 'model-garden: /model-garden/catalog route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/cost-history',
      handler: (req, res) => {
        const url = new URL(req.url ?? '', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('session')
        if (!sessionId) return writeJson(res, 400, { error: 'missing session' })
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '40', 10)
        const sessions = ctx.get('sessions')
        const session = sessions === undefined ? undefined : sessions.get(sessionId)
        if (!session) return writeJson(res, 404, { error: 'session not found' })
        try {
          const events = session.events !== undefined ? session.events : []
          writeJson(res, 200, buildHistory(events, Number.isFinite(limit) ? limit : 40))
        } catch (err) {
          writeJson(res, 500, { error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'model-garden: /model-garden/cost-history route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/tokenplan',
      handler: async (req, res) => {
        const secretId = process.env.TENCENTCLOUD_SECRET_ID
        const secretKey = process.env.TENCENTCLOUD_SECRET_KEY
        if (!secretId || !secretKey) {
          return writeJson(res, 200, { enabled: false, reason: 'credentials-not-configured' })
        }
        try {
          writeJson(res, 200, await tokenPlanBalance(secretId, secretKey))
        } catch (err) {
          writeJson(res, 200, { enabled: true, error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'model-garden: /model-garden/tokenplan route')
  }
  mount()
  // `internal/service` fires whenever any service is provided; the listener
  // is fiber-scoped and disappears with the plugin.
  ctx.on('internal/service', (name) => {
    if (name === 'webServer') mount()
  })
}
