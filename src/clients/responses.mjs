/** Stateful Responses event assembly: stable item IDs, complete function calls and native usage. */
import crypto from 'node:crypto'
import { responsesUsage } from '../lanes/sse.js'

const id = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

export function createResponseAssembler({ responseId, model, createdAt, emit = () => {} }) {
  const items = [], tools = new Map()
  let message, reasoning, usage, truncated = false, sequence = 0
  const event = (type, value) => emit(type, { type, sequence_number: sequence++, ...value })
  const snapshot = (status, tokenUsage = null) => ({
    id: responseId, object: 'response', created_at: createdAt, model, status,
    error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    output: items, usage: tokenUsage,
  })
  function add(item) {
    const index = items.push(item) - 1
    event('response.output_item.added', { output_index: index, item: structuredClone(item) })
    return index
  }
  function consume(chunk) {
    if (chunk.usage) usage = { ...usage, ...chunk.usage }
    if (chunk.type === 'finish') { truncated ||= chunk.reason?.kind === 'max-tokens'; return }
    if (chunk.type === 'text-delta') {
      if (!message) {
        const item = { id: id('msg'), type: 'message', role: 'assistant', status: 'in_progress', content: [] }
        message = { item, index: add(item) }
        item.content.push({ type: 'output_text', text: '', annotations: [], logprobs: [] })
        event('response.content_part.added', { item_id: item.id, output_index: message.index, content_index: 0, part: structuredClone(item.content[0]) })
      }
      message.item.content[0].text += chunk.text ?? ''
      event('response.output_text.delta', { item_id: message.item.id, output_index: message.index, content_index: 0, delta: chunk.text ?? '', logprobs: [] })
    }
    if (chunk.type === 'reasoning-delta') {
      if (!reasoning) {
        const item = { id: id('rs'), type: 'reasoning', summary: [] }
        reasoning = { item, index: add(item) }
        item.summary.push({ type: 'summary_text', text: '' })
        event('response.reasoning_summary_part.added', { item_id: item.id, output_index: reasoning.index, summary_index: 0, part: structuredClone(item.summary[0]) })
      }
      reasoning.item.summary[0].text += chunk.text ?? ''
      event('response.reasoning_summary_text.delta', { item_id: reasoning.item.id, output_index: reasoning.index, summary_index: 0, delta: chunk.text ?? '' })
    }
    if (chunk.type === 'tool-call-delta') {
      const key = chunk.index ?? chunk.id ?? 0
      let tool = tools.get(key)
      if (!tool) {
        tool = { item: { id: id('fc'), type: 'function_call', call_id: chunk.id || id('call'), name: '', arguments: '', status: 'in_progress' }, index: undefined }
        tools.set(key, tool)
      }
      if (chunk.name) tool.item.name = chunk.name
      tool.item.arguments += chunk.argumentsDelta ?? ''
      if (tool.index === undefined && tool.item.name) {
        tool.index = add({ ...tool.item, arguments: '' })
        items[tool.index] = tool.item
        event('response.function_call_arguments.delta', { item_id: tool.item.id, output_index: tool.index, delta: tool.item.arguments })
      } else if (tool.index !== undefined) {
        event('response.function_call_arguments.delta', { item_id: tool.item.id, output_index: tool.index, delta: chunk.argumentsDelta ?? '' })
      }
    }
  }
  function finish(result = {}) {
    if (!message && result.text) consume({ type: 'text-delta', text: result.text })
    if (!tools.size) for (const [index, tool] of (result.toolCalls ?? []).entries()) {
      const args = tool.arguments ?? tool.function?.arguments ?? '{}'
      consume({ type: 'tool-call-delta', index, id: tool.id, name: tool.name ?? tool.function?.name, argumentsDelta: typeof args === 'string' ? args : JSON.stringify(args) })
    }
    truncated ||= result.truncated === true
    for (const tool of tools.values()) if (tool.index === undefined) throw new Error('上游工具调用缺少 name')
    for (const [index, item] of items.entries()) {
      if (item.type === 'message') {
        item.status = 'completed'
        event('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text, logprobs: [] })
        event('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part: item.content[0] })
      } else if (item.type === 'reasoning') {
        event('response.reasoning_summary_text.done', { item_id: item.id, output_index: index, summary_index: 0, text: item.summary[0].text })
        event('response.reasoning_summary_part.done', { item_id: item.id, output_index: index, summary_index: 0, part: item.summary[0] })
      } else {
        item.status = 'completed'
        event('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments })
      }
      event('response.output_item.done', { output_index: index, item })
    }
    const response = snapshot(truncated ? 'incomplete' : 'completed', responsesUsage(usage ?? result.usage))
    event(truncated ? 'response.incomplete' : 'response.completed', { response })
    return response
  }
  return { start: () => event('response.created', { response: snapshot('in_progress') }), consume, finish }
}
