/**
 * SSE → chunk 转换 —— 把 Kilo / 聚合车道的原始 SSE 载荷变成统一的 chunk 形态。
 *
 * ## 为什么需要这一层
 *
 * 渠道包（`src/channels/runtime.mjs`）吐的已经是统一 chunk
 * （`text-delta` / `reasoning-delta` / `tool-call-delta` / `usage` / `finish`），
 * 而 Kilo 与聚合车道的 `onData` 收的是**原始 `data:` 载荷字符串**。
 * 路由层要能统一判断「是否已提交」（见 `src/failover.js` 的提交规则），
 * 就得让三条车道吐出同一种东西。
 *
 * ## 支持的上游形态
 *
 * - OpenAI Chat Completions：`data: {choices:[{delta:{content|reasoning_content, tool_calls}}]}`
 * - Anthropic Messages：`data: {type:'content_block_delta', delta:{type:'text_delta', text}}`
 * - OpenAI Responses：`data: {type:'response.output_text.delta', delta}`
 *
 * 上游也可能把错误放进流里（HTTP 200 但流内是 error 事件），
 * 这时要**抛出去** —— 否则 failover 层看不到失败，也就不会换路。
 */

/** 解析一条 SSE 载荷，产出 chunk。返回 undefined 表示「这条不产生内容」。 */
export function payloadToChunk(payload) {
  if (typeof payload !== 'string') return undefined
  const text = payload.trim()
  if (text === '' || text === '[DONE]') return undefined

  let data
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (data === null || typeof data !== 'object') return undefined

  // ── 流内错误 ──────────────────────────────────────────────────────────────
  // 必须在转换前判定：流内错误如果不抛，客户端会收到一个「正常结束但没有内容」的
  // 响应，failover 层也不会换路 —— 那正是最该换路的场景。
  if (data.error !== undefined || data.type === 'error') {
    const detail = data.error
    const message = typeof detail === 'string'
      ? detail
      : detail?.message ?? data.message ?? '上游流内错误'
    const error = new Error(String(message))
    const code = detail?.code ?? data.code
    if (code === 'RATE_LIMIT' || code === 'rate_limit_exceeded') error.status = 429
    else if (typeof detail?.status === 'number') error.status = detail.status
    throw error
  }

  // ── OpenAI Responses ──────────────────────────────────────────────────────
  switch (data.type) {
    case 'response.output_item.added':
      if (data.item?.type === 'function_call') return { type: 'tool-call-delta', index: data.output_index ?? 0, id: data.item.call_id ?? data.item.id, name: data.item.name, argumentsDelta: data.item.arguments ?? '' }
      return undefined
    case 'response.output_text.delta':
      return { type: 'text-delta', text: data.delta ?? '' }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      return { type: 'reasoning-delta', text: data.delta ?? '' }
    case 'response.function_call_arguments.delta':
      return { type: 'tool-call-delta', index: data.output_index ?? 0, argumentsDelta: data.delta ?? '' }
    case 'response.completed':
      return data.response?.usage === undefined
        ? undefined
        : { type: 'usage', usage: normalizeUsage(data.response.usage) }
    case 'response.failed':
    case 'response.incomplete':
      throw new Error(data.response?.error?.message ?? '上游响应未完成')
    default:
  }

  // ── OpenAI Chat Completions ───────────────────────────────────────────────
  const choice = data.choices?.[0]
  if (choice !== undefined) {
    // ⚠️ **完整文档优先**：上游不理 `stream: true` 时会答一个完整的 JSON，
    // 它**同时**带 `message` 和 `finish_reason`。若先判 finish_reason，
    // 正文就被当成「没有内容」丢掉了 —— 客户端收到一个空回答。
    if (choice.message !== undefined) {
      const message = choice.message
      const text = typeof message.content === 'string' ? message.content : ''
      if (text !== '') return { type: 'text-delta', text }
    }

    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string' && delta.content !== '') {
      return { type: 'text-delta', text: delta.content }
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      return { type: 'reasoning-delta', text: delta.reasoning_content }
    }
    if (typeof delta.reasoning === 'string' && delta.reasoning !== '') {
      return { type: 'reasoning-delta', text: delta.reasoning }
    }
    const toolCall = delta.tool_calls?.[0]
    if (toolCall !== undefined) {
      return {
        type: 'tool-call-delta',
        index: toolCall.index ?? 0,
        id: toolCall.id,
        name: toolCall.function?.name,
        argumentsDelta: toolCall.function?.arguments ?? '',
      }
    }
    if (choice.finish_reason != null) {
      return {
        type: 'finish',
        reason: choice.finish_reason === 'length'
          ? { kind: 'max-tokens' }
          : { kind: 'stop' },
        ...(data.usage === undefined ? {} : { usage: normalizeUsage(data.usage) }),
      }
    }
    return undefined
  }

  // ── Anthropic Messages ────────────────────────────────────────────────────
  if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
    return { type: 'tool-call-delta', index: data.index ?? 0, id: data.content_block.id, name: data.content_block.name, argumentsDelta: '' }
  }
  if (typeof data.type === 'string' && data.type.endsWith('_delta')) {
    const delta = data.delta ?? {}
    if (data.type === 'content_block_delta') {
      if (delta.type === 'thinking_delta') return { type: 'reasoning-delta', text: delta.thinking ?? '' }
      if (delta.type === 'text_delta') return { type: 'text-delta', text: delta.text ?? '' }
      if (delta.type === 'input_json_delta') {
        return { type: 'tool-call-delta', index: data.index ?? 0, argumentsDelta: delta.partial_json ?? '' }
      }
    }
    if (data.type === 'message_delta') {
      return {
        type: 'finish',
        reason: data.delta?.stop_reason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' },
        ...(data.usage === undefined ? {} : { usage: normalizeUsage(data.usage) }),
      }
    }
  }
  if (data.type === 'message_start' && data.message?.usage !== undefined) {
    return { type: 'usage', usage: normalizeUsage(data.message.usage) }
  }
  if (data.type === 'message_stop') {
    return { type: 'finish', reason: { kind: 'stop' } }
  }

  // ── 完整 JSON 文档（上游没理 `stream: true`） ───────────────────────────
  // 有些 provider 在收到 `stream: true` 时仍答一个完整的 JSON 文档。
  // 那不是「没有内容」，而是「内容已经在里面了」——
  // 若不处理，客户端会收到一个空回答。
  //
  // ⚠️ Chat 形态的完整文档在上面已经处理（`choices[0].message`），
  // 那里必须排在 `finish_reason` 之前 —— 完整文档的帧两者都有。
  if (Array.isArray(data.output)) {
    // Responses 形态的完整文档
    let text = ''
    for (const item of data.output) {
      if (item?.type !== 'message') continue
      for (const part of item.content ?? []) {
        if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text
      }
    }
    if (text === '') return undefined
    return { type: 'text-delta', text }
  }

  return undefined
}

/** A single upstream frame may carry several parallel tools or a complete reply.
 * Keep the scalar helper for compatibility; lane consumers use this lossless form.
 */
export function payloadToChunks(payload) {
  let data
  try { data = JSON.parse(payload) } catch { return [] }
  const message = data?.choices?.[0]?.message
  if (message) {
    return [
      ...(message.content ? [{ type: 'text-delta', text: message.content }] : []),
      ...(message.tool_calls ?? []).map((call, index) => ({ type: 'tool-call-delta', index, id: call.id, name: call.function?.name, argumentsDelta: call.function?.arguments ?? '{}' })),
      ...(data.usage ? [{ type: 'usage', usage: normalizeUsage(data.usage) }] : []),
      { type: 'finish', reason: { kind: data.choices[0].finish_reason === 'length' ? 'max-tokens' : 'stop' } },
    ]
  }
  const calls = data?.choices?.[0]?.delta?.tool_calls
  if (calls?.length) {
    return [
      ...(data.choices[0].delta.content ? [{ type: 'text-delta', text: data.choices[0].delta.content }] : []),
      ...calls.map((call, index) => ({ type: 'tool-call-delta', index: call.index ?? index, id: call.id, name: call.function?.name, argumentsDelta: call.function?.arguments ?? '' })),
      ...(data.usage ? [{ type: 'usage', usage: normalizeUsage(data.usage) }] : []),
    ]
  }
  if (data?.type === 'message' && Array.isArray(data.content)) {
    return [
      ...data.content.flatMap((block, index) => block.type === 'text' ? [{ type: 'text-delta', text: block.text }]
        : block.type === 'tool_use' ? [{ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: JSON.stringify(block.input ?? {}) }] : []),
      ...(data.usage ? [{ type: 'usage', usage: normalizeUsage(data.usage) }] : []),
      { type: 'finish', reason: { kind: data.stop_reason === 'max_tokens' ? 'max-tokens' : 'stop' } },
    ]
  }
  if (data?.object === 'response' && Array.isArray(data.output)) {
    return [
      ...data.output.flatMap((item, index) => item.type === 'function_call'
        ? [{ type: 'tool-call-delta', index, id: item.call_id ?? item.id, name: item.name, argumentsDelta: item.arguments ?? '{}' }]
        : item.type === 'message' ? (item.content ?? []).filter(part => part.type === 'output_text').map(part => ({ type: 'text-delta', text: part.text })) : []),
      ...(data.usage ? [{ type: 'usage', usage: normalizeUsage(data.usage) }] : []),
      { type: 'finish', reason: { kind: data.status === 'incomplete' ? 'max-tokens' : 'stop' } },
    ]
  }
  const chunk = payloadToChunk(payload)
  return chunk ? [chunk] : []
}

/**
 * 把各家 usage 的字段名归一。
 *
 * ⚠️ `input_tokens` **必须含缓存命中**（OpenAI 官方口径）。
 * Codex 用 `input_tokens - cached_tokens` 算上下文占用；
 * 若发的是「不含缓存」的口径，Codex 会把缓存量当负输入夹到 0，
 * 上下文占用被少算上百倍，**自动压缩永不触发**。
 * （上游 dsh 的 `openai-gateway/responses.ts` 记录了这个事故）
 */
export function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const count = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.cache_read_input_tokens
    ?? usage.cacheReadTokens
    ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? usage.cacheWriteTokens ?? 0
  // 渠道包的 camelCase inputTokens 是未缓存输入；缓存读/写需计入总输入。
  const input = count(usage.prompt_tokens ?? (usage.input_tokens !== undefined
    ? usage.input_tokens + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens)
    : count(usage.inputTokens) + count(cacheRead) + count(cacheWrite)))
  const output = count(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens)
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
    ?? usage.output_tokens_details?.reasoning_tokens
    ?? usage.reasoningTokens
    ?? 0
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Math.max(count(usage.total_tokens ?? usage.totalTokens), input + output),
    ...(cacheRead > 0 ? { prompt_tokens_details: { cached_tokens: count(cacheRead) } } : {}),
    ...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: count(reasoning) } } : {}),
  }
}

/** Responses 与 Chat 的 usage 字段不同，不能直接透传渠道包的内部对象。 */
export function responsesUsage(raw) {
  const usage = normalizeUsage(raw) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
  }
}
