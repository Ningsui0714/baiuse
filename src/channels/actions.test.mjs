import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {BENEFITS,createAccountActions,chooseProbeModel,normalizeBalance} from './actions.mjs'
import {probeAccount} from './probe.mjs'

function fixture(t,providers=['codearts','zcode','raccoon']) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'baiuse-actions-'))
  const calls=[]
  const channels={providers,publicModelRows:()=>providers.map(p=>({id:p+'/flash',channel:p})),refresh:async()=>{},
    probeAccount:async o=>({ok:true,modelId:o.modelId,text:'BAIUSE_OK'}),
    rpc:async({method,payload})=>{
      calls.push({method,payload})
      if(method==='account.list')return {ok:true,value:{accounts:[{id:payload.provider,provider:payload.provider,authenticated:true,enabled:true}]}}
      if(method==='usage.autoCheckin')return {ok:true,value:{autoCheckin:{enabled:true}}}
      if(method==='credits.claimAll')return {ok:true,value:{results:[{accountId:payload.provider,outcome:{kind:'claimed',credit:10}}]}}
      if(method==='credits.balances')return {ok:true,value:{accounts:[{accountId:payload.provider,balance:{total:20}}]}}
      throw Error('unexpected '+method)
    }}
  const service=createAccountActions({dataDir,channels})
  t.after(()=>{service.close();fs.rmSync(dataDir,{recursive:true,force:true})})
  return {service,channels,calls,dataDir}
}
async function done(service) {
  for(let i=0;i<200;i++) {const s=await service.snapshot();if(!s.job?.running)return s;await new Promise(r=>setTimeout(r,5))}
  throw Error('job timeout')
}
test('探测按渠道选轻量模型；混合额度保留单位',()=>{
  assert.equal(chooseProbeModel([{id:'a/opus'},{id:'b/flash'},{id:'a/deepseek-flash'}],'a'),'a/deepseek-flash')
  assert.equal(normalizeBalance(null),null)
  assert.equal(normalizeBalance({total:3,packages:[{remaining:1,unit:'USD'},{remaining:2,unit:'tokens'}]}).unit,'混合额度')
})
test('锁定账号/注册适配器，经过代理的 constructor 仍固定凭据且禁用内部账号池',async()=>{
  const credential={token:'fixture-secret-token'}
  class Adapter {
    constructor(options){this.options=options}
    async *stream(o){assert.equal(this.options.accountPool,undefined);assert.equal(await this.options.nextAccount(),undefined);assert.equal(this.options.currentAccountId(),'exact');assert.equal(await this.options.resolveCredential(),credential);assert.equal(await this.options.refresh(),credential);assert.equal(o.model,'flash');yield {type:'text-delta',text:'BAIUSE_OK'}}
  }
  const original=new Proxy(new Adapter({accountPool:{},resolveCredential:()=>{throw Error('fallback called')}}),{get(o,p){const v=Reflect.get(o,p);return typeof v==='function'?v.bind(o):v}})
  const result=await probeAccount({pool:{findAccount:()=>({provider:'raccoon'}),resolveCredentialForAccount:async()=>credential},adapters:new Map([['raccoon',original]]),accountId:'exact',modelId:'raccoon/flash'})
  assert.equal(result.ok,true);assert.equal(result.text,'BAIUSE_OK');assert.equal(result.accountId,'exact')
})
test('空响应不算成功，错误中隐藏凭据，取消信号传入适配器',async()=>{
  class Adapter {constructor(o){this.options=o}async *stream(o){assert.ok(o.signal.aborted);throw Error('fixture-secret-token')}}
  const c=new AbortController();c.abort()
  const result=await probeAccount({pool:{findAccount:()=>({provider:'minimax'}),resolveCredentialForAccount:async()=>({token:'fixture-secret-token'})},adapters:new Map([['minimax',new Adapter({})]]),accountId:'x',modelId:'minimax/mini',signal:c.signal})
  assert.equal(result.ok,false);assert.equal(result.code,'TIMEOUT');assert.ok(!result.message.includes('fixture-secret-token'))
  class Empty extends Adapter{async *stream(){yield {type:'finish'}}}
  const empty=await probeAccount({pool:{findAccount:()=>({provider:'minimax'}),resolveCredentialForAccount:async()=>({token:'fixture'})},adapters:new Map([['minimax',new Empty({})]]),accountId:'x',modelId:'mini'})
  assert.equal(empty.ok,false);assert.match(empty.message,/没有返回正文/)
})
test('批量签到只调用已支持渠道；人工验证/自动发放不触发领取',async t=>{
  const {service,calls,dataDir}=fixture(t)
  await service.start('claim');const s=await done(service)
  assert.equal(calls.filter(c=>c.method==='credits.claimAll').length,1)
  assert.deepEqual(calls.find(c=>c.method==='credits.claimAll').payload.accountIds,['codearts']);assert.equal(s.records.codearts.claimReceipt.credit,10);assert.equal(s.records.codearts.claim.kind,'claimed');assert.equal(s.records.zcode.claim.kind,'manual');assert.equal(s.records.raccoon.claim.kind,'automatic')
  assert.equal(fs.statSync(path.join(dataDir,'account-actions.json')).mode&0o777,0o600)
  assert.equal(createAccountActions({dataDir,channels:{}}).close(),undefined)
  assert.ok(!calls.some(c=>c.method==='usage.autoCheckin'&&'enabled'in c.payload))
})
test('领取后余额刷新失败保留已确认到账结果',async t=>{
  const {service,channels}=fixture(t,['codearts']);const rpc=channels.rpc
  channels.rpc=o=>o.method==='credits.balances'?Promise.reject(Error('余额暂不可用')):rpc(o)
  await service.start('claim');const s=await done(service)
  assert.equal(s.records.codearts.claim.kind,'claimed');assert.equal(s.records.codearts.claim.credit,10);assert.match(s.records.codearts.balance.message,/余额/)
})
test('并发点击不重复签到；逐账号失败统计且不影响后续测试',async t=>{
  const {service,channels}=fixture(t,['codearts','trae'])
  channels.probeAccount=async({accountId,modelId})=>({ok:accountId!=='codearts',modelId,message:'fixture'})
  const first=service.start('test');await assert.rejects(service.start('test'),e=>e.status===409);await first
  const s=await done(service);assert.equal(s.job.done,2);assert.equal(s.job.errors,1);assert.equal(s.records.trae.test.ok,true)
})
test('未授权或停用账号不测试，不接受无效操作和自动签到参数',async t=>{
  const {service,channels}=fixture(t,['codearts']);const rpc=channels.rpc
  channels.rpc=o=>o.method==='account.list'?Promise.resolve({ok:true,value:{accounts:[{id:'disabled',provider:'codearts',enabled:false,authenticated:true},{id:'missing',provider:'codearts',authenticated:false}]}}):rpc(o)
  await assert.rejects(service.start('test'),/没有符合/)
  await assert.rejects(service.start('unknown'),/未知/)
  await assert.rejects(service.setAuto('true'),/布尔/)
})

test('Qoder WASM 随应用打包，路径相对于 vendor 模块而非原始仓库',async()=>{
  const file=new URL('../../vendor/channels/qoder-auth-wasm.wasm',import.meta.url)
  const bytes=fs.readFileSync(file)
  assert.equal(WebAssembly.validate(bytes),true)
  const source=fs.readFileSync(new URL('../../vendor/channels/business.mjs',import.meta.url),'utf8')
  assert.ok(source.includes('new URL("./qoder-auth-wasm.wasm", import.meta.url)'))
})

test('免费档位可由显示名识别，避免把零余额账号误判为全渠道不可用',()=>{
  assert.equal(chooseProbeModel([{id:'qoder/auto',name:'Auto'},{id:'qoder/qfmodel',name:'Qwen Flash · 免费'}],'qoder'),'qoder/qfmodel')
})
test('已到账收据独立保存，重复签到不丢失领取金额',async t=>{
  const {service,channels,dataDir}=fixture(t,['qodercn'])
  await service.start('claim');let s=await done(service)
  assert.equal(s.records.qodercn.claimReceipt.unit,'credits')
  const rpc=channels.rpc
  channels.rpc=o=>o.method==='credits.claimAll'?Promise.resolve({ok:true,value:{results:[{accountId:'qodercn',outcome:{kind:'already-claimed'}}]}}):rpc(o)
  await service.start('claim');s=await done(service)
  assert.equal(s.records.qodercn.claim.kind,'already-claimed');assert.equal(s.records.qodercn.claimReceipt.credit,10)
  const reopened=createAccountActions({dataDir,channels});assert.equal((await reopened.snapshot()).records.qodercn.claimReceipt.credit,10);reopened.close()
})
test('没有逐账号回执不冒充领取成功，失效账号不会阻断其他渠道',async t=>{
  const {service,channels}=fixture(t,['codearts','trae']);const rpc=channels.rpc
  channels.rpc=o=>o.method==='credits.claimAll'&&o.payload.provider==='codearts'?Promise.resolve({ok:true,value:{summary:'unknown'}}):rpc(o)
  await service.start('claim');const s=await done(service)
  assert.equal(s.records.codearts.claim.kind,'failed');assert.equal(s.records.trae.claim.kind,'claimed');assert.equal(s.job.errors,1)
})

test('一次性登录奖励缺少回执时不冒充已领取',async t=>{
  const {service,channels}=fixture(t,['raccoon']);const rpc=channels.rpc
  channels.rpc=o=>o.method==='onboarding.claim'?Promise.resolve({ok:true,value:{}}):rpc(o)
  await service.start('login-reward');const s=await done(service)
  assert.equal(s.records.raccoon.reward.kind,'failed');assert.match(s.records.raccoon.reward.message,/未取得/)
})


test('首次领取引导按 Qoder 国际版与中国版区分，不伪造网页领取或应用 deep link',()=>{
  assert.equal(BENEFITS.qoder.guideUrl,'https://docs.qoder.com/events/100credits')
  assert.equal(BENEFITS.qodercn.guideUrl,'https://docs.qoder.cn/events/100credits')
  for(const provider of ['qoder','qodercn']) {
    assert.equal(new URL(BENEFITS[provider].guideUrl).protocol,'https:')
    assert.match(BENEFITS[provider].guideHint,/官方桌面客户端/)
    assert.match(BENEFITS[provider].guideHint,/礼物图标/)
  }
})
