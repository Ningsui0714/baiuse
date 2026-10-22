/**
 * Electron preload —— 把 API Key 安全地交给渲染进程。
 *
 * ## 为什么用 preload 而不是 additionalArguments
 *
 * `additionalArguments` 注入的参数会出现在 `process.argv` 里，
 * 但开了 `contextIsolation` + `sandbox` 之后，渲染进程**访问不到 `process`**。
 * preload 是唯一能在两者之间传值的受控通道。
 *
 * 这里只暴露一个只读的方法，不把整个 ipcRenderer 交出去。
 */

const { contextBridge } = require('electron')

/** 从命令行参数里取 key。 */
function injectedApiKey() {
  const arg = process.argv.find(item => item.startsWith('--ofm-api-key='))
  return arg ? arg.slice('--ofm-api-key='.length) : ''
}

contextBridge.exposeInMainWorld('ofm', {
  /** 本机网关的 API Key。 */
  apiKey: injectedApiKey(),
})
