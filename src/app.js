/**
 * 应用入口 —— 组装车道、设置与网关。
 *
 * 启动顺序：
 *   1. 设置存储（读 `settings.json`，没有就生成 API Key）
 *   2. 渠道包运行时（Worker 线程，12 家账号渠道）
 *   3. 车道层（把渠道包 / Kilo / 聚合统一成一个接口）
 *   4. 网关（对外的 `/v1/responses`）
 *
 * Kilo 的模型清单在启动后异步刷新 —— 它是一次网络请求，不该挡住监听器起来。
 */

import { createChannelRuntime } from './channels/runtime.mjs'
import { createLanes } from './lanes/index.js'
import { startGateway } from './gateway.js'
import { createManagementHandler } from './management.js'
import { createSettings, resolveDataDir } from './store.js'
import { fetchKiloListing } from '../vendor/lanes/kilo.js'
import { buildKiloCatalog } from '../vendor/lanes/catalog.js'
import { createAccountActions } from './channels/actions.mjs'

/**
 * 启动应用。
 *
 * @param {object} [options]
 * @param {string} [options.dataDir]  数据目录
 * @param {number} [options.port]     网关端口
 * @param {string} [options.host]     监听地址
 * @param {object} [options.logger]
 * @returns {Promise<object>} 应用句柄
 */
export async function startApp({ dataDir = resolveDataDir(), port, host = '127.0.0.1', logger = console } = {}) {
  const settings = createSettings(dataDir)
  const savedPort = Number(settings.get().port)
  const listenPort = port ?? (Number.isInteger(savedPort) && savedPort > 0 ? savedPort : 48760)

  const channels = await createChannelRuntime({ dataDir, logger })
  const accountActions = createAccountActions({ dataDir, channels })
  const lanes = createLanes({ channels, settings, logger })
  // 车道层需要能看见渠道包已注册的 provider，才能判定 `provider/model` 归属。
  lanes.channels = channels

  // 管理接口要拿 app 句柄（账号、模型、设置），而 app 句柄又要拿网关 ——
  // 这里用一个「先建后填」的引用打破循环。
  const appRef = { current: null }

  const gateway = await startGateway({
    lanes,
    apiKey: settings.get().apiKey,
    port: listenPort,
    host,
    desktopModel: () => settings.get().desktopModel,
    management: createManagementHandler({
      // 传函数而不是对象：网关先于 app 句柄建好，
      // 管理接口要在**请求时**才取 app（那时才存在）。
      app: () => appRef.current,
      apiKey: settings.get().apiKey,
    }),
  })

  settings.update({ port: gateway.port })

  // Kilo 清单：后台刷新，不挡启动
  const kiloReady = (async () => {
    try {
      const payload = await fetchKiloListing({})
      const catalog = buildKiloCatalog(payload?.data ?? [])
      lanes.setKiloModels(catalog.map(row => row.id))
      logger.log?.(`[Kilo] 已加载 ${catalog.length} 个模型`)
    } catch (error) {
      logger.warn?.(`[Kilo] 模型清单刷新失败：${error.message}`)
    }
  })()

  logger.log?.(`白用 AI · BaiUse 已启动：${gateway.url}`)
  logger.log?.(`API Key：${settings.get().apiKey}`)

  const app = {
    version: '0.1.0',
    dataDir,
    settings,
    channels,
    accountActions,
    lanes,
    gateway,
    kiloReady,
    get url() { return gateway.url },
    get apiKey() { return settings.get().apiKey },
    async close() {
      accountActions.close()
      await Promise.all([gateway.close(), channels.close()])
    },
  }
  // 管理接口通过这个引用拿到 app（打破「app 要网关、网关要 app」的循环）
  appRef.current = app
  return app
}
