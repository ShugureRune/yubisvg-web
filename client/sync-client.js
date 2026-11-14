/*
 * Browser-side live bridge. No framework or build step required.
 * It only syncs when the user explicitly connects to the local PC server.
 */
(() => {
  'use strict';
  const TOKEN_KEY='yubisvg-live-token';
  const BACKUP_KEY='yubisvg-before-remote-v1';
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function createController({getDoc,replaceDoc,setRevision,isBusy,status}) {
    const button=document.getElementById('syncBtn');
    const indicator=document.getElementById('syncIndicator');
    let token='',online=false,dirty=false,conflicted=false,uploading=false;
    let serverRevision=null,remoteHint=null,lastError='';
    let monitor=null,abort=null,epoch=0,retryTimer=null,changeTimer=null;
    let failedRefresh=false;
    const setState=(label,message)=>{
      button.textContent=label;
      indicator.textContent=message;
      indicator.title=message;
    };
    setState('↔ PC接続','オフライン');
    function authHeaders(json=false) {
      return {Authorization:'Bearer '+token,...(json?{'Content-Type':'application/json'}:{})};
    }
    async function request(path,options={}) {
      const response=await fetch(path,{cache:'no-store',...options,
        headers:{...authHeaders(!!options.body),...(options.headers||{})}});
      let payload;
      try {payload=await response.json();}catch{payload={};}
      if(!response.ok) {
        const error=new Error(payload.error||('HTTP '+response.status));
        error.statusCode=response.status;
        throw error;
      }
      return payload;
    }
    function backup() {
      try {localStorage.setItem(BACKUP_KEY,JSON.stringify(getDoc()));}
      catch {status('バックアップ保存に失敗。先に「編集データ保存」を押してください');return false;}
      return true;
    }
    function sameDrawing(a,b) {
      const left={...a,revision:0},right={...b,revision:0};
      return JSON.stringify(left)===JSON.stringify(right);
    }
    function stop() {
      epoch+=1;online=false;dirty=false;conflicted=false;uploading=false;
      clearInterval(monitor);clearTimeout(changeTimer);clearTimeout(retryTimer);
      abort?.abort();abort=null;monitor=null;serverRevision=null;remoteHint=null;
      setState('↔ PC接続','オフライン');
    }
    async function join() {
      // A GitHub Pages static site has no local API. It cannot talk to
      // the PC server under another origin.
      try {
        const health=await fetch('/api/health',{cache:'no-store'});
        if(!health.ok)throw Error('not local');
        const body=await health.json();
        if(body.service!=='yubisvg-live')throw Error('not local');
      }catch{
        status('PCの同期サーバーから開いてね：npm run live');
        alert('このページは同期サーバーから開かれていません。\nPCで「npm run live」を起動して、表示されたPCのアドレスをiPhoneで開いてください。');
        return;
      }
      const candidate=prompt('PCのターミナルに表示された接続トークンを入力：',sessionStorage.getItem(TOKEN_KEY)||'');
      if(candidate===null)return;
      token=candidate.trim();
      if(!token)return;
      try {
        const remote=await request('/api/document');
        if(!sameDrawing(getDoc(),remote)) {
          const ok=confirm('PCに保存された作品を開きます。\nスマホ側の絵は置き換わります。\n先に「編集データ保存」でバックアップすることをおすすめします。\n\n続行しますか？');
          if(!ok)return;
          if(!backup())return;
        }
        if(!replaceDoc(remote)) {
          status('描画を終えてから接続してください');return;
        }
        sessionStorage.setItem(TOKEN_KEY,token);
        online=true;dirty=false;conflicted=false;serverRevision=remote.revision;
        remoteHint=remote.revision;failedRefresh=false;
        const myEpoch=++epoch;
        setState('✓ PC接続中','同期中・r'+serverRevision);
        status('PCの作品に接続しました。MCPの変更を自動で表示します');
        monitor=setInterval(()=>{void pullIfNeeded(myEpoch);},2200);
        void listen(myEpoch);
      }catch(error){
        if(error.statusCode===401)status('認証に失敗。PCに表示された接続トークンを確認してください');
        else status('PCへの接続に失敗：'+error.message);
        setState('↔ PC接続','接続失敗');
      }
    }
    async function pullIfNeeded(myEpoch) {
      if(!online||epoch!==myEpoch||conflicted)return;
      // The SSE connection signals revisions immediately; the periodic
      // check is a fallback for Safari backgrounding and broken streams.
      if(remoteHint===null || (remoteHint<=serverRevision && !failedRefresh)) {
        try {
          const remote=await request('/api/document');
          if(!online||epoch!==myEpoch)return;
          if(remote.revision>serverRevision) remoteHint=remote.revision;
          else return;
        }catch{return;}
      }
      if(dirty||uploading||isBusy())return;
      try {
        const remote=await request('/api/document');
        if(!online||epoch!==myEpoch)return;
        if(remote.revision<=serverRevision){remoteHint=remote.revision;return;}
        // Remote changes are never allowed to replace unsent local strokes.
        if(dirty||uploading||isBusy())return;
        if(!sameDrawing(getDoc(),remote)) {
          // If unsynced content was produced without a commit, don't erase it.
          if(!replaceDoc(remote))return;
        } else setRevision(remote.revision);
        serverRevision=remote.revision;remoteHint=remote.revision;failedRefresh=false;
        setState('✓ PC接続中','同期中・r'+serverRevision);
        status('PC/MCPの変更を受信しました（r'+serverRevision+'）');
      }catch{
        failedRefresh=true;
        setState('✓ PC接続中','再接続待ち');
      }
    }
    async function listen(myEpoch) {
      while(online&&myEpoch===epoch) {
        const controller=new AbortController();
        abort=controller;
        try {
          const response=await fetch('/api/events',{
            headers:authHeaders(),cache:'no-store',signal:controller.signal
          });
          if(!response.ok||!response.body)throw Error('通知ストリームを開けません');
          const reader=response.body.getReader();
          const decoder=new TextDecoder();
          let buffer='';
          for(;;){
            const {done,value}=await reader.read();
            if(done)break;
            buffer+=decoder.decode(value,{stream:true});
            if(buffer.length>65536)buffer='';
            let cut;
            while((cut=buffer.indexOf('\n\n'))>=0){
              const raw=buffer.slice(0,cut);buffer=buffer.slice(cut+2);
              const line=raw.split('\n').find(x=>x.startsWith('data: '));
              if(!line)continue;
              try {
                const payload=JSON.parse(line.slice(6));
                if(Number.isSafeInteger(payload.revision)&&payload.revision>serverRevision) {
                  remoteHint=payload.revision;
                  void pullIfNeeded(myEpoch);
                }
              }catch{}
            }
          }
        }catch(error){
          if(myEpoch!==epoch||!online)return;
        }
        if(myEpoch!==epoch||!online)return;
        await sleep(1800);
      }
    }
    async function flush(myEpoch=epoch){
      if(!online||conflicted||uploading||!dirty||myEpoch!==epoch)return;
      if(isBusy()){changeTimer=setTimeout(()=>void flush(myEpoch),350);return;}
      uploading=true;
      const snapshot=JSON.stringify(getDoc());
      const expectedRevision=serverRevision;
      try {
        const result=await request('/api/document',{
          method:'PUT',body:JSON.stringify({expectedRevision,document:JSON.parse(snapshot)})
        });
        if(!online||epoch!==myEpoch)return;
        serverRevision=result.revision;
        if(JSON.stringify(getDoc())===snapshot) {
          setRevision(result.revision);
          dirty=false;
        } else { dirty=true; }
        remoteHint=Math.max(remoteHint??0,serverRevision);
        setState('✓ PC接続中',dirty?'保存中…':'同期中・r'+serverRevision);
        if(dirty)changeTimer=setTimeout(()=>void flush(myEpoch),180);
      }catch(error){
        if(!online||epoch!==myEpoch)return;
        if(error.statusCode===409 || error.statusCode===423) {
          conflicted=true;
          setState('⚠ 競合','スマホの変更は未送信');
          status('同時編集の競合を検出！「編集データ保存」で退避してから再接続してください');
        } else if(error.statusCode===401){
          conflicted=true;
          setState('⚠ 認証切れ','スマホの変更は未送信');
          status('PCの認証情報が変わりました。ローカル保存して再接続してください');
        } else {
          setState('↻ 接続不安定','スマホの変更は未送信');
          status('PCに保存できませんでした：'+error.message);
          changeTimer=setTimeout(()=>void flush(myEpoch),3000);
        }
      }finally{uploading=false;}
    }
    function onLocalCommit() {
      if(!online||conflicted)return;
      dirty=true;
      setState('↑ 保存中…','スマホの変更を送信中');
      clearTimeout(changeTimer);
      changeTimer=setTimeout(()=>void flush(),250);
    }
    button.addEventListener('click',()=>{
      if(online && !conflicted){
        if(dirty && !confirm('未送信の変更が残っています。PC同期を切断してもスマホには残ります。続行しますか？'))return;
        stop();status('PC同期を切断。ローカル編集はそのまま残ります');return;
      }
      if(online && conflicted){
        if(!confirm('競合したローカル編集がPCの作品で置き換わる可能性があります。\n「編集データ保存」で退避しましたか？\n再接続しますか？'))return;
        if(!backup())return;
        stop();
      }
      void join();
    });
    return {onLocalCommit,disconnect:stop};
  }
  window.YubiSync={createController};
})();
