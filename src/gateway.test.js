/**
 * 网关的端到端测试（用假车道，不打真实网络）。
 *
 * 验证网关自己的职责：
 *  - 端点路由与鉴权
 *  - Codex 的 Responses 事件序列是否正确
 *  - 跨 provider 换路
 *  - 上游错误结构与状态码是否原样保留
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { startGateway } from './gateway.js'
import { createLanes } from './lanes/index.js'

/** 构造一个假车道层。 */
function fakeLanes({ models, behavior, kiloModels = [] }) {
  const rows = models.map(id => ({ id, object: 'model', created: 0, owned_by: 'test' }))
  const calls = []
  return {
    calls,
    rows,
    channels: { providers: models.map(id => id.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i) },
    modelRows: () => rows,
    aggregateCatalog: () => [],
    kiloModels,
    resolve(model) {
      if (!models.includes(model)) return null
      return { lane: 'channel' }
    },
    async complete(request, onChunk) {
      calls.push(request.model)
      const fn = behavior[request.model]
      if (fn === undefined) {
        throw Object.assign(new Error(`no behavior for ${request.model}`), { statusCode: 404 })
      }
      return fn(request, onChunk)
    },
  }
}

const MODELS = ['trae/glm-5', 'cline/glm-5']

test('Responses 事件序列符合 Codex 的期待', async () => {
  const lanes = fakeLanes({
    models: MODELS,
    behavior: {
      'trae/glm-5': (request, onChunk) => {
        onChunk({ type: 'reasoning-delta', text: '想一下' })
        onChunk({ type: 'text-delta', text: '你好' })
        onChunk({ type: 'finish', reason: { kind: 'stop' }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
        return { text: '', toolCalls: [] }
      },
    },
  })
  const gateway = await startGateway({ lanes, port: 0 })
  try {
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'trae/glm-5', input: 'hi', stream: true }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)

    const text = await response.text()
    // Codex 依赖这些事件，缺一个就解析不了。
    for (const event of [
      'response.created',
      'response.output_item.added',
      'response.reasoning_summary_text.delta',
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]) {
      assert.ok(text.includes(`event: ${event}`), `缺少事件 ${event}`)
    }
    assert.ok(text.includes('data: [DONE]'), '应以 [DONE] 收尾')
    assert.match(text, /"delta":"你好"/)
    // usage 必须带上下文占用，否则 Codex 算不出占用、自动压缩不触发
    assert.match(text, /"prompt_tokens":10/)
  } finally {
    await gateway.close()
  }
})

test('非流式：拼成完整的 Responses 响应', async () => {
  const lanes = fakeLanes({
    models: MODELS,
    behavior: {
      'trae/glm-5': (request, onChunk) => {
        onChunk({ type: 'text-delta', text: '答案' })
        return { text: '', toolCalls: [] }
      },
    },
  })
  const gateway = await startGateway({ lanes, port: 0 })
  try {
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'trae/glm-5', input: 'hi' }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.object, 'response')
    assert.equal(payload.status, 'completed')
    assert.equal(payload.output[0].content[0].text, '答案')
  } finally {
    await gateway.close()
  }
})

test('首选 provider 限流时换到下一个 provider', async () => {
  const lanes = fakeLanes({
    models: MODELS,
    behavior: {
      'trae/glm-5': () => {
        throw Object.assign(new Error('Rate limit exceeded'), { status: 429, code: 'RATE_LIMIT' })
      },
      'cline/glm-5': (request, onChunk) => {
        onChunk({ type: 'text-delta', text: '来自 cline' })
        return { text: '', toolCalls: [] }
      },
    },
  })
  const gateway = await startGateway({ lanes, port: 0 })
  try {
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5', input: 'hi' }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.output[0].content[0].text, '来自 cline')
    assert.deepEqual(lanes.calls, ['trae/glm-5', 'cline/glm-5'], '应先试 trae 再换 cline')
  } finally {
    await gateway.close()
  }
})

test('上游限流的状态码与错误类型原样保留', async () => {
  const lanes = fakeLanes({
    models: ['trae/glm-5'],
    behavior: {
      'trae/glm-5': () => {
        throw Object.assign(new Error('Rate limit exceeded'), {
          status: 429,
          code: 'RATE_LIMIT',
          errorType: 'rate_limit_error',
        })
      },
    },
  })
  const gateway = await startGateway({ lanes, port: 0 })
  try {
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'trae/glm-5', input: 'hi' }),
    })
    const payload = await response.json()
    assert.equal(response.status, 429, '状态码必须原样保留 —— Codex 靠它决定退避重试')
    assert.equal(payload.error.type, 'rate_limit_error')
    assert.equal(payload.error.code, 'RATE_LIMIT')
  } finally {
    await gateway.close()
  }
})

test('模型不存在时返回 404', async () => {
  const lanes = fakeLanes({ models: MODELS, behavior: {} })
  const gateway = await startGateway({ lanes, port: 0 })
  try {
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'missing/model', input: 'hi' }),
    })
    assert.equal(response.status, 404)
  } finally {
    await gateway.close()
  }
})

test('给了 API Key 就必须鉴权', async () => {
  const lanes = fakeLanes({ models: MODELS, behavior: {} })
  const gateway = await startGateway({ lanes, apiKey: 'secret', port: 0 })
  try {
    const noKey = await fetch(`${gateway.url}/v1/models`)
    assert.equal(noKey.status, 401)

    const withKey = await fetch(`${gateway.url}/v1/models`, { headers: { authorization: 'Bearer secret' } })
    assert.equal(withKey.status, 200)

    // health 永远免鉴权 —— 否则客户端无法判断服务是否在
    const health = await fetch(`${gateway.url}/health`)
    assert.equal(health.status, 200)
  } finally {
    await gateway.close()
  }
})

test('health 报告 Codex 客户端识别', async () => {
  const lanes = fakeLanes({ models: MODELS, behavior: {} })
  const gateway = await startGateway({ lanes, port: 0 })
  try {
    const plain = await fetch(`${gateway.url}/health`)
    const status = await plain.json()
    assert.equal(status.service, 'codex-relay')
    assert.equal(status.codex, false)

    const codex = await fetch(`${gateway.url}/health`, { headers: { 'user-agent': 'codex_cli_rs/0.142.0' } })
    assert.equal((await codex.json()).codex, true)
  } finally {
    await gateway.close()
  }
})

test('模型目录透传车道层的结果', async () => {
  const lanes = fakeLanes({ models: MODELS, behavior: {} })
  const gateway = await startGateway({ lanes, port: 0 })
  try {
    const payload = await (await fetch(`${gateway.url}/v1/models`)).json()
    assert.equal(payload.object, 'list')
    assert.deepEqual(payload.data.map(row => row.id), MODELS)
  } finally {
    await gateway.close()
  }
})
