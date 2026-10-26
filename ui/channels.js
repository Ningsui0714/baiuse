/* Display names only. Account IDs, authentication and model routing keep their raw IDs. */
(() => {
  const channels = {
    codearts: { name:'CodeArts', chineseName:'码道', company:'华为云' },
    lobsterai: { name:'LobsterAI', chineseName:'有道龙虾', company:'网易有道' },
    qoder: { name:'Qoder', company:'阿里云' },
    qodercn: { name:'Qoder CN', chineseName:'中国版', company:'阿里云' },
    trae: { name:'TRAE', company:'字节跳动' },
    cline: { name:'Cline', company:'Cline Bot' },
    loomy: { name:'Loomy', company:'科大讯飞' },
    raccoon: { name:'Raccoon', chineseName:'小浣熊', company:'商汤科技' },
    minimax: { name:'MiniMax Code', company:'MiniMax' },
    gemini: { name:'Gemini Code Assist', company:'谷歌 Google' },
    zcode: { name:'ZCode', company:'智谱 AI' },
  };
  function info(id) {
    const value=String(id ?? '');
    return { id:value, ...(Object.hasOwn(channels,value)?channels[value]:{name:value}) };
  }
  function label(id) {
    const channel=info(id);
    return [channel.name,channel.chineseName].filter(Boolean).join(' ')+(channel.company?` · ${channel.company}`:'');
  }
  function option(id) {
    return {value:String(id),label:label(id),description:`渠道标识：${id}`};
  }
  window.ChannelDisplay={info,label,option};
})();
