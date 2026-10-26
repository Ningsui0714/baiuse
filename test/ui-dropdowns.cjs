/* Real Electron DOM regression; isolated fixture API, never reads or writes user settings. */
if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {env,stdio:'inherit'})
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ui-dropdowns-'))
app.setPath('userData', userData)
const channels = ['codearts', 'trae', 'copilot', 'gemini', 'qwen', 'kimi', 'codex']
const errors = [], writes = []
let server, win
const deadline = setTimeout(() => { console.error('UI test timed out'); app.exit(1) }, 25000)

app.whenReady().then(async () => {
  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture')
      const fixtures = {
        '/api/summary': { models:1, lanes:{channels,kilo:0,aggregate:0} },
        '/api/accounts': {accounts:[{id:'fixture',nickname:'演示账号（测试数据）',provider:'codearts',enabled:true,authenticated:true}]},
        '/api/models': {models:[{id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash',routeCount:2,routes:[{provider:'codearts',id:'codearts/deepseek-v4.1-flash'},{provider:'trae',id:'trae/DeepSeek V4.1 Flash 1017'}]}]},
        '/api/recipe': {recipe:''},
        '/api/settings': {settings:{}},
        '/api/aggregate': {enabled:true,providers:[
          {id:'configured',name:'Configured fixture',format:'openai-chat',models:[],setting:{enabled:true}},
          {id:'unconfigured',name:'Unconfigured fixture',format:'openai-chat',models:[],setting:null},
        ]},
        '/api/codex': {paths:{configPath:'/fixture/config.toml'},profiles:[
          {id:'ofm',name:'Local fixture',builtin:true,wireApi:'responses'},
          {id:'chat-fixture',name:'Chat fixture',wireApi:'chat'},
        ]},
        '/api/clients': {clients:[{id:'codex',paths:['/example/.codex/config.toml']}]},
      }
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('content-type', 'application/json')
        if (req.method !== 'GET' && !url.pathname.endsWith('/preview')) {
          writes.push(`${req.method} ${url.pathname}`)
          res.writeHead(405); res.end('{}'); return
        }
        const preview={files:[{path:'/example/.codex/config.toml',content:'model_provider = "ofm"\nmodel = "deepseek-v4.1-flash"\n\n[model_providers.ofm]\nname = "Codex Relay"\nbase_url = "http://127.0.0.1:48760/v1"\nwire_api = "responses"\nenv_key = "OFM_API_KEY"\n'}]}
        preview.files[0].content=preview.files[0].content.replace('127.0.0.1:48760',req.headers.host)
        res.end(JSON.stringify(url.pathname.endsWith('/preview') ? preview : fixtures[url.pathname] ?? {}))
        return
      }
      const name = url.pathname === '/app' ? 'index.html' : url.pathname.slice('/app/'.length)
      if (!['index.html','theme.css','base.css','channels.js','model-picker.js','clients.js'].includes(name)) {
        res.writeHead(404); res.end(); return
      }
      res.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html')
      res.end(fs.readFileSync(path.join(root,'ui',name)))
    })
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
    win = new BrowserWindow({show:false,width:1080,height:780,webPreferences:{
      preload:path.join(root,'electron/preload.cjs'),additionalArguments:['--ofm-api-key=ui-fixture-key'],
      contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,
    }})
    win.webContents.on('console-message', event => {
      if (event.level === 'error') errors.push(event.message)
    })
    await win.loadURL(`http://127.0.0.1:${server.address().port}/app#accounts`)
    const result = await win.webContents.executeJavaScript(`(${exercise.toString()})()`)
    assert.equal(writes.length,0,`Unexpected writes: ${writes}`)
    assert.deepEqual(errors,[])
    if (process.env.RELAY_UI_SCREENSHOTS) {
      const directory=path.resolve(process.env.RELAY_UI_SCREENSHOTS)
      fs.mkdirSync(directory,{recursive:true})
      win.setSize(1440,1180)
      async function snapshot(name,code) {
        await win.webContents.executeJavaScript(`(async()=>{${code};await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`)
        fs.writeFileSync(path.join(directory,name),(await win.webContents.capturePage()).toPNG())
      }
      await win.webContents.executeJavaScript(`const noMotion=document.createElement('style');noMotion.textContent='*{animation:none!important;transition:none!important}';document.head.append(noMotion);document.getElementById('toast').className='toast'`)
      await snapshot('account-channels.png',`state.summary.lanes.channels=['codearts','lobsterai','qoder','qodercn','trae','cline','loomy','raccoon','minimax','gemini','zcode'];renderOverview();document.querySelector('[data-tab="accounts"]').click();document.getElementById('providerSelectTrigger').click()`)
      await snapshot('client-hub.png',`document.querySelector('[data-tab="setup"]').click();document.querySelector('[data-client="codex"]').click();await clientHub.refresh();for(let i=0;i<100&&document.getElementById('clientCode').textContent==='生成配置预览…';i++)await new Promise(r=>setTimeout(r,10))`)
      console.log('Saved isolated fixture screenshots')
    }
    console.log(`PASS: ${result} Electron dropdown checks; no user settings or account writes`)
    finish(0)
  } catch (error) { console.error(error.stack); finish(1) }
})

function finish(code) {
  clearTimeout(deadline)
  win?.destroy()
  server?.close()
  fs.rmSync(userData,{recursive:true,force:true})
  app.exit(code)
}

async function exercise() {
  let checks = 0
  const check = (condition,message) => { if(!condition)throw new Error(message); checks++ }
  const el = id => document.getElementById(id)
  const tick = () => new Promise(resolve=>setTimeout(resolve,30))
  const key = (node,value) => node.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}))
  const open = id => { el(id+'Trigger').click(); check(el(id+'Popup').matches(':popover-open'),`${id}: top-layer popup open`) }
  const search = (id,value) => { const input=el(id+'Search');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true})) }
  const choose = (id,value) => el(id+'List').querySelector(`[data-model-value="${value}"]`).click()
  for(let i=0;i<100 && !state.loaded;i++)await tick()
  check(state.loaded && !state.error,`Bootstrap failed: ${state.error}`)
  check(document.querySelectorAll('select,datalist').length===0,'No native dropdowns anywhere')
  for(const id of ['providerSelect','providerFilter','providerFormat','profileWireInput']) {
    check(el(id).type==='hidden' && el(id+'Trigger').type==='button',`${id}: app-owned control mounted`)
  }
  check(el('providerSelect').value==='codearts','Dynamic channel default selected')
  check(el('providerSelectCurrent').textContent==='CodeArts 码道 · 华为云','Channel trigger includes Chinese product and vendor')
  check(el('accountList').textContent.includes('CodeArts 码道 · 华为云'),'Account table shares vendor labels')
  check(el('channels').textContent.includes('TRAE · 字节跳动'),'Overview shares vendor labels')
  open('providerSelect')
  check(el('providerSelectList').children.length===7,'All channels present')
  search('providerSelect','华为云')
  check(el('providerSelectList').querySelector('[data-model-value="codearts"]')!==null && el('providerSelectList').children.length===1,'Search by Chinese vendor')
  search('providerSelect','TRAE')
  check(el('providerSelectList').children.length===1,'Case-insensitive channel search')
  choose('providerSelect','trae')
  check(el('providerSelect').value==='trae' && el('providerSelectCurrent').textContent==='TRAE · 字节跳动','Vendor labels retain raw provider values')
  check(document.activeElement===el('providerSelectTrigger'),'Selection restores focus to trigger')
  renderOverview()
  check(el('providerSelect').value==='trae','Polling preserves selected channel')
  open('providerSelect');search('providerSelect','not-found')
  check(!!el('providerSelectList').querySelector('.model-picker-empty'),'Empty search state')
  el('providerSelectClear').click()
  check(el('providerSelectList').children.length===7 && el('providerSelectSearch').value==='','Clear restores all options')
  key(el('providerSelectSearch'),'Home');key(el('providerSelectSearch'),'Enter')
  check(el('providerSelect').value==='codearts','Keyboard Home/Enter selects channel')
  open('providerSelect');key(el('providerSelectSearch'),'End');key(el('providerSelectSearch'),'Escape')
  check(el('providerSelect').value==='codearts' && el('providerSelectPopup').hidden,'Escape cancels without changing selection')
  goToAccountChannel('trae')
  check(el('providerSelectCurrent').textContent==='TRAE · 字节跳动','Programmatic channel navigation synchronizes trigger')
  const original = state.summary.lanes.channels
  state.summary.lanes.channels=[];renderOverview()
  check(el('providerSelectTrigger').disabled && el('providerSelect').value==='','Empty channel list disabled')
  state.summary.lanes.channels=original;renderOverview()
  check(!el('providerSelectTrigger').disabled && el('providerSelect').value==='codearts','New channel list re-enables selection')
  open('providerSelect');document.querySelector('[data-tab="aggregate"]').click()
  check(el('providerSelectPopup').hidden,'Navigating closes any open dropdown')
  open('providerFilter');choose('providerFilter','configured')
  check(el('providerFilter').value==='configured' && el('providerList').querySelectorAll('tbody tr').length===1,'Filter dispatches change and filters rows')
  open('providerFilter');choose('providerFilter','unconfigured')
  check(el('providerList').querySelector('[data-provider="unconfigured"]')!==null,'Unconfigured filter remains functional')
  el('addCustomProviderBtn').click()
  check(el('providerDialog').open && el('providerFormat').value==='openai-chat','Custom provider dialog initializes protocol')
  open('providerFormat');await tick()
  const searchRect=el('providerFormatSearch').getBoundingClientRect()
  check(el('providerFormatPopup').contains(document.elementFromPoint(searchRect.x+5,searchRect.y+5)),'Popover renders above modal dialog')
  search('providerFormat','/v1/messages');key(el('providerFormatSearch'),'Enter')
  check(el('providerFormat').value==='anthropic-messages' && el('providerFormatCurrent').textContent==='Anthropic Messages','Protocol search/selection preserves submitted value')
  open('providerFormat');key(el('providerFormatSearch'),'Escape')
  check(el('providerDialog').open && el('providerFormatPopup').hidden,'Escape closes dropdown, not enclosing modal')
  open('providerFormat');el('cancelProviderBtn').click();await tick()
  check(!el('providerDialog').open && el('providerFormatPopup').hidden,`Cancel closes modal and popup: dialog=${el('providerDialog').open}, popup hidden=${el('providerFormatPopup').hidden}`)
  el('addCustomProviderBtn').click()
  check(el('providerFormatCurrent').textContent==='OpenAI Chat Completions','Reopening resets displayed protocol consistently')
  el('cancelProviderBtn').click();await tick()
  openProfileDialog('chat-fixture')
  check(el('profileWireInputCurrent').textContent==='chat','Editing existing profile synchronizes selected protocol')
  open('profileWireInput');choose('profileWireInput','responses')
  check(el('profileWireInput').value==='responses','Profile protocol selection uses original wire_api value')
  closeProfileDialog();await tick();openProfileDialog('ofm')
  check(el('profileWireInputTrigger').disabled,'Built-in profile protocol stays read-only')
  closeProfileDialog();await tick();openProfileDialog()
  check(!el('profileWireInputTrigger').disabled,'New profile protocol re-enabled')
  closeProfileDialog();await tick()
  document.querySelector('[data-tab="setup"]').click()
  document.querySelector('[data-client="codex"]').click()
  open('clientModel')
  check(el('clientModelList').textContent.includes('DeepSeek V4.1 Flash'),'Unified model picker still works')
  choose('clientModel','deepseek-v4.1-flash')
  check(el('clientModel').value==='deepseek-v4.1-flash','Unified model ID unchanged')
  // Ensure option labels are text, not executable markup.
  AppSelect.setOptions('providerSelect',[{value:'fixture',label:'<img src=x onerror=alert(1)>'}])
  document.querySelector('[data-tab="accounts"]').click();open('providerSelect')
  check(!el('providerSelectList').querySelector('img') && el('providerSelectList').textContent.includes('<img'),'Option labels escaped')
  AppSelect.closeAll()
  check(document.querySelectorAll(':popover-open').length===0,'No orphan popovers remain')
  return checks
}
