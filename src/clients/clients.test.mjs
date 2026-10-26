import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { parse } from 'jsonc-parser'
import { CLIENTS, DESKTOP_MODEL, clientPreview, connectClient, restoreClient, listClients } from './config.mjs'
import { messagesToChat, geminiToChat } from './protocols.mjs'
import { payloadToChunks } from '../lanes/sse.js'
import { createResponseAssembler } from './responses.mjs'
import { startGateway } from '../gateway.js'
import { createManagementHandler } from '../management.js'
import { createLanes } from '../lanes/index.js'

function fixture(t, platform = 'darwin') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-clients-'))
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }))
  return { home:path.join(dir,'home'), dataDir:path.join(dir,'data'), platform, env:{}, gatewayUrl:'http://127.0.0.1:48760', apiKey:'test-local-key', model:'demo/model' }
}
function write(file, value) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,value) }
const read = file => fs.readFileSync(file,'utf8')
const readJson = file => parse(read(file))

test('Codex 接入入口统一命名，说明桌面版与 CLI 共用配置', () => {
  const client=CLIENTS.find(client=>client.id==='codex')
  assert.equal(client.name,'Codex')
  assert.match(client.note,/桌面版与 CLI 共用配置/)
})

test('白用 AI · BaiUse 品牌统一，仓库使用新名称，旧命令与应用标识保留兼容', () => {
  const pkg=readJson(new URL('../../package.json',import.meta.url))
  const html=read(new URL('../../ui/index.html',import.meta.url))
  assert.equal(pkg.name,'baiuse')
  assert.equal(pkg.build.productName,'BaiUse')
  assert.equal(pkg.build.appId,'com.ofm.codex-gateway')
  assert.equal(pkg.bin.baiuse,pkg.bin['codex-relay'])
  assert.equal(pkg.repository,'https://github.com/Ningsui0714/baiuse.git')
  assert.match(pkg.description,/一键白嫖，一键接入/)
  assert.doesNotMatch(pkg.description,/Kilo/)
  assert.match(html,/<title>白用 AI · BaiUse<\/title>/)
  assert.match(html,/<strong>白用 AI<\/strong>/)
  assert.match(html,/一键白嫖，一键接入。/)
  assert.doesNotMatch(html,/Codex Relay|本地 AI 网关|Kilo 免费池/)
  assert.match(read(new URL('../../src/store.js',import.meta.url)),/OFM Codex Gateway/)
  assert.match(read(new URL('../../electron/main.cjs',import.meta.url)),/title: '白用 AI · BaiUse'/)
})

test('品牌升级只改供应商显示名，Codex/OpenCode 接入和旧配置仍可还原', t => {
  const options=fixture(t), config=path.join(options.home,'.codex/config.toml'), auth=path.join(options.home,'.codex/auth.json')
  const original='model_provider = "ofm"\nmodel = "old/model"\n\n[model_providers.ofm]\nname = "Codex Relay"\nbase_url = "http://127.0.0.1:48760/v1"\nwire_api = "responses"\n'
  write(config,original);write(auth,'{"fixture":"unchanged-official-login"}')
  connectClient('codex',options)
  assert.match(read(config),/name = "BaiUse"/)
  assert.match(read(config),/model_provider = "ofm"/)
  assert.equal(read(auth),'{"fixture":"unchanged-official-login"}')
  restoreClient('codex',options)
  assert.equal(read(config),original)
  const file=path.join(options.home,'.config/opencode/opencode.jsonc')
  const before='// Keep original provider ID\n{"provider":{"codex-relay":{"name":"Codex Relay"},"other":{"name":"Other"}},"model":"codex-relay/old-model"}\n'
  write(file,before)
  connectClient('opencode',options)
  const after=readJson(file)
  assert.equal(after.provider['codex-relay'].name,'BaiUse')
  assert.equal(after.model,'codex-relay/demo/model')
  assert.equal(after.provider.other.name,'Other')
  assert.equal(Object.keys(after.provider).length,2)
  restoreClient('opencode',options)
  assert.equal(read(file),before)
})

test('Responses 文本/工具有稳定 ID 与完整结束项，渠道用量不是 camelCase 透传', () => {
  const events = []
  const assembler = createResponseAssembler({responseId:'resp-test',model:'codearts/test',createdAt:1,emit:(type,value)=>events.push(structuredClone(value))})
  assembler.start()
  assembler.consume({type:'text-delta',text:'hello'})
  assembler.consume({type:'tool-call-delta',index:0,id:'call-1',name:'read',argumentsDelta:'{"path":'})
  assembler.consume({type:'tool-call-delta',index:0,argumentsDelta:'"file"}'})
  assembler.consume({type:'finish',reason:{kind:'stop'},usage:{inputTokens:20,outputTokens:10}})
  const result = assembler.finish()
  assert.equal(result.usage.input_tokens,20)
  assert.equal(result.usage.inputTokens,undefined)
  assert.equal(result.output[1].type,'function_call')
  assert.equal(result.output[1].call_id,'call-1')
  assert.equal(result.output[1].arguments,'{"path":"file"}')
  for (const item of result.output) {
    assert.ok(events.some(e=>e.type==='response.output_item.added'&&e.item.id===item.id))
    assert.ok(events.some(e=>e.type==='response.output_item.done'&&e.item.id===item.id))
  }
})

test('真实上游截断明确返回 incomplete，不伪装为 completed', () => {
  const events=[]
  const assembler=createResponseAssembler({responseId:'resp-cut',model:'demo/model',createdAt:1,emit:(type)=>events.push(type)})
  assembler.consume({type:'text-delta',text:'partial'})
  assembler.consume({type:'finish',reason:{kind:'max-tokens'}})
  const result=assembler.finish()
  assert.equal(result.status,'incomplete')
  assert.equal(result.incomplete_details.reason,'max_output_tokens')
  assert.ok(events.includes('response.incomplete'))
  assert.ok(!events.includes('response.completed'))
})

test('长输入和大输出预算不被接入协议转换静默压缩', async t => {
  const inputSize=33*1024*1024 // 超过原网关 32MB 人为上限，仅走本地夹具，不消耗账号额度。
  const g = await gateway(t, (request,onChunk) => {
    assert.equal(request.body.messages[0].content.length,inputSize)
    assert.equal(request.body.max_tokens,131072)
    onChunk({type:'text-delta',text:'x'.repeat(100000)})
    onChunk({type:'finish',reason:{kind:'stop'},usage:{inputTokens:10000,outputTokens:25000}})
  })
  const response = await g.call('/v1/messages',{model:'demo/model',max_tokens:131072,messages:[{role:'user',content:'y'.repeat(inputSize)}]})
  const body = await response.json()
  assert.equal(response.status,200)
  assert.equal(body.content[0].text.length,100000)
  assert.equal(body.usage.output_tokens,25000)
})

test('所有客户端配置均接受账号渠道的 DeepSeek 模型，而非只接受 Kilo', t => {
  const options = { ...fixture(t), model: 'codearts/fixture-deepseek' }
  for (const client of CLIENTS) {
    const preview = clientPreview(client.id, options)
    assert.match(preview.files.map(file => file.content).join('\n'), /codearts\/fixture-deepseek/)
  }
})

test('五个客户端共享应用内统一模型选择器，不显示厂商前缀', () => {
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML:'', value:'', dataset:{}, listeners:{}, setAttribute(){}, addEventListener(event, handler){this.listeners[event]=handler} })
    return elements.get(id)
  }
  const state = { loaded:false, models:[
    { id:'deepseek-v4.1-flash', name:'DeepSeek V4.1 Flash', lane:'pool',routeCount:2,routes:[{id:'codearts/deepseek-v4.1-flash',provider:'codearts'},{id:'trae/DeepseekV4.1 Flash 1017',provider:'trae'}] },
    { id:'kilo-auto/free', owned_by:'kilo', lane:'kilo' },
    { id:'deepseek/deepseek-chat', owned_by:'deepseek', lane:'aggregate' },
  ], accounts:[{ provider:'codearts', authenticated:false }], summary:{url:'http://127.0.0.1:9999'} }
  const window={};vm.runInNewContext(read(new URL('../../ui/channels.js',import.meta.url)),{window})
  vm.runInNewContext(read(new URL('../../ui/model-picker.js',import.meta.url)),{window})
  let pickerState,choose
  window.ModelPicker.create=options=>{choose=options.onChange;return{close(){},update(value){pickerState=value}}}
  vm.runInNewContext(read(new URL('../../ui/clients.js',import.meta.url)), {
    state, document:{getElementById:element}, window, apiKey:'', location:{origin:'http://127.0.0.1:9999'},
    escapeHtml:value=>String(value),
  })
  for (const client of CLIENTS) {
    element('clientTabs').listeners.click({target:{closest:()=>({dataset:{client:client.id}})}})
    assert.equal(pickerState.items[0].value,'deepseek-v4.1-flash')
    assert.equal(pickerState.items[0].label,'DeepSeek V4.1 Flash')
    assert.equal(pickerState.items[0].count,2)
    choose('deepseek-v4.1-flash')
    assert.equal(element('clientModel').value,'deepseek-v4.1-flash')
  }
  assert.match(element('clientModelSources').innerHTML, /账号尚未完成授权/)
  assert.match(element('clientModelSources').innerHTML, /data-source-login="codearts"/)
})

test('应用内下拉支持模型名/版本多词搜索，保留全部模型而不按厂商拆开', () => {
  const window={};vm.runInNewContext(read(new URL('../../ui/model-picker.js',import.meta.url)),{window})
  const data=window.ModelPicker.itemsFor([{id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash',providerCount:2},{id:'deepseek-v4.1-pro',name:'DeepSeek V4.1 Pro',providerCount:1}])
  assert.equal(window.ModelPicker.filter(data,'DeepSeek flash').length,1)
  assert.equal(window.ModelPicker.filter(data,'v4.1').length,2)
  assert.equal(window.ModelPicker.filter(data,'missing').length,0)
  assert.equal(window.ModelPicker.filter(data,'').length,2)
  assert.ok(!data[0].label.includes('CodeArts'))
})

test('账号渠道、过滤和弹窗协议全部使用应用内下拉，初始化早于页面渲染', () => {
  const html=read(new URL('../../ui/index.html',import.meta.url))
  assert.doesNotMatch(html,/<(?:select|option|datalist)\b/i)
  assert.equal((html.match(/data-app-select\b/g)??[]).length,4)
  for(const id of ['providerSelect','providerFilter','providerFormat','profileWireInput']) {
    assert.match(html,new RegExp(`<input id="${id}" type="hidden"`))
  }
  assert.ok(html.indexOf('src="/app/model-picker.js"')<html.indexOf('window.AppSelect.mountAll()'))
  assert.match(html,/AppSelect\.setOptions\('providerSelect'/)
  for(const id of ['providerSelect','providerFormat','profileWireInput'])assert.match(html,new RegExp(`AppSelect\\.sync\\('${id}'\\)`))
})

test('账号渠道显示中文名及所属厂商，搜索中文且保留真实渠道标识', () => {
  const window={};vm.runInNewContext(read(new URL('../../ui/channels.js',import.meta.url)),{window})
  vm.runInNewContext(read(new URL('../../ui/model-picker.js',import.meta.url)),{window})
  const display=window.ChannelDisplay
  assert.equal(display.label('trae'),'TRAE · 字节跳动')
  assert.equal(display.label('codearts'),'CodeArts 码道 · 华为云')
  assert.match(display.label('lobsterai'),/有道龙虾.*网易有道/)
  assert.match(display.label('loomy'),/科大讯飞/)
  assert.match(display.label('raccoon'),/小浣熊.*商汤/)
  assert.match(display.label('qodercn'),/中国版.*阿里云/)
  assert.match(display.label('gemini'),/谷歌 Google/)
  assert.match(display.label('zcode'),/智谱/)
  assert.equal(display.label('future-channel'),'future-channel')
  assert.equal(display.label('__proto__'),'__proto__')
  const options=['trae','codearts','raccoon'].map(display.option)
  assert.equal(window.ModelPicker.filter(options,'华为云')[0].value,'codearts')
  assert.equal(window.ModelPicker.filter(options,'字节')[0].value,'trae')
  assert.equal(window.ModelPicker.filter(options,'小浣熊')[0].value,'raccoon')
  assert.equal(display.option('codearts').value,'codearts')
})

test('五类协议使用同一逻辑模型，配额耗尽自动切到 TRAE 日期变体（夹具）',async t=>{
  const seen=[],routes=[{id:'codearts/deepseek-v4.1-flash',owned_by:'codearts'},{id:'trae/DeepSeek V4.1 Flash 1017',owned_by:'trae'}]
  const channels={providers:['codearts','trae'],publicModelRows:()=>routes,handles:model=>/^(codearts|trae)\//.test(model),complete:async(request,onChunk)=>{
    seen.push(request.model)
    if(request.model.startsWith('codearts/'))throw Object.assign(new Error('quota exhausted'),{status:429})
    assert.equal((request.openAi??request.responsesBody).model,routes[1].id)
    onChunk({type:'text-delta',text:'pooled-ok'});onChunk({type:'finish',reason:{kind:'stop'}})
    return {text:'pooled-ok',toolCalls:[]}
  }}
  const lanes=createLanes({channels,settings:{get:()=>({aggregate:{}})}})
  const model='deepseek-v4.1-flash',g=await startGateway({lanes,port:0,desktopModel:()=>model})
  t.after(()=>g.close())
  const directory=await (await fetch(g.url+'/v1/models')).json()
  assert.equal(directory.data.length,1)
  assert.equal(directory.data[0].id,model)
  for(const [url,body] of [
    ['/v1/responses',{model,input:'hi'}],
    ['/v1/messages',{model,messages:[{role:'user',content:'hi'}]}],
    ['/v1/chat/completions',{model,messages:[{role:'user',content:'hi'}]}],
    [`/v1beta/models/${model}:generateContent`,{contents:[{role:'user',parts:[{text:'hi'}]}]}],
    ['/claude-desktop/v1/messages',{model:DESKTOP_MODEL,messages:[{role:'user',content:'hi'}]}],
  ]) {
    const response=await fetch(g.url+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    assert.equal(response.status,200)
    assert.match(await response.text(),/pooled-ok/)
  }
  assert.equal(seen[0],routes[0].id)
  assert.equal(seen[1],routes[1].id)
  assert.equal(seen.slice(1).every(model=>model===routes[1].id),true)
})

test('模型数量不变但内容变化时也更新客户端下拉', async () => {
  const html = read(new URL('../../ui/index.html',import.meta.url))
  const code = html.slice(html.indexOf('let reconciling = false;'), html.indexOf('/** 轮询：'))
  const state = { summary:{models:1}, models:[{id:'old-model'}] }
  let renders = 0
  const result = vm.runInNewContext(`${code}\nreconcileModels();`, {
    state, api:async()=>({models:[{id:'codearts/fixture-deepseek'}]}),
    renderModels(){}, renderSteps(){}, renderCodex(){}, window:{clientHub:{render(){renders++}}},
  })
  await result
  assert.equal(state.models[0].id, 'codearts/fixture-deepseek')
  assert.equal(renders, 1)
})

for (const id of CLIENTS.filter(c => c.id !== 'claude-desktop').map(c => c.id)) {
  test(`${id}: preview is read-only, connect writes, repeated switch retains first backup, restore round-trips`, t => {
    const options = fixture(t)
    const first = clientPreview(id,options)
    assert.ok(first.files.length)
    for (const file of first.files) assert.equal(fs.existsSync(file.path),false)
    connectClient(id,options)
    const status = listClients(options).find(c => c.id === id)
    assert.equal(status.configured,true)
    connectClient(id,{...options,model:'demo/other'})
    restoreClient(id,options)
    assert.equal(listClients(options).find(c => c.id === id).managed,false)
    for (const file of first.files) assert.equal(fs.existsSync(file.path),false)
  })
}

test('Claude Code: preserve comments, permissions, hooks and MCP; remove competing auth/backend keys', t => {
  const o = fixture(t), file = path.join(o.home,'.claude/settings.json')
  const original = '{\n// my hooks\n"env":{"OTHER":"yes","ANTHROPIC_API_KEY":"old","CLAUDE_CODE_USE_VERTEX":"1"},"permissions":{"allow":["Read"]},"hooks":{"Stop":[]},"apiKeyHelper":"my-helper",\n}'
  write(file,original)
  connectClient('claude',o)
  assert.match(read(file),/my hooks/)
  const value = readJson(file)
  assert.deepEqual(value.permissions,{allow:['Read']})
  assert.equal(value.env.OTHER,'yes')
  assert.equal(value.env.ANTHROPIC_API_KEY,undefined)
  assert.equal(value.env.CLAUDE_CODE_USE_VERTEX,undefined)
  assert.equal(value.apiKeyHelper,undefined)
  assert.equal(value.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,o.model)
  restoreClient('claude',o)
  assert.equal(read(file),original)
})

test('Gemini: preserve .env comments, custom variables and MCP; both files restored byte-for-byte', t => {
  const o=fixture(t), env=path.join(o.home,'.gemini/.env'), settings=path.join(o.home,'.gemini/settings.json')
  const original='# keep me\r\nOTHER=mine\r\nGEMINI_API_KEY=old\r\nGEMINI_API_KEY=duplicate\r\n'
  write(env,original); write(settings,'{"mcpServers":{"local":{}},"security":{"auth":{"selectedType":"oauth-personal"}}}')
  const before=read(settings)
  connectClient('gemini',o)
  assert.match(read(env),/# keep me\r\nOTHER=mine/)
  assert.equal((read(env).match(/GEMINI_API_KEY=/g)??[]).length,1)
  assert.equal(readJson(settings).security.auth.selectedType,'gemini-api-key')
  assert.deepEqual(readJson(settings).mcpServers,{local:{}})
  restoreClient('gemini',o)
  assert.equal(read(env),original); assert.equal(read(settings),before)
})

test('Malformed second Gemini file: no partial writes, no backup claims', t => {
  const o=fixture(t), env=path.join(o.home,'.gemini/.env'), settings=path.join(o.home,'.gemini/settings.json')
  write(env,'OTHER=mine\n');write(settings,'{"broken":')
  assert.throws(()=>connectClient('gemini',o),/配置解析失败/)
  assert.equal(read(env),'OTHER=mine\n')
  assert.equal(fs.existsSync(path.join(o.dataDir,'client-backups/gemini.json')),false)
})

test('Unexpected nested shapes are rejected, not replaced', t => {
  const o=fixture(t), file=path.join(o.home,'.claude/settings.json')
  write(file,'{"env":[]}')
  assert.throws(()=>connectClient('claude',o),/应为对象/)
  assert.equal(read(file),'{"env":[]}')
})

test('OpenCode: prefer JSONC, retain comments/providers/MCP, native compatible SDK and namespaced default', t => {
  const o=fixture(t), file=path.join(o.home,'.config/opencode/opencode.jsonc')
  const original='{// private provider\n"provider":{"mine":{"name":"Mine"}},"mcp":{"docs":{}},"theme":"light",}'
  write(file,original)
  connectClient('opencode',o)
  const value=readJson(file)
  assert.equal(value.provider.mine.name,'Mine');assert.ok(value.mcp.docs)
  assert.equal(value.provider['codex-relay'].npm,'@ai-sdk/openai-compatible')
  assert.equal(value.model,'codex-relay/demo/model')
  assert.match(read(file),/private provider/)
  restoreClient('opencode',o);assert.equal(read(file),original)
})

test('Claude Desktop prepares in-app parameters without writing any Claude files',t=>{
  const o=fixture(t), preview=clientPreview('claude-desktop',o)
  assert.equal(preview.mode,'in-app')
  const params=JSON.parse(preview.files[0].content)
  assert.equal(params.inferenceGatewayBaseUrl,`${o.gatewayUrl}/claude-desktop`)
  assert.deepEqual(params.inferenceModels,[{name:DESKTOP_MODEL,labelOverride:o.model}])
  const result=connectClient('claude-desktop',o)
  assert.equal(result.prepared,true)
  assert.equal(fs.existsSync(o.home),false)
  assert.equal(fs.existsSync(o.dataDir),false)
  const record=listClients({...o,desktopModel:o.model}).find(c=>c.id==='claude-desktop')
  assert.equal(record.prepared,true);assert.equal(record.configured,false)
})

test('Restore preserves subsequent unrelated changes', t => {
  const o=fixture(t), file=path.join(o.home,'.claude/settings.json')
  write(file,'{"env":{"OTHER":"1"},"theme":"old"}')
  connectClient('claude',o)
  const value=readJson(file);value.theme='new';write(file,JSON.stringify(value))
  restoreClient('claude',o)
  assert.equal(readJson(file).theme,'new')
  assert.deepEqual(readJson(file).env,{OTHER:'1'})
})

test('Restore conflict is all-or-nothing and retains backup', t => {
  const o=fixture(t), files=clientPreview('gemini',o).files
  connectClient('gemini',o)
  const envBefore=read(files[0].path)
  const value=readJson(files[1].path);value.model.name='someone-else';write(files[1].path,JSON.stringify(value))
  assert.throws(()=>restoreClient('gemini',o),error=>error.status===409)
  assert.equal(read(files[0].path),envBefore)
  assert.equal(fs.existsSync(path.join(o.dataDir,'client-backups/gemini.json')),true)
})

test('Deleted/changed native file is not falsely reported as configured', t => {
  const o=fixture(t);connectClient('claude',o)
  fs.unlinkSync(path.join(o.home,'.claude/settings.json'))
  const status=listClients(o).find(c=>c.id==='claude')
  assert.equal(status.configured,false);assert.equal(status.managed,true)
})

test('Do not break symlink-managed dotfiles', t => {
  const o=fixture(t), file=path.join(o.home,'.claude/settings.json'), target=path.join(o.home,'dotfiles/settings.json')
  write(target,'{}');fs.mkdirSync(path.dirname(file),{recursive:true});fs.symlinkSync(target,file)
  assert.throws(()=>connectClient('claude',o),/符号链接/)
  assert.equal(fs.lstatSync(file).isSymbolicLink(),true)
})

test('Reject unknown client and blank/control-character models', t => {
  const o=fixture(t)
  assert.throws(()=>connectClient('unknown',o),error=>error.status===404)
  for (const model of ['',undefined,'test\ninvalid']) assert.throws(()=>connectClient('claude',{...o,model}),/模型/)
})

test('Messages conversion: system, images, tool use, results, max tokens and tool selection', () => {
  const result=messagesToChat({model:'x',system:[{type:'text',text:'system'}],max_tokens:123,tool_choice:{type:'tool',name:'read'},tools:[{name:'read',input_schema:{type:'object'}}],messages:[
    {role:'user',content:[{type:'text',text:'hi'},{type:'image',source:{type:'base64',media_type:'image/png',data:'ABC'}}]},
    {role:'assistant',content:[{type:'tool_use',id:'tool-1',name:'read',input:{path:'x'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content:'result'},{type:'text',text:'next'}]},
  ]})
  assert.equal(result.messages[0].role,'system');assert.equal(result.messages[1].content[1].image_url.url,'data:image/png;base64,ABC')
  assert.equal(result.messages[2].tool_calls[0].function.name,'read')
  assert.equal(result.messages[3].tool_call_id,'tool-1');assert.equal(result.messages[4].role,'user')
  assert.equal(result.max_tokens,123);assert.equal(result.tool_choice.function.name,'read')
})

test('Gemini conversion: preserve matching function call/output IDs and parameters',()=>{
  const result=geminiToChat({systemInstruction:{parts:[{text:'system'}]},tools:[{functionDeclarations:[{name:'read',parametersJsonSchema:{type:'object'}}]}],contents:[
    {role:'model',parts:[{functionCall:{name:'read',args:{path:'x'}}}]},
    {role:'user',parts:[{functionResponse:{name:'read',response:{result:'ok'}}}]},
  ]},'model')
  assert.equal(result.messages[1].tool_calls[0].id,result.messages[2].tool_call_id)
  assert.equal(result.tools[0].function.parameters.type,'object')
})

test('Unsupported content and server-side tools fail explicitly instead of silently losing data',()=>{
  assert.throws(()=>messagesToChat({messages:[{role:'user',content:[{type:'document'}]}]}),/内容类型/)
  assert.throws(()=>geminiToChat({contents:[],tools:[{googleSearch:{}}]},'x'),/服务端工具/)
})

test('Lane conversion retains parallel tools and native tool start metadata',()=>{
  const tools=payloadToChunks(JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'1',function:{name:'a',arguments:'{}'}},{index:1,id:'2',function:{name:'b',arguments:'{}'}}]}}]}))
  assert.equal(tools.length,2);assert.equal(tools[1].name,'b')
  assert.equal(payloadToChunks(JSON.stringify({type:'content_block_start',index:2,content_block:{type:'tool_use',id:'id',name:'read'}}))[0].name,'read')
  assert.equal(payloadToChunks(JSON.stringify({type:'response.output_item.added',output_index:1,item:{type:'function_call',call_id:'c',name:'read'}}))[0].id,'c')
})

async function gateway(t,behavior) {
  const options=fixture(t)
  const calls=[]
  const lanes={channels:{providers:['demo']},kiloModels:[],aggregateCatalog:()=>[],modelRows:()=>[{id:'demo/model'}],resolve:()=>({lane:'channel'}),complete:async(request,onChunk)=>{
    calls.push(request)
    if (behavior) return behavior(request,onChunk)
    onChunk({type:'text-delta',text:'hello'})
    onChunk({type:'tool-call-delta',index:0,id:'call-1',name:'read',argumentsDelta:'{"path":'})
    onChunk({type:'tool-call-delta',index:0,argumentsDelta:'"file"}'})
    onChunk({type:'finish',reason:{kind:'stop'},usage:{prompt_tokens:12,completion_tokens:7}})
  }}
  let saved={desktopModel:'demo/model'}
  const app={clientOptions:options,dataDir:options.dataDir,url:options.gatewayUrl,apiKey:options.apiKey,lanes,settings:{get:()=>saved,update:patch=>(saved={...saved,...patch})}}
  const server=await startGateway({lanes,apiKey:options.apiKey,port:0,desktopModel:()=>saved.desktopModel,management:createManagementHandler({app,apiKey:options.apiKey})})
  t.after(()=>server.close());app.url=server.url;app.gateway=server
  return {server,options,app,calls,call:(url,body,headers={authorization:`Bearer ${options.apiKey}`},method='POST')=>fetch(`${server.url}${url}`,{method,headers:{'content-type':'application/json',...headers},...(method==='GET'?{}:{body:JSON.stringify(body)})})}
}
const paths={anthropic:'/v1/messages',chat:'/v1/chat/completions',gemini:'/v1beta/models/demo%2Fmodel:generateContent'}
test('账号渠道的 DeepSeek 在五类客户端协议中均保持原模型 ID 转发（本地夹具）', async t => {
  const g = await gateway(t)
  const model = 'codearts/fixture-deepseek'
  g.app.lanes.modelRows = () => [{ id:model, owned_by:'codearts', lane:'channel' }]
  g.app.lanes.channels.providers = ['codearts']
  g.app.settings.update({desktopModel:model})
  const requests = [
    ['/v1/responses', {model, input:'hello'}],
    ['/v1/messages', {model, max_tokens:64, messages:[{role:'user',content:'hello'}]}],
    ['/v1/chat/completions', {model, messages:[{role:'user',content:'hello'}]}],
    [`/v1beta/models/${encodeURIComponent(model)}:generateContent`, {contents:[{role:'user',parts:[{text:'hello'}]}]}],
    ['/claude-desktop/v1/messages', {model:DESKTOP_MODEL, max_tokens:64, messages:[{role:'user',content:'hello'}]}],
  ]
  for (const [url, body] of requests) {
    const response = await g.call(url, body)
    assert.equal(response.status, 200, `${url}: ${await response.text()}`)
    assert.equal(g.calls.at(-1).model, model)
  }
  assert.equal(g.calls.length, 5)
})

for (const protocol of ['anthropic','chat','gemini']) {
  for (const streaming of [false,true]) {
    test(`${protocol} HTTP ${streaming?'stream':'JSON'}: text, tools, usage, finish and native auth`, async t=>{
      const g=await gateway(t)
      const url=protocol==='gemini'&&streaming?paths.gemini.replace('generateContent','streamGenerateContent'):paths[protocol]
      const body=protocol==='gemini'?{contents:[{role:'user',parts:[{text:'hi'}]}]}:{model:'demo/model',messages:[{role:'user',content:'hi'}],stream:streaming,stream_options:{include_usage:true}}
      const headers=protocol==='anthropic'?{'x-api-key':g.options.apiKey}:protocol==='gemini'?{'x-goog-api-key':g.options.apiKey}:{authorization:`Bearer ${g.options.apiKey}`}
      const response=await g.call(url,body,headers)
      assert.equal(response.status,200)
      const text=await response.text()
      assert.match(text,/hello/);assert.match(text,/read/);assert.match(text,/file/)
      if (streaming) {
        assert.match(response.headers.get('content-type'),/text\/event-stream/)
        assert.match(text,protocol==='anthropic'?/message_stop/:protocol==='chat'?/\[DONE\]/:/finishReason/)
        if (protocol==='anthropic') assert.doesNotMatch(text,/\[DONE\]/)
      } else {
        const result=JSON.parse(text)
        assert.equal(protocol==='anthropic'?result.usage.input_tokens:protocol==='gemini'?result.usageMetadata.promptTokenCount:result.usage.prompt_tokens,12)
      }
      assert.equal(g.calls[0].responses,false);assert.equal(g.calls[0].body.messages[0].content instanceof Array || typeof g.calls[0].body.messages[0].content==='string',true)
    })
  }
}

test('Desktop alias is scoped to /claude-desktop, not global model names',async t=>{
  const g=await gateway(t)
  const response=await g.call('/claude-desktop/v1/messages',{model:DESKTOP_MODEL,messages:[{role:'user',content:'hi'}]})
  assert.equal(response.status,200);assert.equal(g.calls[0].model,'demo/model')
  assert.equal((await response.json()).model,DESKTOP_MODEL)
  const list=await g.call('/claude-desktop/v1/models',null,undefined,'GET')
  assert.equal((await list.json()).data[0].id,DESKTOP_MODEL)
})

test('Native endpoints reject bad auth and malformed bodies, enforce POST',async t=>{
  const g=await gateway(t)
  assert.equal((await g.call(paths.anthropic,{},{'x-api-key':'bad'})).status,401)
  assert.equal((await g.call(paths.chat,null)).status,400)
  assert.equal((await g.call(paths.chat,[],undefined)).status,400)
  assert.equal((await g.call(paths.chat,{},undefined,'GET')).status,405)
})

test('Native pre-stream upstream error retains HTTP status (no premature 200)',async t=>{
  const g=await gateway(t,()=>{throw Object.assign(new Error('quota'),{status:429})})
  const response=await g.call(paths.anthropic,{model:'demo/model',messages:[],stream:true})
  assert.equal(response.status,429);assert.match(await response.text(),/quota/)
})

test('Truncated output retains max-token finish reason',async t=>{
  const g=await gateway(t,(_request,onChunk)=>{onChunk({type:'text-delta',text:'cut'});onChunk({type:'finish',reason:{kind:'max-tokens'}})})
  const response=await g.call(paths.anthropic,{model:'demo/model',messages:[]})
  assert.equal((await response.json()).stop_reason,'max_tokens')
})

test('CountTokens compatibility is explicitly an estimate and does not invoke upstream',async t=>{
  const g=await gateway(t)
  const response=await g.call('/v1/messages/count_tokens',{model:'demo/model',messages:[{role:'user',content:'hello'}]})
  assert.equal(response.headers.get('x-relay-token-count'),'estimated')
  assert.ok((await response.json()).input_tokens>0);assert.equal(g.calls.length,0)
})

test('Management: list/preview/connect/restore auth, masking, model validation and desktop runtime mapping',async t=>{
  const g=await gateway(t)
  assert.equal((await g.call('/api/clients',null,{},'GET')).status,401)
  const list=await g.call('/api/clients',null,undefined,'GET');assert.equal((await list.json()).clients.length,5)
  const preview=await g.call('/api/clients/claude/preview',{model:'demo/model'})
  const payload=await preview.json()
  assert.match(payload.files[0].content,/••••••••/);assert.doesNotMatch(payload.files[0].content,/test-local-key/)
  assert.equal(fs.existsSync(payload.files[0].path),false)
  const raw=await g.call('/api/clients/claude/preview',{model:'demo/model',reveal:true})
  assert.match((await raw.json()).files[0].content,/test-local-key/)
  assert.equal((await g.call('/api/clients/claude/connect',{model:'not-in-catalog'})).status,400)
  assert.equal((await g.call('/api/clients/claude-desktop/connect',{model:'demo/model'})).status,200)
  assert.equal(g.app.settings.get().desktopModel,'demo/model')
  assert.equal(fs.existsSync(path.join(g.options.home,'Library/Application Support/Claude-3p')),false)
  const prepared=await g.call('/api/clients',null,undefined,'GET')
  assert.equal((await prepared.json()).clients.find(c=>c.id==='claude-desktop').configured,false)
  assert.equal((await g.call('/api/clients/claude-desktop/restore',{})).status,200)
  assert.equal(g.app.settings.get().desktopModel,'')
})

test('新接入配置写稳定逻辑标识，旧厂商前缀请求也会转换',async t=>{
  const g=await gateway(t),id='deepseek-v4.1-flash'
  g.app.lanes.modelRows=()=>[{id:`codearts/${id}`,owned_by:'codearts'}]
  g.app.lanes.clientModelRows=()=>[{id,name:'DeepSeek V4.1 Flash',routes:[{id:`codearts/${id}`}]}]
  const response=await g.call('/api/clients/claude/connect',{model:`codearts/${id}`})
  assert.equal(response.status,200)
  const config=readJson(path.join(g.options.home,'.claude/settings.json'))
  assert.equal(config.env.ANTHROPIC_MODEL,id)
  assert.equal(config.env.ANTHROPIC_DEFAULT_SONNET_MODEL,id)
})

test('Gemini function schemas normalize enum type casing recursively',()=>{
  const result=geminiToChat({contents:[],tools:[{functionDeclarations:[{name:'read',parameters:{type:'OBJECT',propertyOrdering:['file'],properties:{file:{type:'STRING'},files:{type:'ARRAY',items:{type:'STRING'}}}}}]}]},'x')
  assert.equal(result.tools[0].function.parameters.type,'object')
  assert.equal(result.tools[0].function.parameters.properties.file.type,'string')
  assert.equal(result.tools[0].function.parameters.properties.files.items.type,'string')
  assert.equal(result.tools[0].function.parameters.propertyOrdering,undefined)
})

test('Native invalid percent-encoded model path returns 400 without crashing server',async t=>{
  const g=await gateway(t)
  assert.equal((await g.call('/v1beta/models/%XX:generateContent',{})).status,400)
  assert.equal((await g.call('/v1/chat/completions',{model:'demo/model',messages:[]})).status,200)
})

test('Codex restores an existing empty config as a file, not as absent',t=>{
  const o=fixture(t),file=path.join(o.home,'.codex/config.toml')
  write(file,'');connectClient('codex',o);restoreClient('codex',o)
  assert.equal(fs.existsSync(file),true);assert.equal(read(file),'')
})

test('Desktop request observation is evidence, never a claim that the app applied config',async t=>{
  const g=await gateway(t)
  await g.call('/api/clients/claude-desktop/connect',{model:'demo/model'})
  let state=(await (await g.call('/api/clients',null,undefined,'GET')).json()).clients.find(c=>c.id==='claude-desktop')
  assert.equal(state.prepared,true);assert.equal(state.observed,false);assert.equal(state.configured,false)
  await g.call('/claude-desktop/v1/messages',{model:DESKTOP_MODEL,messages:[]})
  state=(await (await g.call('/api/clients',null,undefined,'GET')).json()).clients.find(c=>c.id==='claude-desktop')
  assert.equal(state.observed,true);assert.equal(state.configured,false);assert.ok(state.lastRequestAt)
})

test('Desktop parameter previews mask keys unless explicit copy is requested',async t=>{
  const g=await gateway(t)
  const preview=await g.call('/api/clients/claude-desktop/preview',{model:'demo/model'})
  const result=await preview.json()
  assert.equal(result.mode,'in-app');assert.match(result.files[0].content,/••••••••/)
  assert.doesNotMatch(result.files[0].content,/test-local-key/)
  assert.equal(fs.existsSync(g.options.home),false)
})

test('Gemini countTokens and query-key authentication are supported',async t=>{
  const g=await gateway(t)
  const response=await g.call('/v1beta/models/demo%2Fmodel:countTokens?key=test-local-key',{contents:[{role:'user',parts:[{text:'hi'}]}]}, {})
  assert.equal(response.status,200);assert.ok((await response.json()).totalTokens>0)
  assert.equal(response.headers.get('x-relay-token-count'),'estimated')
})

test('Pending partial multi-file journal can be restored after an interrupted write',t=>{
  const o=fixture(t), preview=clientPreview('gemini',o)
  connectClient('gemini',o)
  const file=path.join(o.dataDir,'client-backups/gemini.json'), journal=JSON.parse(read(file))
  journal.state='pending';write(file,JSON.stringify(journal));fs.unlinkSync(preview.files[1].path)
  restoreClient('gemini',o)
  for(const item of preview.files) assert.equal(fs.existsSync(item.path),false)
})

test('Backup journals containing credentials are owner-readable only',t=>{
  const o=fixture(t);connectClient('claude',o)
  if(process.platform!=='win32') assert.equal(fs.statSync(path.join(o.dataDir,'client-backups/claude.json')).mode&0o777,0o600)
})
