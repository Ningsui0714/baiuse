/**
 * 渠道运行时（主线程侧）—— 管理 Worker，负责请求转发、模型目录与账号池 RPC。
 *
 * ## 这个模块管什么
 *
 * 只管**渠道包**（12 家账号渠道）这一条车道：
 *
 *  - `provider/model` 命名空间的模型目录
 *  - 账号池 RPC（增删、启停、排序、备份恢复）
 *  - 补全请求转发
 *
 * 另外两条车道（Kilo 免密、聚合）不走 Worker —— 它们没有账号池，
 * 在 `src/lanes/index.js` 里直接调 `vendor/lanes/` 下的实现。
 *
 * 三条车道的模型 id 形态不同（渠道包是 `provider/model`，其余是裸名），
 * 网关按前缀区分，因此路由层能直接算出候选集。
 *
 * ## 与上游的差异
 *
 * dsh-our-free-model 的对应实现还要管 EAC 共付车道与免费聚合线的目录合并；
 * 这两条车道都已下线（见 `vendor/channels/business.mjs` 与
 * `src/channels/worker.mjs` 的说明），所以这里只保留渠道包这一条。
 */

import path from 'node:path'
import { Worker } from 'node:worker_threads'

/**
 * 创建渠道运行时。
 *
 * @param {object} options
 * @param {string} options.dataDir 数据目录（凭据、账号池落在这里）
 * @param {object} [options.logger]
 * @returns {Promise<object>} 运行时句柄
 */
export async function createChannelRuntime({ dataDir, logger = console }) {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
    workerData: { dataDir },
    execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
    env: {
      ...process.env,
      // 上游用它放 CodeArts 的签名缓存；本 app 用自己的目录，避免与插件实例串。
      OFM_CODEARTS_CACHE_DIR: path.join(dataDir, 'channel-pack', 'codearts-cache'),
    },
  })

  const pending = new Map()
  let sequence = 0
  let closed = false
  let closing
  let finishClose
  let failed
  let readyResolve
  let readyReject
  let rows = []
  let providers = []
  let refreshing
  let refreshTimer

  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })

  const rejectAll = error => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  worker.on('message', message => {
    switch (message.type) {
      case 'ready':
        providers = message.providers
        readyResolve()
        return
      case 'log':
        logger[message.level === 'error' ? 'error' : message.level]?.(`[渠道] ${message.message}`)
        return
      case 'changed':
        void runtime.refresh().catch(() => {})
        return
      case 'chunk': {
        pending.get(message.id)?.onChunk?.(message.chunk)
        return
      }
      case 'result': {
        pending.get(message.id)?.resolve(message.value)
        pending.delete(message.id)
        return
      }
      case 'error': {
        const entry = pending.get(message.id)
        pending.delete(message.id)
        if (entry === undefined) return
        const error = Object.assign(new Error(message.message), { statusCode: message.statusCode })
        entry.reject(error)
        return
      }
      case 'closed':
        finishClose?.()
        return
      default:
    }
  })

  worker.on('error', error => {
    failed = error
    readyReject(error)
    rejectAll(error)
  })

  worker.on('exit', code => {
    if (closed) return
    const error = new Error(`渠道进程意外退出（code ${code}）`)
    failed = error
    readyReject(error)
    rejectAll(error)
  })

  /** 向 Worker 发一个请求并等待结果。 */
  function call(type, payload, signal, onChunk, timeoutMs = 30 * 60000) {
    if (closed || failed) return Promise.reject(failed ?? new Error('渠道已停止'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('请求已取消'))

    const id = ++sequence
    return new Promise((resolve, reject) => {
      const finish = fn => value => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        pending.delete(id)
        fn(value)
      }
      const abort = () => {
        worker.postMessage({ type: 'cancel', id })
        entry.reject(signal?.reason ?? new Error('渠道请求超时或已取消'))
      }
      const timer = setTimeout(abort, timeoutMs)
      timer.unref?.()
      const entry = { resolve: finish(resolve), reject: finish(reject), onChunk }
      pending.set(id, entry)
      signal?.addEventListener('abort', abort, { once: true })
      worker.postMessage({ type, id, ...payload })
    })
  }

  function refresh() {
    if (refreshing) return refreshing
    refreshing = call('models')
      .then(value => { rows = value; return rows })
      .finally(() => { refreshing = undefined })
    return refreshing
  }

  const runtime = {
    get providers() { return providers },
    state() { return { state: failed ? 'failed' : 'ready', error: failed ? failed.message : '' } },
    publicModelRows: () => rows,
    refresh,

    /** 这个模型是否归渠道包管（`provider/model` 形态）。 */
    handles: model => providers.some(provider => model.startsWith(`${provider}/`)),

    /** 管理 RPC：账号增删、启停、排序、备份恢复。 */
    async rpc(body, signal) {
      if (typeof body?.method !== 'string' || !Object.hasOwn(body, 'payload')) {
        throw Object.assign(new Error('渠道请求缺少 method 或 payload'), { statusCode: 400 })
      }
      return call('rpc', { call: { method: body.method, payload: body.payload } }, signal, undefined, 10 * 60000)
    },

    /**
     * 跑一轮补全。
     *
     * @param {object} request `{model, responses?, responsesBody?, openAi?, messages?, tools?, ...}`
     * @param {(chunk: object) => void} onChunk
     * @returns {Promise<object>} `{text, toolCalls, usage?, truncated?, error?}`
     */
    async complete(request, onChunk) {
      const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
      const { signal, ...wire } = request
      await call('complete', { request: wire }, signal, chunk => {
        foldChunk(outcome, chunk)
        onChunk?.(chunk)
      })
      return outcome
    },

    close() {
      if (closing) return closing
      closed = true
      clearTimeout(refreshTimer)
      rejectAll(new Error('渠道正在停止'))
      closing = (async () => {
        let timer
        await new Promise(resolve => {
          finishClose = resolve
          worker.postMessage({ type: 'close' })
          timer = setTimeout(resolve, 1500)
        })
        clearTimeout(timer)
        await worker.terminate()
      })()
      return closing
    },
  }

  try {
    const timeout = setTimeout(() => readyReject(new Error('渠道初始化超时')), 30000)
    try { await ready } finally { clearTimeout(timeout) }
    runtime.ready = refresh().catch(error => {
      if (!closed) logger.warn?.(`渠道启动清单刷新失败：${error.message}`)
    })
    return runtime
  } catch (error) {
    await runtime.close()
    throw error
  }
}

/**
 * 把一个 chunk 折叠进结果。
 *
 * 与上游 `src/core/completion.js` 的 `foldForwardOutcome` 同义，但这里只保留
 * 网关真正用到的部分：正文、工具调用、usage、结束原因。
 */
function foldChunk(outcome, chunk) {
  switch (chunk?.type) {
    case 'text-delta':
      outcome.text += chunk.text ?? ''
      return
    case 'tool-call-delta': {
      const slot = outcome.toolCalls.find(entry => entry.index === chunk.index)
      if (slot === undefined) {
        outcome.toolCalls.push({ index: chunk.index, id: chunk.id, name: chunk.name, arguments: chunk.argumentsDelta ?? '' })
      } else {
        slot.arguments += chunk.argumentsDelta ?? ''
      }
      return
    }
    case 'usage':
      outcome.usage = chunk.usage
      return
    case 'finish':
      if (chunk.reason?.kind === 'max-tokens') outcome.truncated = true
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
        outcome.error = chunk.reason?.failure?.message ?? '生成失败'
      }
      return
    default:
  }
}
