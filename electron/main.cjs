/**
 * Electron 主进程 —— 桌面壳。
 *
 * ## 职责
 *
 * 1. 启动 app（网关 + 车道 + 管理接口）
 * 2. 开一个窗口显示管理界面（`/app`）
 * 3. 菜单栏 / 托盘：显示状态、打开界面、复制 Codex 配方、退出
 *
 * ## 为什么用 Electron 而不是 Tauri
 *
 * Tauri 需要 Rust 工具链（约 1GB）。本 app 已经是纯 Node 实现，
 * 用 Electron 可以零额外依赖地把同一份代码跑成桌面应用 ——
 * 主进程直接 `import` 同一个 `src/app.js`，没有两套逻辑。
 *
 * ## 注入 API Key
 *
 * 管理页面在浏览器里打开时需要 key。这里通过
 * `webPreferences.additionalArguments` 把 key 传给渲染进程，
 * 页面读 `window.__OFM_API_KEY__`。这样用户不需要手输。
 */

const { app, BrowserWindow, Menu, Tray, shell, nativeImage } = require('electron')
const path = require('node:path')

/** app 句柄。 */
let gatewayApp = null
/** 主窗口。 */
let mainWindow = null
/** 托盘图标。 */
let tray = null

/** 启动 app（网关那一套）。 */
async function startGatewayApp() {
  // 主进程是 CommonJS，但我们的代码是 ESM。用动态 import 加载。
  const { startApp } = await import(path.join(__dirname, '..', 'src', 'app.js'))
  return startApp({
    logger: {
      log: (...args) => console.log('[app]', ...args),
      warn: (...args) => console.warn('[app]', ...args),
      error: (...args) => console.error('[app]', ...args),
    },
  })
}

/** 创建主窗口。 */
function createWindow() {
  const apiKey = gatewayApp?.apiKey ?? ''

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    title: '白用 AI · BaiUse',
    backgroundColor: '#f4f9fd',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      // 把 API Key 注入渲染进程，管理页面不用手输
      additionalArguments: [`--ofm-api-key=${apiKey}`],
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadURL(`${gatewayApp.url}/app`)

  // 外部链接用系统浏览器打开，不在 app 里开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('close', event => {
    // 关闭窗口时最小化到托盘，而不是退出 —— 网关得继续跑，
    // 否则 Codex CLI 一下就连不上了。
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

/** 创建托盘。 */
function createTray() {
  // 用一个空的小图标 —— macOS 托盘需要模板图（纯黑 + alpha）
  const image = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR42mNkYPhfz0AEYBxViKmQBBVAS8v8G/CtLgUQatSVIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRIkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkhY0EAAAAASUVORK5CYII=',
  )
  image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('白用 AI · BaiUse')
  refreshTrayMenu()
  tray.on('click', () => {
    if (mainWindow === null) createWindow()
    else mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
  })
}

/** 重建托盘菜单。 */
function refreshTrayMenu() {
  if (tray === null) return
  const url = gatewayApp?.url ?? '未启动'
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `网关：${url}`, enabled: false },
    { type: 'separator' },
    { label: '打开管理界面', click: () => { if (mainWindow === null) createWindow(); else mainWindow.show() } },
    {
      label: '复制 Codex 接入配方',
      click: () => {
        const key = gatewayApp?.apiKey ?? ''
        const recipe = [
          'model_provider = "ofm"',
          '',
          '[model_providers.ofm]',
          'name = "BaiUse"',
          `base_url = "${url}/v1"`,
          'wire_api = "responses"',
          'env_key = "OFM_API_KEY"',
          '',
          `export OFM_API_KEY="${key}"`,
        ].join('\n')
        require('electron').clipboard.writeText(recipe)
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { app.isQuitting = true; app.quit() },
    },
  ]))
}

// 单实例：第二次启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) createWindow()
    else mainWindow.show()
  })

  app.whenReady().then(async () => {
    try {
      gatewayApp = await startGatewayApp()
    } catch (error) {
      console.error('启动失败：', error)
      app.quit()
      return
    }

    createWindow()
    createTray()

    // macOS：点击 Dock 图标时若没有窗口就新建
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else mainWindow?.show()
    })
  })
}

// 关窗不等于退出：托盘还在，网关继续跑
app.on('window-all-closed', event => {
  if (process.platform !== 'darwin') {
    // Windows/Linux：留到托盘
  }
})

app.on('before-quit', () => { app.isQuitting = true })

app.on('will-quit', async event => {
  if (gatewayApp === null) return
  event.preventDefault()
  const current = gatewayApp
  gatewayApp = null
  await current.close().catch(() => {})
  app.exit(0)
})
