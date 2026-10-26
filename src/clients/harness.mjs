/** Harness profile patches are YAML sequences addressed by stable Cordis entry IDs. */
import fs from 'node:fs'
import path from 'node:path'
import {parseDocument,isSeq,isMap,visit} from 'yaml'

const fail=message=>Object.assign(new Error(message),{status:400})
export function harnessPlan({home,env,gatewayUrl,model,modelInfo={}}) {
  const raw=env.DSH_HOME?.trim()||path.join(home,'.dsh')
  const root=raw==='~'?home:raw.startsWith('~/')?path.join(home,raw.slice(2)):path.resolve(raw)
  const profiles=['web','desktop',...['tui','headless'].filter(p=>fs.existsSync(path.join(root,'profiles',p,'cordis.yml')))]
  const modelConfig={id:model,name:modelInfo.name||model}
  const outputs=modelInfo.routes?.map(route=>route.max_tokens)??[]
  const maxTokens=modelInfo.max_tokens??(outputs.length&&outputs.every(value=>Number.isFinite(value)&&value===outputs[0])?outputs[0]:undefined)
  if(Number.isFinite(modelInfo.context_window)&&modelInfo.context_window>0)modelConfig.contextWindow=modelInfo.context_window
  if(Number.isFinite(maxTokens)&&maxTokens>0)modelConfig.maxTokens=maxTokens
  if(modelInfo.vision===true)modelConfig.input=['text','image']
  return {root,profiles,files:profiles.map(profile=>({
    file:path.join(root,'profiles',profile,'cordis.patch.yml'),format:'harness-yaml',changes:[
      {keys:['llm-pi-ai','config','providers','baiuse'],value:{displayName:'BaiUse',apiKeyEnv:'BAIUSE_API_KEY',api:'openai-completions',baseURL:gatewayUrl.replace(/\/$/,'')+'/v1',compat:{supportsDeveloperRole:false,maxTokensField:'max_tokens'},models:[modelConfig]}},
      {keys:['agent-default-model','config','provider'],value:'baiuse'},
      {keys:['agent-default-model','config','model'],value:model},
      {keys:['agent-default-model','config','reasoningEffort'],value:undefined},
    ],
  }))}
}
function document(text,file) {
  const doc=parseDocument(text?.trim()?text:'[]\n',{uniqueKeys:true})
  if(doc.errors.length)throw fail(`Harness YAML 解析失败：${file}（${doc.errors[0].code}）；原文件未修改`)
  if(!isSeq(doc.contents)||doc.contents.items.some(row=>!isMap(row)||typeof row.get('id')!=='string'))throw fail(`Harness 配置应为带 id 的 YAML 条目列表：${file}`)
  return doc
}
function index(doc,id,file) {
  const indices=doc.contents.items.flatMap((row,i)=>row.get('id')===id?[i]:[])
  if(indices.length>1)throw fail(`Harness 配置有重复条目 ${id}：${file}；请合并后再接入`)
  return indices[0]??-1
}
export function harnessValues(text,file) {
  const doc=document(text,file)
  let values
  try {values=doc.toJS()} catch {throw fail(`Harness YAML 引用解析失败：${file}；原文件未修改`)}
  return keys=>{
    const i=index(doc,keys[0],file)
    return i<0?undefined:keys.slice(1).reduce((value,key)=>value?.[key],values[i])
  }
}
export function patchHarness(text,changes,file,original) {
  const doc=document(text,file)
  for(const {keys:[id,...keys],value} of changes) {
    let i=index(doc,id,file)
    if(i<0) {if(value===undefined)continue;doc.add(doc.createNode({id}));i=doc.contents.items.length-1}
    for(let n=1;n<keys.length;n++) {
      const parent=doc.getIn([i,...keys.slice(0,n)],true)
      if(parent!==undefined&&!isMap(parent))throw fail(`Harness 的 ${id}.${keys.slice(0,n).join('.')} 应为对象：${file}`)
    }
    if(value===undefined)doc.deleteIn([i,...keys]);else doc.setIn([i,...keys],value)
  }
  if(original!==undefined) {
    const old=harnessValues(original,file)
    // Remove only empty containers that did not exist before our integration.
    for(const {keys} of changes)for(let n=keys.length-1;n>=1;n--) {
      const prefix=keys.slice(0,n),i=index(doc,prefix[0],file)
      if(i<0||old(prefix)!==undefined)continue
      if(n===1) {
        const row=doc.contents.items[i]
        if(row.items.length===1&&row.has('id'))doc.delete(i)
      } else {
        const key=[i,...prefix.slice(1)],node=doc.getIn(key,true)
        if(isMap(node)&&node.items.length===0)doc.deleteIn(key)
      }
    }
  }
  return String(doc)
}

/** Mask unrelated inline secrets when showing an existing profile in the UI. */
export function maskHarnessPreview(text) {
  const doc=parseDocument(text)
  if(doc.errors.length)return '配置解析失败，预览已隐藏'
  visit(doc,{Pair(_,pair){
    const key=String(pair.key?.value??'')
    if(/token$|secret|password|api[_-]?key/i.test(key)&&!/apiKeyEnv$/i.test(key))pair.value=doc.createNode('••••••••')
  }})
  return String(doc)
}
