/**
 * 故障转移的端到端测试（用假上游，不打网络）。
 *
 * 覆盖真实场景里最容易出错的几条：
 *  - 首选 provider 限流 → 自动换到下一个 provider
 *  - 换路时**不能**把上一路的半截内容漏给用户
 *  - reasoning 不算提交 → 「想了一分钟才撞配额墙」仍能换路
 *  - 已提交（吐了正文）后失败 → 不换路
 *  - Codex 客户端识别
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createFailoverComplete, isCodexClientRequest, resolveSessionKey } from './failover.js'
import { CooldownLedger, SessionAffinity } from './route.js'

const MODELS = [
  { id: 'trae/glm-5', owned_by: 'trae' },
  { id: 'cline/glm-5', owned_by: 'cline' },
  { id: 'qoder/glm-5', owned_by: 'qoder' },
]

/** 构造一个假上游：按模型名返回预设行为。 */
function fakeComplete(behaviors) {
  return async (request, onChunk) => {
    const model = request.model
    const behavior = behaviors[model]
    if (behavior === undefined) {
      return { text: '', toolCalls: [], error: `no behavior for ${model}` }
    }
    if (typeof behavior === 'function') return behavior(model, onChunk)
    for (const chunk of behavior.chunks ?? []) onChunk?.(chunk)
    if (behavior.error) {
      return { text: '', toolCalls: [], error: behavior.error, failure: { message: behavior.error, code: behavior.code ?? 'RATE_LIMIT' } }
    }
    return { text: behavior.text ?? 'ok', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }
  }
}

test('首选 provider 限流时自动换到下一个 provider', async () => {
  const seen = []
  const complete = createFailoverComplete({
    baseComplete: fakeComplete({
      'trae/glm-5': (model, onChunk) => {
        seen.push(model)
        onChunk?.({ type: 'reasoning-delta', text: 'thinking...' })
        return { text: '', toolCalls: [], error: 'Rate limit exceeded' }
      },
      'cline/glm-5': (model, onChunk) => {
        seen.push(model)
        onChunk?.({ type: 'text-delta', text: 'hello' })
        return { text: 'hello', toolCalls: [] }
      },
    }),
    modelRows: async () => MODELS,
    cooldowns: new CooldownLedger(),
  })

  const chunks = []
  const result = await complete({ model: 'glm-5' }, chunk => chunks.push(chunk))

  assert.deepEqual(seen, ['trae/glm-5', 'cline/glm-5'], '应先试 trae 再换 cline')
  assert.equal(result.error, undefined, '最终应成功')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].text, 'hello', '只有成功那一路的正文应被交付')
})

test('已提交（吐了正文）后失败不再换路 —— 避免用户看到两段拼接回答', async () => {
  const seen = []
  const complete = createFailoverComplete({
    baseComplete: fakeComplete({
      'trae/glm-5': (model, onChunk) => {
        seen.push(model)
        onChunk?.({ type: 'text-delta', text: 'partial answer' })
        return { text: 'partial answer', toolCalls: [], error: 'boom' }
      },
      'cline/glm-5': (model, onChunk) => {
        seen.push(model)
        onChunk?.({ type: 'text-delta', text: 'second' })
        return { text: 'second', toolCalls: [] }
      },
    }),
    modelRows: async () => MODELS,
  })

  const chunks = []
  await complete({ model: 'glm-5' }, chunk => chunks.push(chunk)).catch(() => {})

  assert.deepEqual(seen, ['trae/glm-5'], '已提交后不应再尝试别的 provider')
  const texts = chunks.filter(c => c.type === 'text-delta').map(c => c.text)
  assert.deepEqual(texts, ['partial answer'], '只交付已提交那一路的内容')
})

test('reasoning 不算提交 —— 想了一分钟才撞配额墙仍能换路', async () => {
  const seen = []
  const complete = createFailoverComplete({
    baseComplete: fakeComplete({
      'trae/glm-5': (model, onChunk) => {
        seen.push(model)
        onChunk?.({ type: 'reasoning-delta', text: '思考了一分钟' })
        return { text: '', toolCalls: [], error: 'quota exhausted' }
      },
      'cline/glm-5': (model, onChunk) => {
        seen.push(model)
        onChunk?.({ type: 'text-delta', text: 'ok' })
        return { text: 'ok', toolCalls: [] }
      },
    }),
    modelRows: async () => MODELS,
  })

  const chunks = []
  const result = await complete({ model: 'glm-5' }, chunk => chunks.push(chunk))

  assert.deepEqual(seen, ['trae/glm-5', 'cline/glm-5'], 'reasoning 后失败仍应换路')
  assert.equal(result.error, undefined)
  const reasoning = chunks.filter(c => c.type === 'reasoning-delta')
  assert.equal(reasoning.length, 0, '被放弃那一路的 reasoning 不应交付给用户')
})

test('单候选时不走候选逻辑，直接透传', async () => {
  let calls = 0
  const complete = createFailoverComplete({
    baseComplete: async () => { calls += 1; return { text: 'x', toolCalls: [] } },
    modelRows: async () => [{ id: 'only/model' }],
  })
  const result = await complete({ model: 'model' }, () => {})
  assert.equal(calls, 1)
  assert.equal(result.text, 'x')
})

test('所有候选都失败时抛出最后一个错误（保留可诊断性）', async () => {
  const complete = createFailoverComplete({
    baseComplete: fakeComplete({
      'trae/glm-5': () => ({ text: '', toolCalls: [], error: 'trae down' }),
      'cline/glm-5': () => ({ text: '', toolCalls: [], error: 'cline down' }),
      'qoder/glm-5': () => ({ text: '', toolCalls: [], error: 'qoder down' }),
    }),
    modelRows: async () => MODELS,
    maxAttempts: 3,
  })

  await assert.rejects(
    () => complete({ model: 'glm-5' }, () => {}),
    error => /qoder down/.test(error.message ?? ''),
    '应抛出最后一个候选的错误',
  )
})

test('冷却中的 provider 会被跳过', async () => {
  const cooldowns = new CooldownLedger()
  cooldowns.mark('trae/glm-5', 'rateLimited')
  const seen = []

  const complete = createFailoverComplete({
    baseComplete: fakeComplete({
      'trae/glm-5': model => { seen.push(model); return { text: '', toolCalls: [], error: 'x' } },
      'cline/glm-5': model => { seen.push(model); return { text: 'ok', toolCalls: [] } },
    }),
    modelRows: async () => MODELS,
    cooldowns,
  })

  await complete({ model: 'glm-5' }, () => {})
  assert.deepEqual(seen, ['cline/glm-5'], '冷却中的 trae 不应被尝试')
})

test('会话粘性：同一会话固定走同一条路', async () => {
  const seen = []
  const affinity = new SessionAffinity()
  const complete = createFailoverComplete({
    baseComplete: fakeComplete({
      'trae/glm-5': model => { seen.push(model); return { text: 't', toolCalls: [] } },
      'cline/glm-5': model => { seen.push(model); return { text: 'c', toolCalls: [] } },
    }),
    modelRows: async () => MODELS,
    affinity,
  })

  const request = { model: 'glm-5', headers: { session_id: 'sess-9' } }
  await complete(request, () => {})
  await complete(request, () => {})

  assert.deepEqual(seen, ['trae/glm-5', 'trae/glm-5'], '第二请求应沿用粘性的路')
})

/* ------------------------------------------------------------------ *
 * Codex 客户端识别
 * ------------------------------------------------------------------ */

test('isCodexClientRequest: 识别 Codex 的 UA 与 x-codex-* 头', () => {
  assert.equal(isCodexClientRequest({ 'user-agent': 'codex_cli_rs/0.142.0' }), true)
  assert.equal(isCodexClientRequest({ 'user-agent': 'codex_exec/1.0' }), true)
  assert.equal(isCodexClientRequest({ 'x-codex-turn-state': '{}' }), true)
  assert.equal(isCodexClientRequest({ 'x-codex-window-id': 'w1' }), true)
  assert.equal(isCodexClientRequest({ 'x-client-request-id': 'r1' }), true)
  assert.equal(isCodexClientRequest({ 'x-openai-subagent': 's' }), true)
})

test('isCodexClientRequest: 只带 session_id 不算 Codex', () => {
  assert.equal(isCodexClientRequest({ session_id: 'abc' }), false)
  assert.equal(isCodexClientRequest({ 'user-agent': 'opencode/1.0' }), false)
  assert.equal(isCodexClientRequest({}), false)
  assert.equal(isCodexClientRequest(undefined), false)
})

test('resolveSessionKey: 锚点优先级 session_id → x-api-key → bearer', () => {
  assert.equal(resolveSessionKey({ headers: { session_id: 's1', 'x-api-key': 'k', authorization: 'Bearer b' } }), 'sid:s1')
  assert.equal(resolveSessionKey({ headers: { 'x-api-key': 'k', authorization: 'Bearer b' } }), 'xak:k')
  assert.equal(resolveSessionKey({ headers: { authorization: 'Bearer b' } }), 'bearer:Bearer b')
  assert.equal(resolveSessionKey({ headers: {} }), undefined)
  assert.equal(resolveSessionKey({}), undefined)
})

test('resolveSessionKey: 头名大小写不敏感', () => {
  assert.equal(resolveSessionKey({ headers: { 'Session-ID': 's1' } }), 'sid:s1')
})
