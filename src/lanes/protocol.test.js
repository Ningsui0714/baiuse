/**
 * 协议转换的测试 —— Responses ↔ Chat 的请求方向，以及各家 SSE → chunk。
 *
 * 这两处是「Codex 说 Responses、上游说 Chat」之间唯一的桥，
 * 转错了要么 400，要么答案悄悄变空。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { responsesToChat } from './responses-to-chat.js'
import { normalizeUsage, payloadToChunk } from './sse.js'

/* ------------------------------------------------------------------ *
 * Responses → Chat 请求方向
 * ------------------------------------------------------------------ */

test('instructions 变成 system 消息', () => {
  const chat = responsesToChat({
    model: 'm',
    instructions: 'You are a coding agent.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  })
  assert.equal(chat.messages[0].role, 'system')
  assert.equal(chat.messages[0].content, 'You are a coding agent.')
  assert.equal(chat.messages[1].role, 'user')
  assert.equal(chat.messages[1].content, 'hi')
})

test('input 是字符串时直接变成一条 user 消息', () => {
  const chat = responsesToChat({ model: 'm', input: 'hello' })
  assert.deepEqual(chat.messages, [{ role: 'user', content: 'hello' }])
})

test('max_output_tokens 变成 max_tokens', () => {
  const chat = responsesToChat({ model: 'm', input: 'x', max_output_tokens: 512 })
  assert.equal(chat.max_tokens, 512)
  assert.equal(chat.max_output_tokens, undefined)
})

test('reasoning.effort 变成 reasoning_effort', () => {
  const chat = responsesToChat({ model: 'm', input: 'x', reasoning: { effort: 'high' } })
  assert.equal(chat.reasoning_effort, 'high')
})

test('function 工具去掉外层 type、补上 function', () => {
  const chat = responsesToChat({
    model: 'm',
    input: 'x',
    tools: [{ type: 'function', name: 'read', description: 'd', parameters: { type: 'object' } }],
  })
  assert.equal(chat.tools.length, 1)
  assert.equal(chat.tools[0].type, 'function')
  assert.equal(chat.tools[0].function.name, 'read')
  assert.equal(chat.tools[0].function.parameters.type, 'object')
})

test('namespace 工具被摊平成 <ns>__<tool>，而不是报错', () => {
  const chat = responsesToChat({
    model: 'm',
    input: 'x',
    tools: [{
      type: 'namespace',
      name: 'shell',
      tools: [{ type: 'function', name: 'exec', description: 'd', parameters: { type: 'object' } }],
    }],
  })
  assert.equal(chat.tools.length, 1)
  assert.equal(chat.tools[0].function.name, 'shell__exec')
})

test('custom / tool_search 工具被丢弃并记日志，而不是让整轮失败', () => {
  const dropped = []
  const chat = responsesToChat({
    model: 'm',
    input: 'x',
    tools: [
      { type: 'custom', name: 'c' },
      { type: 'tool_search' },
      { type: 'function', name: 'ok', parameters: {} },
    ],
  }, tool => dropped.push(tool))

  assert.equal(dropped.length, 2, '两个不可表达的��具都该被记下')
  assert.equal(chat.tools.length, 1, '可表达的那个要留下')
  assert.equal(chat.tools[0].function.name, 'ok')
})

test('历史轮次里的 function_call / function_call_output 被正确映射', () => {
  const chat = responsesToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' },
    ],
  })
  assert.equal(chat.messages[1].role, 'assistant')
  assert.equal(chat.messages[1].tool_calls[0].id, 'call_1')
  assert.equal(chat.messages[1].tool_calls[0].function.name, 'shell')
  assert.equal(chat.messages[2].role, 'tool')
  assert.equal(chat.messages[2].tool_call_id, 'call_1')
  assert.equal(chat.messages[2].content, 'file.txt')
})

test('reasoning 历史块被跳过（Chat 没有对应位置）', () => {
  const chat = responsesToChat({
    model: 'm',
    input: [
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] },
    ],
  })
  assert.equal(chat.messages.length, 1)
  assert.equal(chat.messages[0].role, 'user')
})

test('Responses 的对象形态 tool_choice 转成 Chat 的', () => {
  const chat = responsesToChat({
    model: 'm',
    input: 'x',
    tool_choice: { type: 'function', name: 'read' },
  })
  assert.deepEqual(chat.tool_choice, { type: 'function', function: { name: 'read' } })
})

/* ------------------------------------------------------------------ *
 * SSE → chunk
 * ------------------------------------------------------------------ */

test('Chat 的 content delta 变成 text-delta', () => {
  const chunk = payloadToChunk(JSON.stringify({
    choices: [{ delta: { content: '你好' } }],
  }))
  assert.deepEqual(chunk, { type: 'text-delta', text: '你好' })
})

test('Chat 的 reasoning 字段变成 reasoning-delta', () => {
  const chunk = payloadToChunk(JSON.stringify({
    choices: [{ delta: { content: '', reasoning: '思考' } }],
  }))
  assert.deepEqual(chunk, { type: 'reasoning-delta', text: '思考' })
})

test('Chat 的工具调用变成 tool-call-delta', () => {
  const chunk = payloadToChunk(JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"a"' } }] } }],
  }))
  assert.equal(chunk.type, 'tool-call-delta')
  assert.equal(chunk.id, 'c1')
  assert.equal(chunk.argumentsDelta, '{"a"')
})

test('Anthropic 的 text_delta 变成 text-delta', () => {
  const chunk = payloadToChunk(JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '正文' },
  }))
  assert.deepEqual(chunk, { type: 'text-delta', text: '正文' })
})

test('Anthropic 的 thinking_delta 变成 reasoning-delta', () => {
  const chunk = payloadToChunk(JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: '思考' },
  }))
  assert.deepEqual(chunk, { type: 'reasoning-delta', text: '思考' })
})

test('Responses 的 output_text.delta 变成 text-delta', () => {
  const chunk = payloadToChunk(JSON.stringify({
    type: 'response.output_text.delta',
    delta: 'x',
  }))
  assert.deepEqual(chunk, { type: 'text-delta', text: 'x' })
})

test('流内错误必须抛出 —— 否则不会触发换路', () => {
  assert.throws(() => {
    payloadToChunk(JSON.stringify({ type: 'error', message: 'rate limited' }))
  }, /rate limited/)
})

test('流内的 429 要带上状态码', () => {
  try {
    payloadToChunk(JSON.stringify({ error: { message: '限流', code: 'RATE_LIMIT' } }))
    assert.fail('应当抛出')
  } catch (error) {
    assert.equal(error.status, 429)
  }
})

test('[DONE] 与非 JSON 载荷不产生 chunk', () => {
  assert.equal(payloadToChunk('[DONE]'), undefined)
  assert.equal(payloadToChunk('not json'), undefined)
  assert.equal(payloadToChunk(''), undefined)
})

test('上游答了完整 JSON 文档时也能取出正文', () => {
  const chunk = payloadToChunk(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '完整答案' }, finish_reason: 'stop' }],
  }))
  assert.deepEqual(chunk, { type: 'text-delta', text: '完整答案' })
})

/* ------------------------------------------------------------------ *
 * usage 归一
 * ------------------------------------------------------------------ */

test('input_tokens 必须含缓存命中（Codex 的上下文占用判据）', () => {
  const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 10 })
  assert.equal(usage.prompt_tokens, 100)
  assert.equal(usage.total_tokens, 110)
  // 不含缓存的字段不该出现 —— Codex 会把缓存算成负输入
  assert.equal(usage.prompt_tokens_details, undefined)
})

test('缓存命中要被单列出来', () => {
  const usage = normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 80 },
  })
  assert.equal(usage.prompt_tokens, 100, '总输入含缓存')
  assert.equal(usage.prompt_tokens_details.cached_tokens, 80, '命中部分单列')
})

test('Responses 形态的 usage 也能归一', () => {
  const usage = normalizeUsage({
    input_tokens: 50,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 30 },
    output_tokens_details: { reasoning_tokens: 8 },
  })
  assert.equal(usage.prompt_tokens, 50)
  assert.equal(usage.completion_tokens, 20)
  assert.equal(usage.prompt_tokens_details.cached_tokens, 30)
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 8)
})
