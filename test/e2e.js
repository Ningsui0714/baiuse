#!/usr/bin/env node
/**
 * 端到端演示：起一个假车道（模拟两个 provider，第一个被限流），
 * 再起真实的网关，打真实的 HTTP 请求，验证跨 provider 换路。
 *
 * 用法：node test/e2e.js
 */

import { startGateway } from '../src/gateway.js'

const MODELS = [
  { id: 'trae/glm-5', object: 'model', created: 0, owned_by: 'trae' },
  { id: 'cline/glm-5', object: 'model', created: 0, owned_by: 'cline' },
]

/** 假车道：按模型名返回不同行为。 */
const calls = []
const lanes = {
  channels: { providers: ['trae', 'cline'] },
  kiloModels: [],
  aggregateCatalog: () => [],
  modelRows: () => MODELS,
  resolve: model => (MODELS.some(row => row.id === model) ? { lane: 'channel' } : null),
  async complete(request, onChunk) {
    calls.push(request.model)
    if (request.model === 'trae/glm-5') {
      console.log('  [车道] trae 限流 → 429')
      throw Object.assign(new Error('Rate limit exceeded'), {
        status: 429,
        code: 'RATE_LIMIT',
        errorType: 'rate_limit_error',
      })
    }
    console.log('  [车道] cline 正常 → 返回结果')
    onChunk({ type: 'text-delta', text: '来自 cline 的回答' })
    onChunk({ type: 'finish', reason: { kind: 'stop' }, usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })
    return { text: '', toolCalls: [] }
  },
}

const gateway = await startGateway({
  lanes,
  port: 0,
  onAttempt: info => {
    const status = info.ok ? '成功' : `失败（${info.error?.message ?? '未知'}）`
    console.log(`  [路由] 尝试 ${info.candidate.routeKey} → ${status}`)
  },
})

console.log(`\n网关地址：${gateway.url}\n`)
console.log('场景：客户端请求模型 "glm-5"（车道上有 trae/glm-5 与 cline/glm-5 两个候选）')
console.log('trae 被限流，预期自动换到 cline\n')

const response = await fetch(`${gateway.url}/v1/responses`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'user-agent': 'codex_cli_rs/0.142.0',
  },
  body: JSON.stringify({
    model: 'glm-5',
    instructions: 'You are a coding agent.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say hi' }] }],
    stream: false,
  }),
})

const payload = await response.json()
console.log('\n结果：')
console.log(`  HTTP 状态：${response.status}`)
console.log(`  正文：${payload.output?.[0]?.content?.[0]?.text ?? JSON.stringify(payload)}`)
console.log(`  错误：${payload.error?.message ?? '无'}`)

const passed = response.status === 200 && payload.output?.[0]?.content?.[0]?.text === '来自 cline 的回答'
console.log(`\n${passed ? '✅ 通过：限流后成功换到 cline' : '❌ 失败'}`)

await gateway.close()
process.exit(passed ? 0 : 1)
