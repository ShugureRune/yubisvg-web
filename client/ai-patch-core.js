/*
 * YubiSVG phone-only AI handoff. Pure operations; no network or credentials.
 * Load from a normal browser script or import from Node tests.
 */
(() => {
  'use strict';
  const root=typeof window==='undefined'?globalThis:window;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const fail=message=>{throw new Error(message);};
  const coordinate=n=>Number.isFinite(n)&&Math.abs(n)<=100000;
  const pair=v=>Array.isArray(v)&&v.length===2&&v.every(coordinate);
  const HEX=/^#[0-9a-fA-F]{6}$/;
  // Fast stable 64-bit fingerprint for optimistic conflict checks.
  // It detects accidental changes to the selected element; it is not a
  // cryptographic integrity check or an authentication mechanism.
  function elementFingerprint(element) {
    const json=JSON.stringify(element);
    let hash=0xcbf29ce484222325n;
    for(let i=0;i<json.length;i++){
      hash^=BigInt(json.charCodeAt(i));
      hash=(hash*0x100000001b3n)&0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16,'0');
  }
  function parsePatch(text) {
    if(typeof text!=='string'||text.length>250000)fail('AI修正データが長すぎます');
    let source=text.trim();
    const fence=String.fromCharCode(96).repeat(3);
    if(source.startsWith(fence)) {
      source=source.slice(3).replace(/^json\s*\n?/i,'');
      const end=source.lastIndexOf(fence);
      if(end>=0)source=source.slice(0,end).trim();
    }
    // iOS's smart punctuation and rich-text copy can turn JSON quote marks
    // into typographic characters. Patch strings contain IDs and colors only,
    // so normalizing these characters is safe; all structural validation
    // below remains unchanged.
    source=source.replace(/[\u201c\u201d\u201e\u201f\uff02]/g,'"').replace(/\u00a0/g,' ');
    try {return JSON.parse(source);}
    catch {fail('JSONが読み取れません。ChatGPTのコードブロックから「コピー」して貼り付けてください');}
  }
  function createHandoff(doc,elementId) {
    if(!doc||!Array.isArray(doc.elements))fail('編集データが不正です');
    const element=doc.elements.find(e=>e.id===elementId);
    if(!element)fail('最初に編集したいパーツを選択してください');
    if(element.locked)fail('このパーツはロック中です。解除してからコピーしてください');
    const payload={
      documentId:doc.documentId,expectedRevision:doc.revision,elementId,
      baseElementHash:elementFingerprint(element),element:clone(element)
    };
    return [
      'これはYubiSVGのパーツ編集データです。',
      '私が続けて指定する変更だけを、このパーツに施してください。',
      'パーツID・documentId・expectedRevision・baseElementHashは変更せず、',
      '返答のJSONにbaseElementHashを必ず含めてください。',
      '返答は次の形式のJSONオブジェクトだけにしてください。',
      'ベジェの形を直す場合：{ "documentId": "...", "expectedRevision": 0, "elementId": "...", "baseElementHash": "...", "anchors": [ { "x": 0, "y": 0, "in": [0,0], "out": [0,0] } ] }',
      '色や線幅を直す場合：{ "documentId": "...", "expectedRevision": 0, "elementId": "...", "baseElementHash": "...", "style": { "stroke": "#000000" } }',
      'anchorsとstyleは同時に指定せず、変更対象はこの1パーツのみです。',
      'JSONデータ:',
      JSON.stringify(payload,null,2),
      '',
      '希望の修正：'
    ].join('\n');
  }
  function applyPatch(doc,text) {
    const patch=typeof text==='string'?parsePatch(text):text;
    if(!patch||typeof patch!=='object'||Array.isArray(patch))fail('JSONオブジェクトを貼り付けてください');
    const keys=Object.keys(patch);
    const allowed=new Set(['documentId','expectedRevision','elementId','baseElementHash','anchors','style']);
    if(!keys.every(key=>allowed.has(key)))fail('予期しないキーがあります。修正JSONだけ貼り付けてください');
    if(patch.documentId!==doc.documentId)fail('違う作品の修正データです');
    if(!Number.isSafeInteger(patch.expectedRevision)||patch.expectedRevision<0)fail('作品の版番号が不正です');
    if(typeof patch.elementId!=='string'||!patch.elementId)fail('elementIdがありません');
    const index=doc.elements.findIndex(e=>e.id===patch.elementId);
    if(index<0)fail('対象のパーツが見つかりません');
    const before=doc.elements[index];
    if(before.locked)fail('ロックされたパーツは修正できません');
    if(patch.expectedRevision!==doc.revision) {
      // Old patches without a fingerprint deliberately retain the safe
      // failure behavior. New patches can be applied after unrelated edits.
      if(patch.expectedRevision>doc.revision
        || typeof patch.baseElementHash!=='string'
        || !/^[0-9a-f]{16}$/.test(patch.baseElementHash)
        || patch.baseElementHash!==elementFingerprint(before)) {
        fail('作品の版番号が違います（修正データ：'+patch.expectedRevision+'、現在：'+doc.revision+'）。パーツデータをもう一度コピーしてください');
      }
    } else if(patch.baseElementHash!==undefined &&
      patch.baseElementHash!==elementFingerprint(before)) {
      fail('対象パーツがコピーしたときから変化しています。パーツデータをもう一度コピーしてください');
    }
    const hasAnchors=Object.hasOwn(patch,'anchors'),hasStyle=Object.hasOwn(patch,'style');
    if(hasAnchors===hasStyle)fail('anchorsかstyleのどちらか一方だけ指定してください');
    const after=clone(before);
    let description='';
    if(hasAnchors) {
      if(before.kind!=='bezier')fail('このパーツはベジェ曲線ではありません');
      const a=patch.anchors;
      if(!Array.isArray(a)||a.length<2||a.length>10000||(before.closed&&a.length<3)
        ||!a.every(p=>p&&typeof p==='object'&&!Array.isArray(p)
          &&Object.keys(p).sort().join(',')==='in,out,x,y'
          &&coordinate(p.x)&&coordinate(p.y)&&pair(p.in)&&pair(p.out))) {
        fail('ベジェ制御点の形式が不正です');
      }
      after.anchors=clone(a);
      description='制御点 '+before.anchors.length+'個 → '+a.length+'個';
    } else {
      const style=patch.style;
      if(!style||typeof style!=='object'||Array.isArray(style))fail('style形式が不正です');
      const fields=Object.keys(style),validFields=new Set(['stroke','fill','strokeWidth']);
      if(!fields.length||!fields.every(field=>validFields.has(field)))fail('色と線幅以外は変更できません');
      if(fields.some(field=>['stroke','fill'].includes(field)&&!(HEX.test(style[field])||style[field]==='none')))fail('色は#RRGGBBかnoneで指定してください');
      if('strokeWidth' in style&&(!Number.isFinite(style.strokeWidth)||style.strokeWidth<0||style.strokeWidth>100))fail('線幅が不正です');
      after.style={...after.style,...clone(style)};
      description='スタイルを変更：'+fields.join(' / ');
    }
    if(JSON.stringify(before)===JSON.stringify(after))fail('変更がありません');
    const next=clone(doc);
    next.elements[index]=after;
    next.revision=doc.revision+1;
    return {document:next,before,after,description,elementId:patch.elementId};
  }
  root.YubiAIPatch={parsePatch,createHandoff,applyPatch,elementFingerprint};
})();
