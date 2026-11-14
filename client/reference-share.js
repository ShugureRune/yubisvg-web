/*
 * Convert an on-device YubiSVG reference into a shareable PNG file.
 * No network calls, no automatic uploads, no ChatGPT API integration.
 * The UI presents an explicit share sheet or a manual image download.
 */
(() => {
  'use strict';
  const MAX_BYTES=25*1024*1024;
  const PNG_TYPE='image/png';
  const FILENAME='yubisvg-reference.png';

  function makePNGFile(blob) {
    if(!blob || blob.size<1 || blob.size>MAX_BYTES)
      throw new Error('共有用の画像が大きすぎます。別の画像を使ってください');
    return new File([blob],FILENAME,{type:PNG_TYPE,lastModified:Date.now()});
  }

  function decodePNG(dataUrl) {
    const source=dataUrl.slice(dataUrl.indexOf(',')+1).replace(/\s/g,'');
    const raw=atob(source);
    const buffer=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)buffer[i]=raw.charCodeAt(i);
    return makePNGFile(new Blob([buffer],{type:PNG_TYPE}));
  }

  async function convertToPNG(dataUrl) {
    const image=new Image();
    await new Promise((resolve,reject)=>{
      image.onload=()=>resolve();
      image.onerror=()=>reject(new Error('下絵をPNGに変換できませんでした'));
      image.src=dataUrl;
    });
    const width=image.naturalWidth,height=image.naturalHeight;
    if(!width||!height||width>3000||height>3000)
      throw new Error('共有用の画像サイズが不正です');
    const canvas=document.createElement('canvas');
    canvas.width=width;
    canvas.height=height;
    const context=canvas.getContext('2d');
    if(!context)throw new Error('画像変換が利用できません');
    context.drawImage(image,0,0);
    const blob=await new Promise((resolve,reject)=>{
      try {canvas.toBlob(result=>result?resolve(result)
        :reject(new Error('画像の変換に失敗しました')),PNG_TYPE);}
      catch(error){reject(error);}
    });
    return makePNGFile(blob);
  }

  async function prepareFile(dataUrl) {
    if(!window.YubiReference?.isImageDataUrl?.(dataUrl))
      throw new Error('下絵の画像データがありません。もう一度読み込んでください');
    if(dataUrl.startsWith('data:image/png;'))return decodePNG(dataUrl);
    return convertToPNG(dataUrl);
  }

  window.YubiShare={prepareFile};
})();