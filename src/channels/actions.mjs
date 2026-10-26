import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const BENEFITS = {
  codearts: {mode:'daily',label:'每日活动积分',url:'https://codearts.huaweicloud.com/'},
  qoder: {mode:'daily',unit:'credits',label:'每日活动额度',url:'https://qoder.com/'},
  qodercn: {mode:'daily',unit:'credits',label:'每日活动额度',url:'https://qoder.cn/'},
  trae: {mode:'daily',unit:'credits',label:'每日签到积分',url:'https://www.trae.cn/'},
  loomy: {mode:'daily',label:'每日额度',url:'https://loomy.xunfei.cn/'},
  minimax: {mode:'daily',label:'每日签到额度',url:'https://agent.minimax.cn/'},
  raccoon: {mode:'automatic',label:'每日自动发放；另有一次性登录奖励',url:'https://raccoon.sensetime.com/'},
  zcode: {mode:'manual',label:'每日额度需在官方完成人工验证',url:'https://zcode.z.ai/'},
  cline: {mode:'none',label:'未提供每日签到接口',url:'https://cline.bot/'},
  gemini: {mode:'none',label:'额度由账号套餐自动刷新',url:'https://codeassist.google/'},
}

const safeMessage = value => String(value ?? '').replace(/Bearer\s+[\w.\-]+/gi,'Bearer [已隐藏]').replace(/(token|secret|password|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,'$1$2[已隐藏]').slice(0,500)
const fail = (message,status=400) => Object.assign(new Error(message),{status})
const day = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date())
export function chooseProbeModel(rows,provider) {
  const options=rows.filter(row=>(row.channel ?? row.owned_by ?? row.id.split('/')[0])===provider && row.id.startsWith(provider+'/'))
  // Qoder uses opaque IDs (qfmodel); the display name carries free-tier hints.
  const score=row=> {
    const label=`${row.id} ${row.name??''}`
    return (/免费|\bfree\b/i.test(label)?60:0)+(/flash|mini|haiku/i.test(label)?20:0)+(/deepseek/i.test(label)?10:0)+(/auto/i.test(label)?5:0)-(/pro|opus|thinking/i.test(label)?8:0)
  }
  return options.sort((a,b)=>score(b)-score(a))[0]?.id
}
export function normalizeBalance(balance) {
  if (balance == null) return null
  if (typeof balance === 'number') return {total:balance,unit:'积分'}
  const packages=(balance.packages ?? []).map(row=>({name:row.name,remaining:row.remaining,unit:row.unit,expiresAt:row.deductionEndTime ?? row.expiredTime})).filter(row=>Number.isFinite(row.remaining))
  const units=[...new Set(packages.map(row=>row.unit).filter(Boolean))]
  return {total:Number.isFinite(balance.total)?balance.total:null,unit:units.length===1?units[0]:units.length>1?'混合额度':'积分',packages}
}

/** Local diagnostics/check-ins use the live worker; only sanitized observations are persisted. */
export function createAccountActions({dataDir,channels}) {
  const file=path.join(dataDir,'account-actions.json')
  let records={},job=null,closed=false,controller
  try { const data=JSON.parse(fs.readFileSync(file,'utf8'));records=data.records ?? {} } catch {}
  for(const record of Object.values(records))if(record.claim?.kind==='claimed'&&!record.claimReceipt) {
    record.claim.unit=record.balance?.value?.unit??record.claim.unit
    record.claimReceipt={...record.claim}
  }
  const save=()=>{
    if(closed)return
    fs.mkdirSync(dataDir,{recursive:true})
    const temp=file+'.'+crypto.randomUUID()+'.tmp'
    try {fs.writeFileSync(temp,JSON.stringify({version:1,records},null,2),{mode:0o600,flag:'wx'});fs.renameSync(temp,file)}
    finally {if(fs.existsSync(temp))fs.unlinkSync(temp)}
  }
  const record=(id,key,value)=>{
    const receipt={...value,at:new Date().toISOString(),date:day()}
    records[id]={...(records[id]??{}),[key]:receipt}
    if(key==='claim'&&value.kind==='claimed')records[id].claimReceipt=receipt
    save()
  }
  const rpc=async(method,payload,signal)=>{
    const result=await channels.rpc({method,payload},signal)
    if(result?.ok===false)throw fail(safeMessage(result.error?.message ?? '渠道操作失败'))
    return result?.value ?? result
  }
  async function accounts() {
    const rows=[]
    for(const provider of channels.providers) {
      const value=await rpc('account.list',{provider})
      rows.push(...(value?.accounts??[]).map(a=>({id:a.id,provider:a.provider,authenticated:a.authenticated===true,enabled:a.enabled!==false})))
    }
    return rows
  }
  async function autoState() {
    try {return (await rpc('usage.autoCheckin',{}))?.autoCheckin ?? {enabled:false}}
    catch {return {enabled:false,error:'自动签到状态读取失败'}}
  }
  async function snapshot() {return {records,job:job?{...job}:null,benefits:BENEFITS,autoCheckin:await autoState()}}
  async function balance(provider,signal) {
    const result=await rpc('credits.balances',{provider},signal)
    for(const row of result?.accounts??[])record(row.accountId,'balance',{value:normalizeBalance(row.balance),message:safeMessage(row.error)})
  }
  async function refreshBalance(provider,signal,selected) {
    try { await balance(provider,signal);return true }
    catch(error) {
      // A balance refresh failure must never overwrite a confirmed claim.
      for(const a of selected)if(a.provider===provider)record(a.id,'balance',{value:null,message:safeMessage(error.message)})
      return false
    }
  }
  async function run(kind,selected,signal,modelId) {
    const list=kind==='test'||kind==='login-reward'?selected:[...new Set(selected.map(a=>a.provider))]
    job.total=list.length
    for(const item of list) {
      if(signal.aborted || closed)break
      const provider=typeof item==='string'?item:item.provider
      job.current=provider
      try {
        if(kind==='test') {
          const model=modelId ?? chooseProbeModel(channels.publicModelRows(),provider)
          if(!model)throw fail('当前渠道没有可测试模型，请先刷新模型目录')
          if(!model.startsWith(provider+'/'))throw fail('测试模型必须属于当前渠道')
          const value=await channels.probeAccount({accountId:item.id,modelId:model},signal)
          if(!value.ok)job.errors++
          record(item.id,'test',{ok:value.ok,modelId:value.modelId,text:value.text,elapsedMs:value.elapsedMs,message:safeMessage(value.message),code:value.code,statusCode:value.statusCode})
        } else if(kind==='balance') {
          if(!await refreshBalance(provider,signal,selected))job.errors++
        } else if(kind==='login-reward') {
          if(provider!=='raccoon')throw fail('该入口仅领取小浣熊登录奖励')
          const value=await rpc('onboarding.claim',{provider,accountId:item.id},signal)
          if(!Array.isArray(value?.claimed)||!Array.isArray(value?.skipped)||(!value.claimed.length&&!value.skipped.length))throw fail('未取得登录奖励回执，尚未确认领取')
          record(item.id,'reward',{kind:value.claimed?.length?'claimed':'already-claimed',credit:(value.claimed??[]).reduce((sum,r)=>sum+(Number(r.points)||0),0)})
          await refreshBalance(provider,signal,selected)
        } else {
          const benefit=BENEFITS[provider]
          if(benefit?.mode!=='daily') {
            for(const a of selected.filter(a=>a.provider===provider))record(a.id,'claim',{kind:benefit?.mode ?? 'unsupported',message:benefit?.label ?? '尚未接入签到活动'})
          } else {
            const value=await rpc('credits.claimAll',{provider,accountIds:selected.filter(a=>a.provider===provider).map(a=>a.id)},signal)
            for(const row of value?.results??[]) {
              const out=['claimed','already-claimed','inactive','failed'].includes(row.outcome?.kind)?row.outcome:{kind:'failed',message:'未取得有效签到回执，尚未确认领取'}
              if(out.kind==='failed')job.errors++
              record(row.accountId,'claim',{kind:out.kind??'failed',credit:Number.isFinite(out.credit)?out.credit:null,unit:out.unit??benefit.unit??'积分',message:safeMessage(out.message),code:out.code,coversToday:out.coversToday!==false})
            }
            if(!Array.isArray(value?.results)||!value.results.length)throw fail('渠道没有返回逐账号签到结果，尚未确认领取')
            await refreshBalance(provider,signal,selected)
          }
        }
      } catch(error) {
        job.errors++
        for(const a of typeof item==='string'?selected.filter(a=>a.provider===provider):[item])record(a.id,kind==='test'?'test':kind==='balance'?'balance':kind==='login-reward'?'reward':'claim',kind==='test'?{ok:false,message:safeMessage(error.message)}:{kind:'failed',message:safeMessage(error.message)})
      }
      job.done++
    }
    job.running=false;job.current='';job.finishedAt=new Date().toISOString()
    if(kind!=='test'&&!signal.aborted)void channels.refresh().catch(()=>{})
  }
  return {
    snapshot,
    async start(kind,{accountId,provider,modelId}={}) {
      if(!['test','claim','balance','login-reward'].includes(kind))throw fail('未知账号操作')
      if(closed)throw fail('服务正在退出',503)
      if(job?.running)throw fail('当前任务正在执行，请等待完成',409)
      // Reserve before await: simultaneous clicks cannot create duplicate claim batches.
      job={id:crypto.randomUUID(),kind,running:true,done:0,total:0,errors:0,startedAt:new Date().toISOString(),current:''}
      try {
        if(kind==='claim'&&(await autoState()).running)throw fail('每日自动签到正在执行，请稍后查看结果',409)
        const all=await accounts()
        const selected=all.filter(a=>a.authenticated&&a.enabled&&(!accountId||a.id===accountId)&&(!provider||a.provider===provider))
        if(!selected.length)throw fail('没有符合条件的已授权启用账号')
        controller=new AbortController()
        void run(kind,selected,controller.signal,modelId).catch(error=>{job.running=false;job.error=safeMessage(error.message)})
        return {job:{...job}}
      } catch(error) {job.running=false;job.error=safeMessage(error.message);job.finishedAt=new Date().toISOString();throw error}
    },
    async setAuto(enabled) {
      if(typeof enabled!=='boolean')throw fail('enabled 必须是布尔值')
      if(job?.running)throw fail('账号任务正在执行，请等待完成',409)
      return rpc('usage.autoCheckin',{enabled})
    },
    close(){closed=true;controller?.abort()},
  }
}
