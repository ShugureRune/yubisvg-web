/*
 * YubiSVG v0.8: AI-proposed NEW Bezier elements.
 * Pure validation and handoff generation. No network, DOM, or document mutation.
 */
(function (root) {
  'use strict';

  const fail = message => { throw new Error(message); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const ownKeys = (obj, allowed, required) =>
    obj && typeof obj === 'object' && !Array.isArray(obj)
    && Object.keys(obj).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(obj, key));
  const point = value => Number.isFinite(value) && Math.abs(value) <= 2000;
  const pair = v => Array.isArray(v) && v.length === 2 && v.every(point);
  const hex = /^#[0-9a-fA-F]{6}$/;
  const color = v => v === 'none' || (typeof v === 'string' && hex.test(v));

  function parse(text) {
    if (typeof text !== 'string' || text.length > 150000) fail('生成JSONが長すぎます（最大15万文字）');
    let source = text.trim();
    const fence = String.fromCharCode(96).repeat(3);
    if (source.startsWith(fence)) {
      source = source.slice(3).replace(/^json\s*\n?/i, '');
      const end = source.lastIndexOf(fence);
      if (end >= 0) source = source.slice(0, end).trim();
    }
    source = source.replace(/[\u201c\u201d\u201e\u201f\uff02]/g, '"').replace(/\u00a0/g, ' ');
    try { return JSON.parse(source); }
    catch { fail('JSONを読み取れません。ChatGPTのJSONコードブロックをコピーしてください'); }
  }

  function checkElement(candidate, index) {
    const required = ['name','kind','closed','anchors','style'];
    if (!ownKeys(candidate, required, required)) fail((index+1)+'番目の図形に不正な項目があります（idなどは付けないでください）');
    if (typeof candidate.name !== 'string' || candidate.name.trim().length < 1
        || candidate.name.length > 70) fail((index+1)+'番目の名前は1〜70文字にしてください');
    if (candidate.kind !== 'bezier') fail('新規生成はベジェ図形（kind: bezier）のみ対応しています');
    if (typeof candidate.closed !== 'boolean') fail('closedはtrueまたはfalseにしてください');
    const a = candidate.anchors;
    if (!Array.isArray(a) || a.length < (candidate.closed ? 3 : 2) || a.length > 160) {
      fail((index+1)+'番目の制御点は'+(candidate.closed?'3':'2')+'〜160個にしてください');
    }
    for (const node of a) {
      if (!ownKeys(node, ['x','y','in','out'], ['x','y','in','out'])
          || !point(node.x) || !point(node.y) || !pair(node.in) || !pair(node.out)) {
        fail((index+1)+'番目のベジェ制御点の座標が不正です（-2000〜2000）');
      }
    }
    const s = candidate.style;
    if (!ownKeys(s,['stroke','fill','strokeWidth'],['stroke','fill','strokeWidth'])
        || !color(s.stroke) || !color(s.fill) || !Number.isFinite(s.strokeWidth)
        || s.strokeWidth < 0 || s.strokeWidth > 40) {
      fail((index+1)+'番目の色や線幅が不正です');
    }
    if (!candidate.closed && s.fill !== 'none') fail('開いたベジェ線のfillはnoneにしてください');
    if (s.stroke === 'none' && (!candidate.closed || s.fill === 'none')) {
      fail('線も塗りも見えない図形は追加できません');
    }
    if (s.stroke === 'none' && s.strokeWidth !== 0) {
      fail('strokeがnoneの場合、strokeWidthは0にしてください');
    }
    // Ignore all foreign object prototypes, and copy only fully validated data.
    return {name:candidate.name.trim(), kind:'bezier', closed:candidate.closed,
      anchors:a.map(p=>({x:p.x,y:p.y,in:p.in.slice(),out:p.out.slice()})),
      style:{stroke:s.stroke,fill:s.fill,strokeWidth:s.strokeWidth}};
  }

  function buildProposal(doc, raw) {
    if (!doc || !Array.isArray(doc.elements) || typeof doc.documentId !== 'string'
        || !Number.isSafeInteger(doc.revision)) fail('現在の作品データが不正です');
    const patch = typeof raw === 'string' ? parse(raw) : raw;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('JSONオブジェクトを貼り付けてください');
    const isSingle = patch.operation === 'createElement';
    const isMany = patch.operation === 'createElements';
    if (!isSingle && !isMany) fail('operationはcreateElementかcreateElementsにしてください');
    const permitted = isSingle
      ? ['documentId','expectedRevision','operation','element']
      : ['documentId','expectedRevision','operation','elements'];
    if (!ownKeys(patch,permitted,permitted)) fail('新規図形以外の項目は指定できません');
    if (patch.documentId !== doc.documentId) fail('違う作品の生成データです');
    if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 0
        || patch.expectedRevision !== doc.revision) {
      fail('作品の版番号が変わっています。「AIで新規作成」から依頼文をコピーし直してください');
    }
    const input = isSingle ? [patch.element] : patch.elements;
    if (!Array.isArray(input) || input.length < 1 || input.length > 12
        || doc.elements.length + input.length > 1500) {
      fail('一度に追加できるのは1〜12パーツです（作品全体は1500パーツ以内）');
    }
    const elements = input.map(checkElement);
    const totalAnchors = elements.reduce((sum,e)=>sum+e.anchors.length,0);
    if (totalAnchors > 600) fail('制御点の合計は600個以内にしてください');
    return {documentId:doc.documentId,expectedRevision:doc.revision,
      elements, description:elements.length+'個の新規ベジェ図形'};
  }

  function bounds(e) {
    const points = e.kind === 'bezier'
      ? (Array.isArray(e.anchors) ? e.anchors.map(a=>[a.x,a.y]) : [])
      : (Array.isArray(e.points) ? e.points : []);
    if (!points.length) return null;
    const xs=points.map(p=>p[0]), ys=points.map(p=>p[1]);
    if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return null;
    return {x:Math.round(Math.min(...xs)),y:Math.round(Math.min(...ys)),
      width:Math.round(Math.max(...xs)-Math.min(...xs)),
      height:Math.round(Math.max(...ys)-Math.min(...ys))};
  }

  function createHandoff(doc) {
    if (!doc || typeof doc.documentId !== 'string' || !Number.isSafeInteger(doc.revision)
        || !Array.isArray(doc.elements)) fail('作品データが不正です');
    const summary = {
      canvas:{width:800,height:800,coordinateSystem:'左上(0,0)、右下(800,800)'},
      documentId:doc.documentId,expectedRevision:doc.revision,
      existingElements:doc.elements.slice(-24).map(e=>({
        name:e.name,kind:e.kind,bounds:bounds(e)
      })),
      existingElementCount:doc.elements.length
    };
    if(doc.reference) {
      const r=doc.reference;
      summary.reference={x:r.x,y:r.y,width:r.width,height:r.height,visible:r.visible};
    }
    const example={
      documentId:doc.documentId,expectedRevision:doc.revision,operation:'createElement',
      element:{name:'新しいパーツ',kind:'bezier',closed:true,
        anchors:[
          {x:200,y:200,in:[200,200],out:[250,200]},
          {x:350,y:300,in:[350,250],out:[350,350]},
          {x:200,y:400,in:[250,400],out:[200,400]}
        ],
        style:{stroke:'#53328a',fill:'#a88bea',strokeWidth:4}}
    };
    return [
      'これはYubiSVG v0.8の新規パーツ生成依頼です。',
      '希望の図形を、新しい編集可能なベジェ図形として作ってください。',
      '既存パーツの編集・削除はしないでください。idやlockedは含めないでください。',
      '出力はJSONオブジェクトだけです（説明文は不要）。',
      '1パーツの場合はoperation:createElementとelementを、複数ならoperation:createElementsとelements配列を使ってください。',
      'documentIdとexpectedRevisionは以下の作品情報からそのまま写してください。',
      '許可する図形: {name,kind:"bezier",closed,anchors:[{x,y,in:[x,y],out:[x,y]}],style:{stroke,fill,strokeWidth}}',
      '1回12パーツまで、1パーツの制御点は160個以内、合計600個以内。座標は-2000〜2000。',
      'strokeとfillは#RRGGBBまたはnone、線幅は0〜40。開いたパスのfillはnone。',
      '参考JSON（座標や色は依頼に応じて変更してください）:',
      JSON.stringify(example,null,2),
      '作品情報（既存パーツは変更しないでください）:',
      JSON.stringify(summary,null,2),
      '下絵画像はこのテキストに含まれません。画像を共有した場合だけ、その画像も参照してください。',
      '',
      '追加したい新規パーツ：'
    ].join('\n');
  }

  root.YubiAICreate=Object.freeze({parse,buildProposal,createHandoff});
  if (typeof module !== 'undefined' && module.exports) module.exports={parse,buildProposal,createHandoff};
})(typeof window !== 'undefined' ? window : globalThis);
