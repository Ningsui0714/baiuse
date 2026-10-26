/** Optional real Harness smoke test. Only fixture credentials and an isolated home. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {spawn,spawnSync} from 'node:child_process'
import {connectClient} from '../src/clients/config.mjs'

const home=fs.mkdtempSync(path.join(os.tmpdir(),'baiuse-harness-'))
const bin=process.env.DSH_BIN||'dsh'
const env={PATH:process.env.PATH,HOME:home,USERPROFILE:home,DSH_HOME:path.join(home,'.dsh'),...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}
let server,child,timer
function command(args) {
  const result=spawnSync(bin,args,{env,cwd:home,encoding:'utf8',timeout:60000,maxBuffer:10*1024*1024})
  if(result.error?.code==='ENOENT')throw Error('未找到 dsh；请先安装 DeepSeek Harness，或通过 DSH_BIN 指定可执行文件')
  assert.equal(result.status,0,result.stderr||result.error?.message)
  return result.stdout
}
try {
  const options={home,env,dataDir:path.join(home,'baiuse'),gatewayUrl:'http://127.0.0.1:1',apiKey:'fixture-harness-key',model:'fixture-model',modelInfo:{context_window:524288,max_tokens:131072}}
  connectClient('deepseek-harness',options)
  const composed=command(['--profile','web','--dump-config'])
  assert.ok(composed.includes('baiuse'),'Fresh Web profile must retain the pre-written provider patch')
  command(['headless','--help'])
  const requests=[]
  server=http.createServer(async(req,res)=>{
    let text='';for await(const c of req)text+=c
    if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end('{}');return}
    const body=JSON.parse(text)
    requests.push({authenticated:req.headers.authorization==='Bearer fixture-harness-key',model:body.model,tools:body.tools?.length??0,maxTokens:body.max_tokens})
    res.writeHead(200,{'content-type':'text/event-stream'})
    for(const [delta,reason] of [[{role:'assistant',content:'BAIUSE_HARNESS_OK'},null],[{},'stop']])res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:reason}],usage:reason?{prompt_tokens:10,completion_tokens:5,total_tokens:15}:undefined})+'\n\n')
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  connectClient('deepseek-harness',{...options,gatewayUrl:`http://127.0.0.1:${server.address().port}`})
  child=spawn(bin,['headless','Reply with only BAIUSE_HARNESS_OK.'],{env,cwd:home,stdio:['ignore','pipe','pipe']})
  let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c)
  timer=setTimeout(()=>child.kill('SIGTERM'),60000)
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)})
  assert.equal(code,0,err)
  assert.equal(out.trim(),'BAIUSE_HARNESS_OK')
  assert.ok(requests.length>=1&&requests.every(r=>r.authenticated&&r.model==='fixture-model'))
  assert.ok(requests.some(r=>r.tools>0&&r.maxTokens===131072),'Main request preserves tool schemas and declared output budget')
  console.log(`PASS: real dsh, fresh Web profile, isolated headless reply, credentials, tools and 131072 output budget (${requests.length} requests)`)
} finally {
  clearTimeout(timer)
  if(child?.exitCode==null)child?.kill('SIGTERM')
  if(server)await new Promise(resolve=>server.close(resolve))
  fs.rmSync(home,{recursive:true,force:true})
}
