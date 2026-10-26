/**
 * 本地聚合网关 —— 面向 Codex CLI 的统一入口。
 *
 * ## 定位
 *
 * 这个 app **自己就是完整网关**，不转发给任何外部服务：
 *
 * ```text
 *   Codex CLI ──▶ BaiUse ──▶ 车道层 ──▶ 各渠道
 *                  选路/重试/协议         渠道适配
 * ```
 *
 * ## 协议
 *
 * 对外只暴露 Codex CLI 需要的 OpenAI Responses 协议：
 *
 * - `GET  /v1/models`   —— 统一模型目录（渠道包 `provider/model` + 裸名车道）
 * - `POST /v1/responses` —— Responses 协议，支持流式与非流式
 *
 * 内部三条车道（渠道包 / Kilo / 聚合）的原生协议各不相同
 * （chat / messages / responses），由车道层抹平。
 *
 * ## Responses SSE 事件
 *
 * Codex CLI 只解析 Responses 的事件序列，所以这里**必须**产出：
 *
 * ```
 * response.created → response.output_item.added → response.output_text.delta
 * → response.output_item.done → response.completed
 * ```
 *
 * 工具调用走 `response.function_call_arguments.delta`，
 * 思考走 `response.reasoning_summary_text.delta`。
 */

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createFailoverComplete, isCodexClientRequest } from './failover.js'
import { CooldownLedger, SessionAffinity } from './route.js'
import { clientRoute, serveClientInference } from './clients/protocols.mjs'
import { DESKTOP_MODEL } from './clients/config.mjs'
import { createResponseAssembler } from './clients/responses.mjs'

/** 完整读取请求体；默认不加网关级大小截断，可按需显式传入字节上限。 */
function readBody(req, limitBytes = 0) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (limitBytes > 0 && size > limitBytes) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 把 Node 的 headers（值可能是 string[]）拍平成单值。 */
function flattenHeaders(nodeHeaders) {
  const headers = {}
  for (const [key, value] of Object.entries(nodeHeaders ?? {})) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

// Gemini's SDK accepts an API key query parameter as well as x-goog-api-key.
function urlKey(req) {
  return new URL(req.url ?? '/', 'http://localhost').searchParams.get('key')
}

/** 生成一个短的随机 id（OpenAI 风格）。 */
function shortId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}`
}

/**
 * 创建聚合网关。
 *
 * @param {object} options
 * @param {object} options.lanes       车道运行时（`src/lanes/index.js`）
 * @param {string} [options.apiKey]    本网关的 API Key；为空则不鉴权
 * @param {number} [options.port]      监听端口，默认 48760
 * @param {string} [options.host]      监听地址，默认 127.0.0.1（只绑回环）
 * @param {number} [options.maxAttempts] 单次请求最多尝试几条路，默认 4
 * @param {(req, res) => Promise<boolean>} [options.management] 管理接口处理器
 * @param {(info: object) => void} [options.onAttempt] 观测回调
 * @returns {Promise<{port: number, url: string, close: () => Promise<void>}>}
 */
export async function startGateway({
  lanes,
  apiKey = '',
  port = 48760,
  host = '127.0.0.1',
  maxAttempts,
  management,
  onAttempt,
  desktopModel = () => '',
}) {
  const cooldowns = new CooldownLedger()
  const affinity = new SessionAffinity()
  let desktopActivity = null

  /** 没有管理处理器时，管理路径一律 404。 */
  const managementHandler = management ?? (async (_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '管理接口未启用', type: 'not_found' } }))
    return true
  })

  /** 鉴权：给了 key 就要求 Bearer 匹配。 */
  const authorized = req => {
    if (apiKey === '') return true
    const header = req.headers.authorization ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    return (match !== null && match[1].trim() === apiKey)
      || req.headers['x-api-key'] === apiKey || req.headers['x-goog-api-key'] === apiKey
      || (urlKey(req) === apiKey)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const headers = flattenHeaders(req.headers)

    // ── 管理接口（账号、模型、设置） ──────────────────────────────────────
    // 它自己管鉴权（回环 + Bearer），所以放在推理接口的鉴权之前。
    if (url.pathname.startsWith('/api/')) {
      const handled = await managementHandler(req, res)
      if (handled) return
    }

    // ── 内置管理页面 ──────────────────────────────────────────────────────
    if (url.pathname === '/app' || url.pathname === '/app/') {
      await serveUi(res, 'index.html')
      return
    }
    if (url.pathname.startsWith('/app/')) {
      await serveUi(res, url.pathname.slice('/app/'.length))
      return
    }

    // ── 健康检查：免鉴权 ───────────────────────────────────────────────────
    if (url.pathname === '/health' || url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        service: 'codex-relay',
        codex: isCodexClientRequest(headers),
        lanes: {
          channels: lanes.channels?.providers ?? [],
          kilo: lanes.kiloModels?.length ?? 0,
          aggregate: lanes.aggregateCatalog().length,
        },
      }))
      return
    }

    // ── 模型目录 ──────────────────────────────────────────────────────────
    if (url.pathname === '/v1/models' || url.pathname === '/models' || url.pathname === '/claude-desktop/v1/models') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: '缺少或错误的 API Key', type: 'authentication_error' } }))
        return
      }
      const rows = url.pathname.startsWith('/claude-desktop/') ? (desktopModel() ? [{ id: DESKTOP_MODEL, type: 'model', display_name: desktopModel(), created_at: '2026-01-01T00:00:00Z' }] : []) : (lanes.clientModelRows?.() ?? lanes.modelRows())
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: rows, has_more: false, first_id: rows[0]?.id ?? null, last_id: rows.at(-1)?.id ?? null }))
      return
    }

    let nativeRoute
    try { nativeRoute = clientRoute(url.pathname) } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: '模型路径编码不合法' } }))
      return
    }
    if (nativeRoute) {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: '缺少或错误的 API Key' } }))
        return
      }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        if (!body || Array.isArray(body) || typeof body !== 'object') throw Object.assign(new Error('请求体应为 JSON 对象'), { status: 400 })
        const mappedModel = desktopModel()
        const ok = await serveClientInference({ req, res, route: nativeRoute, body, lanes, cooldowns, affinity, maxAttempts, onAttempt, headers, desktopModel: mappedModel })
        if (ok && nativeRoute.desktop && !nativeRoute.countTokens) desktopActivity = { at: new Date().toISOString(), model: mappedModel }
      } catch (error) {
        const raw = error.status ?? error.statusCode
        const status = error instanceof SyntaxError ? 400 : Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 502
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: status < 500 ? 'invalid_request_error' : 'api_error', message: error.message } }))
      }
      return
    }

    if (url.pathname !== '/v1/responses' && url.pathname !== '/responses') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `不支持的路径：${url.pathname}`, type: 'not_found' } }))
      return
    }

    // ── 推理端点 ──────────────────────────────────────────────────────────
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '缺少或错误的 API Key', type: 'authentication_error' } }))
      return
    }

    let body
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw.toString('utf8'))
    } catch (error) {
      res.writeHead(error.statusCode ?? 400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `请求体解析失败：${error.message}`, type: 'invalid_request_error' } }))
      return
    }

    const controller = new AbortController()
    req.once('aborted', () => controller.abort())
    res.once('close', () => controller.abort())

    const rows = lanes.modelRows()

    const complete = createFailoverComplete({
      baseComplete: async (routeRequest, onChunk) => {
        // 车道层把各家的原生协议都归一成 chunk。
        // `responses: true` 让渠道包用 `toResponsesGenerateOptions` 转换
        // （`input`/`instructions` → messages），Kilo/聚合本来就是 OpenAI 形态。
        return lanes.complete({
          model: routeRequest.model,
          body: body,
          responses: true,
        }, onChunk, controller.signal)
      },
      modelRows: async () => rows,
      cooldowns,
      affinity,
      maxAttempts,
      onAttempt,
    })

    const streaming = body.stream === true
    const responseId = shortId('resp')
    const createdAt = Math.floor(Date.now() / 1000)

    if (streaming) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
    }
    const assembled = createResponseAssembler({
      responseId, model: body.model, createdAt,
      emit: streaming ? (event, value) => writeSse(res, event, value) : undefined,
    })
    assembled.start()
    try {
      const result = await complete({ model: body.model, headers }, assembled.consume)
      const response = assembled.finish(result)
      if (streaming) {
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response))
      }
    } catch (error) {
      if (res.headersSent) {
        // 流已经开始：只能流内报错。客户端会看到 error 事件。
        writeSse(res, 'error', { type: 'error', message: error.message })
        res.end()
        return
      }
      // ⚠️ 状态码字段名有两个（`status` 与 `statusCode`）—— 不同来源的
      // 错误用不同的那个。容错读两个，免得「模型不存在」被当成 502。
      const raw = error.status ?? error.statusCode
      const status = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 502
      const type = error.errorType
        ?? (status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error')
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: { message: error.message, type, ...(error.code ? { code: error.code } : {}), param: null },
      }))
    }
  })

  await listenWithFallback(server, port, host)

  const actualPort = server.address().port
  return {
    port: actualPort,
    url: `http://${host === '::1' ? '[::1]' : host}:${actualPort}`,
    get desktopStatus() { return desktopActivity },
    close: () => new Promise(resolve => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    }),
  }
}

/**
 * 提供内置的管理页面。
 *
 * 只服务 `ui/` 目录下的文件，且**拒绝任何路径穿越**（`..`、绝对路径）。
 * 管理页面是纯静态的，不需要鉴权 —— 它自己调管理接口时会带 key。
 */
async function serveUi(res, relative) {
  const uiRoot = new URL('../ui/', import.meta.url)
  const target = new URL(relative === '' ? 'index.html' : relative, uiRoot)
  // 路径穿越防护：解析后的路径必须仍在 uiRoot 之内
  if (!target.href.startsWith(uiRoot.href)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('禁止访问')
    return
  }
  try {
    const content = await readFile(target)
    const type = target.pathname.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : target.pathname.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : target.pathname.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : target.pathname.endsWith('.svg') ? 'image/svg+xml'
          : target.pathname.endsWith('.png') ? 'image/png'
          : 'application/octet-stream'
    res.writeHead(200, { 'content-type': type })
    res.end(content)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('未找到')
  }
}

/** 写一条 SSE 事件。 */
function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}


/**
 * 监听端口；被占用时自动换一个空闲端口。
 *
 * ## 为什么不能直接报错
 *
 * 桌面 app 可能已经跑着一个（用户开了两次），或者用户自己占了 48760。
 * 直接失败等于「app 起不来」—— 而端口号对用户毫无价值，
 * 换个端口把服务起起来才是对的。
 *
 * 换到的端口会写回设置，下次启动优先用它。
 */
async function listenWithFallback(server, port, host) {
  const tryListen = candidate => new Promise((resolve, reject) => {
    const onError = error => { server.removeListener('listening', onListening); reject(error) }
    const onListening = () => { server.removeListener('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(candidate, host)
  })

  try {
    await tryListen(port)
    return server.address().port
  } catch (error) {
    if (error?.code !== 'EADDRINUSE' || port === 0) throw error
    // 让系统分配一个空闲端口
    await tryListen(0)
    return server.address().port
  }
}
