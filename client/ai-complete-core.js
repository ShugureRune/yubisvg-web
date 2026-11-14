/*
 * YubiSVG v0.9: strict single-part continuation/gap completion, plus local
 * horizontal mirroring. This module has no DOM, network, or persistence.
 */
(function (root) {
  'use strict';
  const fail = message => { throw new Error(message); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const validNumber = n => Number.isFinite(n) && Math.abs(n) <= 2000;
  const pair = v => Array.isArray(v) && v.length === 2 && v.every(validNumber);
  const hasKeys = (obj, required) =>
    obj && typeof obj === 'object' && !Array.isArray(obj)
    && Object.keys(obj).length === required.length
    && required.every(key => Object.hasOwn(obj, key));
  const fingerprint = element => {
    if (!root.YubiAIPatch?.elementFingerprint) fail('AI編集機能の読み込みに失敗しました');
    return root.YubiAIPatch.elementFingerprint(element);
  };
  function getTarget(doc, id, {needOpen=false, minAnchors=2}={}) {
    if (!doc || !Array.isArray(doc.elements) || typeof doc.documentId !== 'string'
        || !Number.isSafeInteger(doc.revision) || doc.revision < 0) {
      fail('作品データが不正です');
    }
    const index=doc.elements.findIndex(e=>e && e.id===id);
    if(index < 0) fail('対象パーツが見つかりません');
    const element=doc.elements[index];
    if(element.locked) fail('ロック中のパーツは補完できません');
    if(element.kind!=='bezier'||!Array.isArray(element.anchors)
       ||element.anchors.length < minAnchors) fail('ベジェ図形を選択してください');
    if(needOpen && element.closed) fail('閉じた図形はこの操作に対応していません');
    return {element,index};
  }
  function anchorOK(a) {
    return hasKeys(a,['x','y','in','out']) && validNumber(a.x) && validNumber(a.y)
      && pair(a.in) && pair(a.out);
  }
  function parse(raw) {
    if(typeof raw !== 'string' || raw.length > 100000) fail('補完JSONが長すぎます');
    let str=raw.trim();
    const fence=String.fromCharCode(96).repeat(3);
    if(str.startsWith(fence)) {
      str=str.slice(3).replace(/^json\s*\n?/i,'');
      const last=str.lastIndexOf(fence);
      if(last>=0)str=str.slice(0,last).trim();
    }
    str=str.replace(/[\u201c\u201d\u201e\u201f\uff02]/g,'"').replace(/\u00a0/g,' ');
    try {return JSON.parse(str);} catch {fail('JSONを読み取れません。ChatGPTのJSONコードブロックを貼り付けてください');}
  }
  function buildProposal(doc, raw, selectedId) {
    const patch=typeof raw==='string' ? parse(raw) : raw;
    if(!patch||typeof patch!=='object'||Array.isArray(patch))fail('補完JSONのオブジェクトを貼り付けてください');
    const extending=patch.operation==='extendBezier', closing=patch.operation==='closeGap';
    if(!extending&&!closing)fail('operationはextendBezierかcloseGapにしてください');
    const required=extending
      ? ['documentId','expectedRevision','elementId','baseElementHash','operation','endOut','anchors']
      : ['documentId','expectedRevision','elementId','baseElementHash','operation','endOut','startIn'];
    if(!hasKeys(patch,required))fail('不要なキーや不足キーがあります（変更できるのは対象図形のみ）');
    if(patch.documentId!==doc?.documentId)fail('違う作品の補完JSONです');
    if(!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision!==doc.revision)
      fail('作品の版番号が変わっています。補完依頼をコピーし直してください');
    if(typeof selectedId!=='string'||patch.elementId!==selectedId)
      fail('別のパーツへの補完JSONです。対象パーツを選び直してください');
    const {element}=getTarget(doc,selectedId,{needOpen:true,minAnchors:closing?3:2});
    if(typeof patch.baseElementHash!=='string'
        || !/^[0-9a-f]{16}$/.test(patch.baseElementHash)
        || patch.baseElementHash!==fingerprint(element)) {
      fail('対象パーツがコピー後に変更されています。補完依頼を作り直してください');
    }
    if(!pair(patch.endOut)) fail('終点のoutハンドル座標が不正です');
    const after=clone(element);
    if(extending) {
      if(!Array.isArray(patch.anchors)||patch.anchors.length<1||patch.anchors.length>60
         ||element.anchors.length+patch.anchors.length>10000
         ||!patch.anchors.every(anchorOK)) {
        fail('追加する制御点は1〜60個、既存との合計は10000個以内です');
      }
      const end=element.anchors[element.anchors.length-1];
      const first=patch.anchors[0];
      if(Math.hypot(end.x-first.x,end.y-first.y)<0.2)
        fail('既存の終点と同じ位置には制御点を追加できません');
      after.anchors[after.anchors.length-1].out=patch.endOut.slice();
      after.anchors.push(...clone(patch.anchors));
    } else {
      if(!pair(patch.startIn))fail('始点のinハンドル座標が不正です');
      after.anchors[after.anchors.length-1].out=patch.endOut.slice();
      after.anchors[0].in=patch.startIn.slice();
      after.closed=true;
      if(after.style?.fill==='none') {
        if(!/^#[0-9a-fA-F]{6}$/.test(after.style.stroke||'')) {
          fail('この図形は塗り色を自動設定できません。色を設定してから補完してください');
        }
        after.style.fill=after.style.stroke;
      }
    }
    return {
      documentId:doc.documentId,expectedRevision:doc.revision,elementId:selectedId,
      baseElementHash:patch.baseElementHash,operation:patch.operation,
      candidate:after,description:extending?'末尾へ'+patch.anchors.length+'点を追加':'端点の隙間を閉じる'
    };
  }

  function mirrorProposal(doc,elementId,axisX) {
    if(!Number.isFinite(axisX) || axisX<0 || axisX>800)fail('対称軸Xは0〜800です');
    const {element}=getTarget(doc,elementId);
    if(doc.elements.length>=1500)fail('図形が1500個あります。これ以上追加できません');
    const flipX=x=>Math.round((2*axisX-x)*10)/10;
    const candidate=clone(element);
    // A mirrored shape is a new element, never a rewrite of its original.
    delete candidate.id;
    candidate.name=element.name.slice(0,55)+'（左右反転）';
    candidate.locked=false;
    candidate.anchors=candidate.anchors.map(a=>({
      x:flipX(a.x),y:a.y,
      in:[flipX(a.in[0]),a.in[1]],out:[flipX(a.out[0]),a.out[1]]
    }));
    return {
      documentId:doc.documentId,expectedRevision:doc.revision,elementId,
      baseElementHash:fingerprint(element),operation:'mirrorBezier',axisX,
      candidate,description:'X='+axisX+'を中心に左右反転パーツを追加'
    };
  }

  function createHandoff(doc,elementId,operation) {
    if(!['extendBezier','closeGap'].includes(operation))fail('続きの生成か隙間補完を選択してください');
    const {element}=getTarget(doc,elementId,{needOpen:true,minAnchors:operation==='closeGap'?3:2});
    const n=element.anchors.length;
    const excerpt=operation==='extendBezier'
      ? element.anchors.slice(-12) : [...element.anchors.slice(0,5),...element.anchors.slice(-5)];
    const payload={
      documentId:doc.documentId,expectedRevision:doc.revision,
      elementId,baseElementHash:fingerprint(element),operation
    };
    const sample=operation==='extendBezier'
      ? {...payload,endOut:[200,200],anchors:[{x:240,y:220,in:[220,220],out:[260,220]}]}
      : {...payload,endOut:[200,200],startIn:[100,100]};
    const intro=operation==='extendBezier'
      ? '現在の終点の先へ、自然につながる新しいベジェ制御点を1〜60個だけ追加してください。'
      : '最後の点から最初の点へつながる自然な閉じ曲線を、endOutとstartInの2つのハンドルで指定してください。';
    return [
      'これはYubiSVG v0.9のベジェ曲線半自動補完依頼です。',
      intro,
      'すでにあるアンカー、既存の色、パーツIDを変更してはいけません。',
      '変更可能なのはendOut（元の最終アンカーの出力ハンドル）と',
      operation==='extendBezier'?'新しく追加するanchorsのみです。':'startIn（最初のアンカーの入力ハンドル）のみです。',
      '返答はJSONオブジェクトのみ。余分な項目は付けず、',
      'documentId・expectedRevision・elementId・baseElementHash・operationは正確にコピーしてください。',
      '新規座標は-2000〜2000の有限数値とし、制御点は{x,y,in:[x,y],out:[x,y]}で指定。',
      '形式の例（実際の座標は下記パーツに合わせてください）:',
      JSON.stringify(sample,null,2),
      '対象パーツ（制御点'+n+'個、必要箇所だけ抜粋）:',
      JSON.stringify({
        documentId:doc.documentId,expectedRevision:doc.revision,
        elementId,baseElementHash:payload.baseElementHash,
        name:element.name,closed:element.closed,style:element.style,
        anchorsShown:excerpt,first:element.anchors[0],last:element.anchors[n-1]
      },null,2),
      '必要なら、このチャットに下絵画像を別途添付してください。',
      '',
      '希望の補完内容：'
    ].join('\n');
  }
  root.YubiAIComplete=Object.freeze({parse,buildProposal,mirrorProposal,createHandoff});
  if(typeof module!=='undefined' && module.exports)
    module.exports={parse,buildProposal,mirrorProposal,createHandoff};
})(typeof window!=='undefined'?window:globalThis);
