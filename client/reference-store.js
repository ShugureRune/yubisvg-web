/*
 * Browser-only reference image storage for YubiSVG.
 * Image data is private to this browser's IndexedDB and never uploaded.
 * Only bitmap formats decoded and re-encoded through a canvas are accepted.
 */
(() => {
  'use strict';
  const MAX_FILE_BYTES=12*1024*1024;
  const MAX_DATA_LENGTH=8*1024*1024;
  const ALLOWED=new Set(['image/png','image/jpeg','image/webp','image/heic','image/heif']);
  const DATA=/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/i;
  const isImageDataUrl=value=>typeof value==='string'
    &&value.length<=MAX_DATA_LENGTH&&DATA.test(value);
  let dbPromise;
  function openDatabase() {
    if(dbPromise)return dbPromise;
    if(!('indexedDB' in window))return Promise.reject(new Error('このブラウザでは下絵の保存ができません'));
    dbPromise=new Promise((resolve,reject)=>{
      const request=window.indexedDB.open('YubiSVG-reference-images',1);
      request.onupgradeneeded=()=>{
        if(!request.result.objectStoreNames.contains('images'))
          request.result.createObjectStore('images');
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('下絵の保存先を開けません'));
      request.onblocked=()=>reject(new Error('下絵の保存先が別のタブで使用中です'));
    }).catch(error=>{dbPromise=null;throw error;});
    return dbPromise;
  }
  async function transact(mode,run) {
    const db=await openDatabase();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('images',mode),store=tx.objectStore('images');
      let value,failed=false;
      tx.oncomplete=()=>resolve(value);
      tx.onerror=()=>reject(tx.error||new Error('下絵の保存に失敗しました'));
      tx.onabort=()=>reject(tx.error||new Error('下絵の保存が中断されました'));
      try {
        const request=run(store);
        if(request){
          request.onsuccess=()=>{value=request.result;};
          request.onerror=()=>{failed=true;};
        }
      }catch(error){tx.abort();reject(error);}
    });
  }
  async function save(id,dataUrl){
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(id))throw new Error('下絵IDが不正です');
    if(!isImageDataUrl(dataUrl))throw new Error('下絵画像が大きすぎるか、対応していない形式です');
    await transact('readwrite',store=>store.put(dataUrl,id));
  }
  async function load(id){
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(id))return null;
    const result=await transact('readonly',store=>store.get(id));
    return isImageDataUrl(result)?result:null;
  }
  async function remove(id){
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(id))return;
    await transact('readwrite',store=>store.delete(id));
  }
  async function prepareImage(file) {
    if(!file||!ALLOWED.has(file.type))throw new Error('PNG・JPEG・WebP・HEIC画像を選択してください');
    if(file.size<=0||file.size>MAX_FILE_BYTES)throw new Error('画像は12MB以下にしてください');
    const objectUrl=URL.createObjectURL(file);
    try {
      const img=new Image();
      await new Promise((resolve,reject)=>{
        img.onload=resolve;
        img.onerror=()=>reject(new Error('画像を開けませんでした'));
        img.src=objectUrl;
      });
      const width=img.naturalWidth,height=img.naturalHeight;
      if(!width||!height||width>12000||height>12000||width*height>60000000)
        throw new Error('画像の解像度が大きすぎます');
      const ratio=Math.min(1,1600/Math.max(width,height));
      const w=Math.max(1,Math.round(width*ratio));
      const h=Math.max(1,Math.round(height*ratio));
      const canvas=document.createElement('canvas');
      canvas.width=w;canvas.height=h;
      const context=canvas.getContext('2d');
      if(!context)throw new Error('画像を縮小できませんでした');
      context.drawImage(img,0,0,w,h);
      let dataUrl=canvas.toDataURL('image/webp',.86);
      if(!dataUrl.startsWith('data:image/webp;'))
        dataUrl=canvas.toDataURL('image/png');
      if(!isImageDataUrl(dataUrl))throw new Error('画像が大きすぎます。小さくして再選択してください');
      return {dataUrl,width:w,height:h};
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
  window.YubiReference={save,load,remove,prepareImage,isImageDataUrl};
})();