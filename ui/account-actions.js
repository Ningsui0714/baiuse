/* Account-scoped probes and daily benefits. Page load is read-only. */
(() => {
  let data = {records:{}, benefits:{}, job:null, autoCheckin:{}}, timer, loading, submitting = false;
  const labels = {test:'账号测试',claim:'每日签到',balance:'额度刷新','login-reward':'登录奖励'};
  const e = escapeHtml;
  const time = at => at ? new Date(at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
  const count = value => Number(value).toLocaleString('zh-CN',{maximumFractionDigits:3});
  const status = (text,kind='') => `<span class="pill ${kind}">${e(text)}</span>`;
  function officialLinks(benefit) {
    if(!benefit || benefit.mode==='none')return '';
    const link=(url,label)=>{
      try {if(new URL(url).protocol!=='https:')return '';} catch {return '';}
      return `<a class="benefit-link" href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(label)} ↗</a>`;
    };
    const entry=link(benefit.guideUrl??benefit.url,benefit.guideUrl?'去官方开通 / 领取':benefit.mode==='automatic'?'官方福利入口':'前往官方领取');
    const website=benefit.guideUrl?link(benefit.url,'打开官网'):'';
    return entry||website?`<div class="account-benefit-links">${entry}${website}</div>`:'';
  }
  function details(account) {
    const record = data.records[account.id] ?? {}, test = record.test, claim = record.claim, balance = record.balance;
    const benefit = data.benefits[account.provider];
    const enabled = account.authenticated && account.enabled !== false;
    const busy = submitting || data.job?.running;
    const action = (task,label,args='') => `<button class="btn-ghost" data-account-task="${task}" ${args} ${busy||!enabled?'disabled':''}>${label}</button>`;
    const testText = !test ? status('尚未测试','off') : test.ok ? status('实测可用','on') : status('测试未通过','warn');
    const balanceText = balance?.value?.total != null && balance.value.unit !== '混合额度' ? `${count(balance.value.total)} ${e(balance.value.unit)}` : '额度待确认';
    const packages = (balance?.value?.packages ?? []).map(p=>`${p.name?e(p.name)+'：':''}${count(p.remaining)} ${e(p.unit??'')}`).join(' · ');
    let claimText = '尚未签到', kind = 'off';
    if(claim?.kind==='claimed') {claimText=`已领取${claim.credit!=null?' +'+count(claim.credit)+' '+(claim.unit??'积分'):''}`;kind='on';}
    else if(claim?.kind==='already-claimed') {const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());claimText=claim.coversToday===false?'当前奖励已领，今日覆盖待确认':claim.date===today?'今日已签到':'上次检查已领，今日待确认';kind='on';}
    else if(claim?.kind==='inactive')claimText='活动未开放 / 暂不符合条件';
    else if(claim?.kind==='failed') {claimText='领取未成功';kind='warn';}
    else if(benefit?.mode==='manual')claimText='需在官方领取';
    else if(benefit?.mode==='automatic')claimText='额度自动发放';
    else if(benefit?.mode==='none')claimText='无每日签到';
    const receipt=record.claimReceipt;
    const reward = record.reward;
    const rewardText = reward?.kind==='claimed'?`登录奖励已领取 +${count(reward.credit)} 积分`:reward?.kind==='already-claimed'?'登录奖励已领过':reward?.message??'';
    return `<div class="account-details">
      <div class="account-observation"><span class="account-detail-label">连通测试</span><div>${testText}${test?.elapsedMs?` <small>${(test.elapsedMs/1000).toFixed(1)}s</small>`:''}</div>${test?.modelId?`<small>${e(test.modelId)}</small>`:''}${test?.message?`<small class="account-error">${e(test.message)}</small>`:''}${test?.at?`<small>${time(test.at)}</small>`:''}</div>
      <div class="account-observation"><span class="account-detail-label">剩余额度</span><strong>${balanceText}</strong>${packages?`<small>${packages}</small>`:''}${balance?.message?`<small class="account-error">${e(balance.message)}</small>`:''}${balance?.at?`<small>${time(balance.at)}</small>`:''}</div>
      <div class="account-observation"><span class="account-detail-label">每日福利</span><div>${status(claimText,kind)}</div><small>${e(claim?.message || benefit?.label || '活动以渠道实际返回为准')}</small>${claim?.at?`<small>${time(claim.at)}</small>`:''}${receipt&&claim?.kind!=='claimed'?`<small>上次到账：${receipt.credit!=null?'+'+count(receipt.credit)+' '+e(receipt.unit??'积分'):'已确认领取，金额未返回'} · ${time(receipt.at)}</small>`:''}${rewardText?`<small>${e(rewardText)}</small>`:''}${benefit?.guideHint?`<small class="account-benefit-hint">${e(benefit.guideHint)}</small>`:''}${officialLinks(benefit)}</div>
      <div class="account-detail-actions">${action('test','测试此账号',`data-account-id="${e(account.id)}"`)}${benefit?.mode==='daily'?action('claim','签到此渠道',`data-account-provider="${e(account.provider)}"`):''}${account.provider==='raccoon'?action('login-reward','领取登录奖励',`data-account-id="${e(account.id)}"`):''}</div>
    </div>`;
  }
  function render() {
    const busy = submitting || data.job?.running;
    document.querySelectorAll('[data-account-task]').forEach(b=>{b.disabled=!!busy;});
    const toggle = $('autoCheckinToggle');
    toggle.checked = data.autoCheckin?.enabled === true;
    toggle.disabled = !!busy || !!data.autoCheckin?.error;
    $('autoCheckinSummary').textContent = data.autoCheckin?.error || (data.autoCheckin?.lastAt?`上次自动签到：${time(data.autoCheckin.lastAt)} · ${data.autoCheckin.lastResult??'已执行'}`:'应用运行期间执行；按各渠道活动实际资格领取。');
    const tested=state.accounts.filter(a=>data.records[a.id]?.test);
    const passed=tested.filter(a=>data.records[a.id].test.ok).length;
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
    const receipts=state.accounts.map(a=>data.records[a.id]?.claimReceipt??data.records[a.id]?.claim).filter(c=>c?.kind==='claimed'&&c.date===today);
    $('benefitReceipts').textContent=`${passed} / ${tested.length} 个已测账号通过 · 今日领取 ${receipts.length} 笔 · 各厂商额度分别计算`;
    const job=data.job;
    $('accountJob').textContent = !job ? '检测只发短请求，锁定原账号；不会用其他渠道的回复冒充成功。' : job.running ? `${labels[job.kind]}进行中 · ${job.done} / ${job.total} · ${window.ChannelDisplay.label(job.current)}（可切换页面，任务继续运行）` : job.error ? `任务中断：${job.error}` : `${labels[job.kind]}完成 · ${job.done} / ${job.total}${job.errors?` · ${job.errors} 项未通过，请查看各账号结果`:' · 结果已记录'} · ${time(job.finishedAt)}`;
    $('accountJob').classList.toggle('running',!!job?.running);
    renderAccounts();
    clearTimeout(timer);
    if(data.job?.running)timer=setTimeout(()=>{void refresh();},1500);
  }
  async function refresh() {
    if(loading)return loading;
    loading=(async()=>{
      try {
        const wasRunning=data.job?.running;
        data=await api('/api/account-actions');
        data.records??={};data.benefits??={};
        render();
        if(wasRunning&&!data.job?.running)void refreshQuietly();
      } catch(error) { $('accountJob').textContent=`账号任务状态读取失败：${error.message}`;clearTimeout(timer);timer=setTimeout(()=>{void refresh();},5000); }
      finally {loading=null;}
    })();
    return loading;
  }
  async function start(kind,options={}) {
    if(submitting||data.job?.running)return;
    submitting=true;render();
    try {
      const result=await api('/api/account-actions/'+kind,{method:'POST',body:JSON.stringify(options)});
      data.job=result.job;
      toast(`${labels[kind]}已开始，结果会逐个显示。`);
    } catch(error) {toast(error.message,true);}
    finally {submitting=false;await refresh();}
  }
  document.querySelector('#tab-accounts').addEventListener('click',event=>{
    const button=event.target.closest('[data-account-task]');if(!button||button.disabled)return;
    void start(button.dataset.accountTask,{...(button.dataset.accountId?{accountId:button.dataset.accountId}:{}),...(button.dataset.accountProvider?{provider:button.dataset.accountProvider}:{})});
  });
  $('autoCheckinToggle').addEventListener('change',async event=>{
    const enabled=event.target.checked;event.target.disabled=true;
    try {await api('/api/account-actions/auto',{method:'POST',body:JSON.stringify({enabled})});toast(enabled?'每日自动签到已开启':'每日自动签到已关闭');}
    catch(error){toast(error.message,true);}
    finally {await refresh();}
  });
  window.accountActions={refresh,details,start};
  if(state.loaded)void refresh();
})();
