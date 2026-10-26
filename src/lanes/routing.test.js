/**
 * 车道路由的测试。
 *
 * 这里盯的是**命名空间冲突**：渠道包的 provider id 与 provider 目录的 id
 * 是两个独立命名空间，但都拼成 `provider/model` 交给模型目录。
 * `gemini` 与 `minimax` 恰好两边都有 —— 按前缀先判渠道，会让聚合条目
 * 落进渠道适配器，然后 404。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createLanes, laneOf, LANE } from './index.js'

/** 造一个假渠道运行时。 */
function fakeChannels({ providers = ['gemini', 'trae'], rows = [] } = {}) {
  const calls = []
  return {
    calls,
    providers,
    publicModelRows: () => rows,
    handles: model => providers.some(provider => model.startsWith(`${provider}/`)),
    async complete(request, onChunk) {
      calls.push({ lane: 'channel', model: request.model })
      onChunk?.({ type: 'text-delta', text: 'channel' })
      return { text: 'channel', toolCalls: [] }
    },
  }
}

function fakeSettings(aggregate) {
  let value = { aggregate }
  return {
    get: () => value,
    update: patch => { value = { ...value, ...patch }; return value },
  }
}

test('laneOf 用已注册 provider 前缀判断，不按第一个斜杠切', () => {
  // 渠道包的模型名本身可能含斜杠
  assert.equal(laneOf('cline/cline-free/mimo-v2.6-flash', ['cline']), LANE.CHANNEL)
  assert.equal(laneOf('cline/x', ['cline']), LANE.CHANNEL)
  assert.equal(laneOf('other/x', ['cline']), null)
})

test('聚合条目优先于同名前缀的渠道 provider', () => {
  // gemini 同时是渠道 provider 和 registry provider
  const channels = fakeChannels({ providers: ['gemini'] })
  const settings = fakeSettings({
    providers: {
      gemini: { enabled: true, apiKey: 'k', models: ['gemini-3.8-flash'] },
    },
  })
  const lanes = createLanes({ channels, settings, logger: { warn() {} } })

  const route = lanes.resolve('gemini/gemini-3.8-flash')
  assert.equal(route?.lane, LANE.AGGREGATE, '精确命中的聚合条目必须走聚合车道')

  // 渠道自己的模型仍走渠道
  assert.equal(lanes.resolve('gemini/some-channel-model')?.lane, LANE.CHANNEL)
})

test('没有聚合配置时，渠道前缀照常生效', () => {
  const channels = fakeChannels({ providers: ['gemini'] })
  const lanes = createLanes({ channels, settings: fakeSettings({ providers: {} }), logger: { warn() {} } })
  assert.equal(lanes.resolve('gemini/x')?.lane, LANE.CHANNEL)
})

test('模型目录按 id 去重，聚合覆盖渠道', () => {
  const channels = fakeChannels({
    providers: ['gemini'],
    rows: [
      { id: 'gemini/gemini-3.8-flash', object: 'model', owned_by: 'channel-gemini' },
      { id: 'gemini/only-channel', object: 'model', owned_by: 'channel-gemini' },
    ],
  })
  const settings = fakeSettings({
    providers: {
      gemini: { enabled: true, apiKey: 'k', models: ['gemini-3.8-flash'] },
    },
  })
  const lanes = createLanes({ channels, settings, logger: { warn() {} } })
  lanes.setKiloModels(['kilo-auto/free'])

  const rows = lanes.modelRows()
  const ids = rows.map(row => row.id)

  assert.equal(new Set(ids).size, ids.length, 'id 不能重复')
  assert.equal(rows.find(row => row.id === 'gemini/gemini-3.8-flash')?.owned_by, 'gemini',
    '同 id 时聚合覆盖渠道')
  assert.ok(ids.includes('gemini/only-channel'), '渠道独有的模型要保留')
  assert.ok(ids.includes('kilo-auto/free'))
})

test('聚合 provider 未启用或没有 Key 时不出现在目录里', () => {
  const channels = fakeChannels({ providers: [] })
  const settings = fakeSettings({
    providers: {
      deepseek: { enabled: false, apiKey: 'k', models: ['deepseek-chat'] },
      kimi: { enabled: true, apiKey: '', models: ['kimi-k3'] },
    },
  })
  const lanes = createLanes({ channels, settings, logger: { warn() {} } })
  const ids = lanes.modelRows().map(row => row.id)
  assert.deepEqual(ids, [], '停用的和没 Key 的都不该贡献模型')
})

test('聚合车道总开关关闭时目录为空', () => {
  const channels = fakeChannels({ providers: [] })
  const settings = fakeSettings({
    enabled: false,
    providers: { deepseek: { enabled: true, apiKey: 'k', models: ['deepseek-chat'] } },
  })
  const lanes = createLanes({ channels, settings, logger: { warn() {} } })
  assert.deepEqual(lanes.modelRows(), [])
})

test('账号渠道 DeepSeek 与 Kilo、自备 Key 同时出现在统一接入目录，来源不混淆', () => {
  const channels = fakeChannels({ providers: ['codearts'], rows: [{ id: 'codearts/fixture-deepseek', owned_by: 'codearts' }] })
  const lanes = createLanes({ channels, settings: fakeSettings({ providers: { deepseek: { enabled: true, apiKey: 'fixture', models: ['deepseek-chat'] } } }), logger: { warn() {} } })
  lanes.setKiloModels(['kilo-auto/free'])
  assert.deepEqual(lanes.modelRows().map(row => [row.id, row.lane]), [
    ['codearts/fixture-deepseek', 'channel'], ['deepseek/deepseek-chat', 'aggregate'], ['kilo-auto/free', 'kilo'],
  ])
  assert.equal(lanes.resolve('codearts/fixture-deepseek').lane, LANE.CHANNEL)
})
