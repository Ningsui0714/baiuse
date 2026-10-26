/* Native client integration hub. Uses the existing authenticated management API. */
(() => {
  const clients = [
    { id:'codex', name:'Codex', kind:'Responses' },
    { id:'claude', name:'Claude Code', kind:'CLI' },
    { id:'claude-desktop', name:'Claude Desktop', kind:'Gateway' },
    { id:'gemini', name:'Gemini CLI', kind:'Gemini' },
    { id:'opencode', name:'OpenCode', kind:'Chat Completions' },
  ];
  const copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></svg>';
  const icon = client => {
    const symbols = {
      codex:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 6l6 6-6 6m9 0h5"/></svg>',
      claude:'<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M16 2v28M2 16h28M6 6l20 20M6 26L26 6M11 3l10 26M3 11l26 10M3 21l26-10M11 29L21 3"/></svg>',
      'claude-desktop':'A',
      gemini:'<svg viewBox="0 0 32 32" fill="currentColor"><path d="M16 0c2.2 10.7 5.3 13.8 16 16-10.7 2.2-13.8 5.3-16 16C13.8 21.3 10.7 18.2 0 16 10.7 13.8 13.8 10.7 16 0z"/></svg>',
      opencode:'<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M16 2l12 7v14l-12 7-12-7V9z"/><path d="M10 6l6-3 6 3" stroke="#a7b6cc"/></svg>',
    };
    return `<span class="client-icon ${client.id}" aria-hidden="true">${symbols[client.id]}</span>`;
  };
  let selected = 'claude', records = [], selectedFile = 0, preview = null, requestId = 0, loading = false, busy = false;
  const models = new Map();
  const $hub = id => document.getElementById(id);
  $hub('copyEndpointBtn').innerHTML = copyIcon;
  $hub('copyDesktopKeyBtn').innerHTML = copyIcon;
  $hub('copyDesktopModelBtn').innerHTML = copyIcon;

  const channelName = id => window.ChannelDisplay.label(id);
  const modelPicker=window.ModelPicker.create({onChange(value){
    $hub('clientModel').value=value;models.set(selected,value);void loadPreview();
  }});
  const selectionFor=value=>state.models.find(row=>row.id===value||row.routes?.some(route=>route.id===value))?.id;
  function renderSources() {
    const routes=state.models.flatMap(row=>row.routes??[{provider:row.channel??row.owned_by}]);
    const missing = [...new Set(state.accounts.filter(a => !a.authenticated).map(a => a.provider))];
    const saved = [...new Set(state.accounts.filter(a => a.authenticated).map(a => a.provider))];
    const waiting = saved.filter(provider => !routes.some(route=>route.provider===provider));
    $hub('clientModelSources').innerHTML = `<span>${state.models.length} 个统一模型 · ${routes.length} 条可用渠道路由</span><span>同模型额度耗尽自动换渠道，无需修改配置或重启客户端。</span>${missing.map(provider => `<span class="source-warning">${escapeHtml(channelName(provider))}：账号尚未完成授权。<button type="button" class="source-link" data-source-login="${escapeHtml(provider)}">去完成授权 ↗</button></span>`).join('')}${waiting.map(provider => `<span class="source-warning">${escapeHtml(channelName(provider))}：凭据已保存，目录尚无可选模型；请刷新目录，并检查渠道模型开关或凭据状态。</span>`).join('')}`;
  }

  function render() {
    const client = clients.find(c => c.id === selected);
    const record = records.find(c => c.id === selected);
    const desktop = selected === 'claude-desktop';
    $hub('setupBannerTitle').textContent = desktop ? '桌面接入，在应用内完成。' : '让配置，简单一点。';
    $hub('setupBannerDesc').textContent = desktop ? '这里准备连接参数；在 Claude Desktop 中测试并应用。' : '选择客户端，自动备份，随时还原。';
    $hub('clientTabs').innerHTML = clients.map(c => `<button type="button" role="tab" id="client-tab-${c.id}" aria-controls="clientPanel" aria-selected="${selected === c.id}" tabindex="${selected === c.id ? '0' : '-1'}" class="client-tab${selected === c.id ? ' selected' : ''}" data-client="${c.id}">${icon(c)}<span>${c.name}</span></button>`).join('');
    $hub('clientPanel').setAttribute('aria-labelledby', `client-tab-${selected}`);
    $hub('clientHeading').innerHTML = `${icon(client)}<h2>${client.name}<small>/ ${client.kind}</small></h2>`;
    const badge = $hub('clientStatus');
    badge.className = `connection-status${record?.configured || record?.observed ? ' connected' : record?.managed || record?.error ? ' modified' : ''}`;
    badge.textContent = desktop ? record?.observed ? '检测到网关请求' : record?.prepared ? '参数已准备 · 待应用内配置' : '需应用内配置' : record?.error ? '配置需检查' : record?.configured ? '已接入' : record?.managed ? '配置有变更' : '待接入';
    const modelSelect = $hub('clientModel');
    const previous = selectionFor(models.get(selected)) ?? selectionFor(record?.logicalModel) ?? selectionFor(record?.model) ?? state.models[0]?.id ?? '';
    modelSelect.value = previous;
    models.set(selected, modelSelect.value);
    modelSelect.disabled = !state.models.length || busy;
    modelPicker.update({items:window.ModelPicker.itemsFor(state.models),value:modelSelect.value,disabled:modelSelect.disabled});
    renderSources();
    const root = state.summary?.url ?? location.origin;
    $hub('clientEndpoint').value = selected === 'codex' || selected === 'opencode' ? `${root}/v1` : selected === 'claude-desktop' ? `${root}/claude-desktop` : root;
    $hub('clientPathsLabel').textContent = desktop ? '配置入口' : '配置文件路径';
    $hub('clientPaths').innerHTML = desktop ? 'Claude Desktop → Developer → Configure Third-Party Inference → Gateway' : record?.paths?.length ? record.paths.map(p => `<div>${escapeHtml(p)}</div>`).join('') : '配置路径在连接后显示';
    $hub('desktopGuide').hidden = !desktop;
    $hub('desktopFields').hidden = !desktop;
    $hub('clientFootNote').textContent = desktop ? '应用内配置 · Gateway / Bearer · 参数准备不代表桌面应用已接入' : '自动备份原配置 · 保留权限与 MCP 设置 · 重启客户端后生效';
    $hub('clientNote').textContent = record?.error ?? record?.note ?? '';
    $hub('clientBackup').textContent = desktop ? record?.observed ? `最近一次成功请求：${new Date(record.lastRequestAt).toLocaleString('zh-CN')}；请在桌面应用内确认实际连接。` : '先准备网关映射，再将参数填入桌面应用并测试连接。' : record?.backupPath ? `备份位置：${record.backupPath}` : '首次接入前自动备份；还原时保留之后新增的无关设置。';
    $hub('codexAdvanced').hidden = selected !== 'codex';
    $hub('connectClientBtn').disabled = busy || !modelSelect.value || !!record?.error;
    $hub('restoreClientBtn').disabled = busy || !record?.managed;
    $hub('copyClientBtn').disabled = busy || !modelSelect.value || !!record?.error;
    $hub('connectClientBtn').textContent = desktop ? '准备接入参数' : '一键接入';
    $hub('restoreClientBtn').textContent = desktop ? '清除网关映射' : '还原配置';
    $hub('copyClientBtn').textContent = desktop ? '复制全部参数' : '复制配置';
    $hub('previewLabel').textContent = desktop ? '应用内填写参数（非自动导入）' : '生成的配置';
    void loadPreview();
  }
  async function refresh() {
    if (loading || !apiKey || !state.loaded) return;
    loading = true;
    try { records = (await api('/api/clients')).clients ?? []; render(); }
    catch (error) { $hub('clientStatus').textContent = '读取失败'; toast(error.message, true); }
    finally { loading = false; }
  }
  function showFile() {
    const files = preview?.files ?? [];
    const file = files[selectedFile];
    $hub('previewFilename').textContent = file ? `(${file.path.split(/[\\/]/).at(-1)})` : '';
    $hub('previewFiles').innerHTML = files.length > 1 ? files.map((f,i) => `<button type="button" role="tab" aria-selected="${i === selectedFile}" class="preview-file${i === selectedFile ? ' active' : ''}" data-preview-file="${i}">${escapeHtml(f.path.split(/[\\/]/).at(-1))}${i > 0 && f.path.endsWith('claude_desktop_config.json') ? ' · 3p' : ''}</button>`).join('') : '';
    $hub('clientCode').textContent = file?.content ?? '选择一个模型以生成配置预览。';
  }
  async function loadPreview() {
    const token = ++requestId;
    const client = selected, model = models.get(client);
    preview = null; selectedFile = 0; showFile();
    if (!model || !apiKey || !state.loaded) return;
    $hub('clientCode').textContent = '生成配置预览…';
    try {
      const result = await api(`/api/clients/${client}/preview`, { method:'POST', body:JSON.stringify({ model }) });
      if (token !== requestId) return;
      preview = result; showFile();
    } catch (error) {
      if (token === requestId) $hub('clientCode').textContent = error.message;
    }
  }
  async function act(action) {
    if (busy) return;
    const client = selected, model = models.get(client);
    busy = true; render();
    try {
      const result = await api(`/api/clients/${client}/${action}`, { method:'POST', body:JSON.stringify({ model }) });
      records = result.clients ?? records;
      toast(client === 'claude-desktop' ? action === 'connect' ? '网关映射已准备，请在 Claude Desktop 内配置并测试连接' : '网关映射已清除；桌面应用的设置需在应用内撤销' : action === 'connect' ? '配置已写入，重启客户端后生效' : '原配置已还原');
      if (client === 'codex') await reloadCodex();
    } catch (error) { toast(error.message, true); }
    finally { busy = false; render(); }
  }
  $hub('clientTabs').addEventListener('click', event => {
    const button = event.target.closest('[data-client]');
    if (!button || busy) return;
    modelPicker.close();
    selected = button.dataset.client; render();
  });
  $hub('clientTabs').addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || busy) return;
    event.preventDefault();
    modelPicker.close();
    const index = clients.findIndex(c => c.id === selected);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 4 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 5) % 5;
    selected = clients[next].id; render(); document.getElementById(`client-tab-${selected}`).focus();
  });
  $hub('clientModelSources').addEventListener('click', event => {
    const button = event.target.closest('[data-source-login]');
    if (button) goToAccountChannel(button.dataset.sourceLogin);
  });
  $hub('previewFiles').addEventListener('click', event => {
    const button = event.target.closest('[data-preview-file]');
    if (button) { selectedFile = Number(button.dataset.previewFile); showFile(); }
  });
  $hub('refreshClientsBtn').addEventListener('click', () => { void refreshAll($hub('refreshClientsBtn')).then(refresh); });
  $hub('copyEndpointBtn').addEventListener('click', () => { void copyText($hub('clientEndpoint').value); });
  $hub('copyDesktopKeyBtn').addEventListener('click', () => { void copyText(apiKey); });
  $hub('copyDesktopModelBtn').addEventListener('click', () => { void copyText($hub('desktopModelAlias').value); });
  $hub('connectClientBtn').addEventListener('click', () => { void act('connect'); });
  $hub('restoreClientBtn').addEventListener('click', () => {
    $hub('restoreClientMessage').textContent = selected === 'claude-desktop' ? '仅清除本地网关的桌面模型映射，不改桌面应用设置。需要撤销桌面接入时，请回到应用内的 Third-Party Inference 设置。' : `将 ${clients.find(c => c.id === selected).name} 恢复到首次接入前的配置。`;
    $hub('clientRestoreDialog').returnValue = '';
    $hub('clientRestoreDialog').showModal();
  });
  $hub('clientRestoreDialog').addEventListener('close', () => {
    if ($hub('clientRestoreDialog').returnValue === 'restore') void act('restore');
  });
  $hub('copyClientBtn').addEventListener('click', async () => {
    const client = selected, file = selectedFile, model = models.get(client);
    try {
      const result = await api(`/api/clients/${client}/preview`, { method:'POST', body:JSON.stringify({ model, reveal:true }) });
      await copyText(result.files[file]?.content ?? '');
    } catch (error) { toast(error.message, true); }
  });
  window.clientHub = { render: () => { render(); if (!records.length) void refresh(); }, renderSources, refresh };
  render();
  if (state.loaded) void refresh();
})();
