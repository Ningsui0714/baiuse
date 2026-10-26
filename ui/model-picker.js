/* Shared app-owned dropdowns. No native select/menu and no model provider grouping. */
(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const check = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>';
  function itemsFor(rows) {
    return rows.map(row => ({ value:row.id, label:row.name || row.id, count:row.providerCount ?? row.routeCount ?? row.routes?.length ?? 1 }));
  }
  function filter(items, query) {
    const words=String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(item => words.every(word => `${item.label} ${item.value} ${item.description ?? ''}`.toLowerCase().includes(word)));
  }
  let activeClose;
  function create({ onChange, prefix='clientModel', model=true, noun='选项', placeholder='请选择', searchPlaceholder, emptyLabel='没有找到匹配的选项' }) {
    const get = suffix => document.getElementById(prefix+suffix);
    const root=get('Picker'), trigger=get('Trigger'), panel=get('Popup'), search=get('Search'), list=get('List'), clear=get('Clear');
    const accessibleLabel=trigger.getAttribute('aria-label');
    let items=[], value='', visible=[], active=-1, opened=false, disabled=false;
    function position() {
      if (!opened) return;
      const rect=trigger.getBoundingClientRect(), margin=12, gap=8;
      const width=Math.min(Math.max(rect.width,model?280:230),window.innerWidth-margin*2);
      const below=window.innerHeight-rect.bottom-margin-gap, above=rect.top-margin-gap;
      const up=below<290 && above>below;
      panel.style.width=`${width}px`;
      panel.style.left=`${Math.max(margin,Math.min(rect.left,window.innerWidth-width-margin))}px`;
      panel.style.maxHeight=`${Math.max(120,Math.min(390,up?above:below))}px`;
      panel.style.top=up?'auto':`${rect.bottom+gap}px`;
      panel.style.bottom=up?`${window.innerHeight-rect.top+gap}px`:'auto';
      panel.dataset.placement=up?'top':'bottom';
    }
    function paintActive(scroll=false) {
      list.querySelectorAll('[role="option"]').forEach((node,index) => node.classList.toggle('active',index===active));
      if (active>=0 && visible[active]) {
        const optionId=`${prefix}Option${active}`;
        search.setAttribute('aria-activedescendant',optionId);
        if(scroll) document.getElementById(optionId)?.scrollIntoView({block:'nearest'});
      } else search.removeAttribute('aria-activedescendant');
    }
    function renderList() {
      const old=visible[active]?.value;
      visible=filter(items,search.value);
      active=visible.findIndex(item=>item.value===old);
      if(active<0)active=Math.max(0,visible.findIndex(item=>item.value===value));
      if(!visible.length)active=-1;
      list.innerHTML=visible.length ? visible.map((item,index)=>`<div role="option" id="${prefix}Option${index}" aria-selected="${item.value===value}" data-model-value="${escape(item.value)}" class="model-picker-option${item.value===value?' selected':''}"><span class="model-option-copy"><strong>${escape(item.label)}</strong>${model || item.description?`<small>${escape(model?item.value:item.description)}</small>`:''}</span>${model?`<span class="model-option-routes">${item.count} 渠道</span>`:''}<span class="model-option-check">${item.value===value?check:''}</span></div>`).join('') : `<div class="model-picker-empty"><strong>${escape(model?'没有找到匹配的模型':emptyLabel)}</strong><span>${model?'试试模型名称或版本号':'试试其他关键词'}</span></div>`;
      get('Count').textContent=search.value.trim()?`${visible.length} / ${items.length} 个${model?'模型':noun}`:`${items.length} 个${model?'统一模型':noun}`;
      clear.hidden=!search.value;
      paintActive();
      position();
    }
    function paintValue() {
      const selected=items.find(item=>item.value===value);
      get('Current').textContent=selected?.label || (model?'暂无可用模型':placeholder);
      if(get('RouteCount'))get('RouteCount').textContent=model&&selected?`${selected.count} 渠道 · 自动`:'';
      trigger.title=selected?.value || '';
      if(!model)trigger.setAttribute('aria-label',`${accessibleLabel}，${selected?.label || placeholder}`);
      trigger.disabled=disabled || !items.length;
    }
    function close(focus=false) {
      if(!opened)return;
      opened=false;
      if(activeClose===close)activeClose=undefined;
      if(typeof panel.hidePopover==='function' && panel.matches(':popover-open'))panel.hidePopover();
      panel.hidden=true;
      trigger.setAttribute('aria-expanded','false');
      root.classList.remove('open');
      search.removeAttribute('aria-activedescendant');
      if(focus)trigger.focus();
    }
    function open(last=false) {
      if(disabled || !items.length)return;
      if(activeClose && activeClose!==close)activeClose();
      activeClose=close;
      opened=true; search.value=''; active=-1;
      trigger.setAttribute('aria-expanded','true'); root.classList.add('open');
      panel.hidden=false;
      if(typeof panel.showPopover==='function')panel.showPopover();
      renderList();
      if(last)active=visible.length-1;
      search.focus({preventScroll:true}); paintActive(true);
    }
    function choose(next) {
      if(!items.some(item=>item.value===next))return;
      value=next; paintValue(); close(true); onChange?.(next);
    }
    trigger.addEventListener('click',()=>opened?close(true):open());
    trigger.addEventListener('keydown',event=>{
      if(['ArrowDown','ArrowUp'].includes(event.key)) {event.preventDefault();open(event.key==='ArrowUp');}
    });
    search.addEventListener('input',renderList);
    search.addEventListener('keydown',event=>{
      if(event.key==='Enter'){event.preventDefault();if(visible[active])choose(visible[active].value);return;}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();
        if(!visible.length)return;
        active=event.key==='Home'?0:event.key==='End'?visible.length-1:(active+(event.key==='ArrowDown'?1:-1)+visible.length)%visible.length;
        paintActive(true);
      }
    });
    panel.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
      if(event.key==='Tab')close();
    });
    clear.addEventListener('click',()=>{search.value='';renderList();search.focus();});
    list.addEventListener('pointerdown',event=>{if(event.target.closest('[data-model-value]'))event.preventDefault();});
    list.addEventListener('pointermove',event=>{
      const option=event.target.closest('[data-model-value]');
      if(option){active=visible.findIndex(item=>item.value===option.dataset.modelValue);paintActive();}
    });
    list.addEventListener('click',event=>{
      const option=event.target.closest('[data-model-value]');
      if(option)choose(option.dataset.modelValue);
    });
    document.addEventListener('pointerdown',event=>{if(opened&&!root.contains(event.target)&&!panel.contains(event.target))close();});
    document.addEventListener('focusin',event=>{if(opened&&!root.contains(event.target)&&!panel.contains(event.target))close();});
    document.addEventListener('scroll',position,true);
    window.addEventListener('resize',position);
    window.addEventListener('blur',()=>close());
    const dialog=root.closest('dialog');
    dialog?.addEventListener('beforetoggle',event=>{if(event.newState==='closed')close();});
    dialog?.addEventListener('close',()=>close());
    if(searchPlaceholder)search.placeholder=searchPlaceholder;
    return { close, update(next) {
      items=next.items;value=next.value;disabled=next.disabled===true;
      paintValue();
      if(disabled || !items.length)close();
      else if(opened)renderList();
    }};
  }

  // Hidden inputs retain form values/change events; all visible UI uses the same picker.
  const controls=new Map();
  function mount(root) {
    const input=root.querySelector('input[type="hidden"]'), prefix=input.id;
    if(controls.has(prefix))return controls.get(prefix);
    const label=root.dataset.label || '选择选项';
    root.id=prefix+'Picker';
    root.classList.add('model-picker','app-select');
    root.insertAdjacentHTML('beforeend',`
      <button type="button" class="model-picker-trigger" id="${prefix}Trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="${prefix}Popup" aria-label="${escape(label)}">
        <span id="${prefix}Current"></span><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg>
      </button>
      <div id="${prefix}Popup" class="model-picker-popover app-select-popover" role="dialog" aria-label="${escape(label)}" popover="manual" hidden>
        <div class="model-picker-search">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
          <input type="search" id="${prefix}Search" role="combobox" aria-label="搜索${escape(label)}" aria-autocomplete="list" aria-expanded="true" aria-controls="${prefix}List" placeholder="搜索选项…" autocomplete="off" spellcheck="false">
          <button type="button" id="${prefix}Clear" class="model-picker-clear" aria-label="清空搜索" hidden>×</button><kbd>Esc</kbd>
        </div>
        <div class="model-picker-list" id="${prefix}List" role="listbox" aria-label="${escape(label)}列表"></div>
        <div class="model-picker-footer"><span id="${prefix}Count"></span><span>选择 <kbd>↵</kbd></span></div>
      </div>`);
    const picker=create({prefix,model:false,noun:root.dataset.noun,placeholder:root.dataset.placeholder,searchPlaceholder:root.dataset.searchPlaceholder,onChange(next){
      if(input.value===next)return;
      input.value=next;
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }});
    let items=JSON.parse(root.dataset.options || '[]');
    function sync() { picker.update({items,value:input.value,disabled:input.disabled}); }
    const control={close:picker.close,sync,setOptions(next){
      items=next;
      if(!items.some(item=>item.value===input.value))input.value=items[0]?.value ?? '';
      sync();
    }};
    controls.set(prefix,control);
    input.addEventListener('change',sync);
    input.form?.addEventListener('reset',()=>queueMicrotask(sync));
    control.setOptions(items);
    return control;
  }
  window.ModelPicker={create,itemsFor,filter};
  window.AppSelect={
    mountAll:()=>document.querySelectorAll('[data-app-select]').forEach(mount),
    sync:id=>controls.get(id)?.sync(),
    setOptions:(id,items)=>controls.get(id)?.setOptions(items),
    closeAll:()=>activeClose?.(),
  };
})();
