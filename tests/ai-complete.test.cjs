// Run: node --test tests/ai-complete.test.cjs
const test=require('node:test');
const assert=require('node:assert/strict');
require('../client/ai-patch-core.js');
const {createHandoff,buildProposal,mirrorProposal,parse}=require('../client/ai-complete-core.js');

function shape(overrides={}) {
  return {id:'selected',name:'前髪',kind:'bezier',locked:false,closed:false,
    anchors:[
      {x:100,y:100,in:[100,100],out:[125,90]},
      {x:160,y:80,in:[145,90],out:[175,85]},
      {x:220,y:120,in:[205,110],out:[220,120]}
    ],
    style:{stroke:'#61249b',fill:'none',strokeWidth:4},...overrides};
}
function project(part=shape()) {
  return {schemaVersion:1,documentId:'drawing-1',revision:18,elements:[
    {id:'other',name:'他パーツ',kind:'brush',points:[[10,20],[30,40]],locked:false,style:{stroke:'#445566',fill:'none',strokeWidth:2}},
    part]};
}
const fingerprint=part=>globalThis.YubiAIPatch.elementFingerprint(part);
function extend(doc=project()) {
  return {documentId:doc.documentId,expectedRevision:doc.revision,elementId:'selected',
    baseElementHash:fingerprint(doc.elements[1]),operation:'extendBezier',
    endOut:[230,140],
    anchors:[{x:250,y:160,in:[240,150],out:[260,170]}]};
}
function gap(doc=project()) {
  return {documentId:doc.documentId,expectedRevision:doc.revision,elementId:'selected',
    baseElementHash:fingerprint(doc.elements[1]),operation:'closeGap',
    endOut:[250,140],startIn:[50,110]};
}
test('handoffs include current ID, revision and fingerprint',()=>{
  const doc=project();
  for(const op of ['extendBezier','closeGap']) {
    const prompt=createHandoff(doc,'selected',op);
    assert.match(prompt,new RegExp(op));
    assert.match(prompt,/baseElementHash/);
    assert.match(prompt,/drawing-1/);
    assert.match(prompt,/前髪/);
  }
});
test('extension preserves every old anchor except final outgoing handle',()=>{
  const doc=project(), before=JSON.stringify(doc);
  const proposal=buildProposal(doc,extend(doc),'selected');
  assert.equal(proposal.operation,'extendBezier');
  assert.equal(proposal.candidate.anchors.length,4);
  assert.deepEqual(proposal.candidate.anchors[0],doc.elements[1].anchors[0]);
  assert.deepEqual(proposal.candidate.anchors[1],doc.elements[1].anchors[1]);
  assert.deepEqual(proposal.candidate.anchors[2].out,[230,140]);
  assert.deepEqual(proposal.candidate.anchors[3],[{x:250,y:160,in:[240,150],out:[260,170]}][0]);
  assert.equal(proposal.candidate.id,'selected');
  assert.equal(JSON.stringify(doc),before);
});
test('closing a gap connects handles and fills only the selected part',()=>{
  const doc=project(),before=JSON.stringify(doc);
  const proposal=buildProposal(doc,gap(doc),'selected');
  assert.equal(proposal.candidate.closed,true);
  assert.deepEqual(proposal.candidate.anchors[0].in,[50,110]);
  assert.deepEqual(proposal.candidate.anchors[2].out,[250,140]);
  assert.equal(proposal.candidate.style.fill,'#61249b');
  assert.equal(proposal.candidate.style.strokeWidth,4);
  assert.equal(JSON.stringify(doc),before);
});
test('local horizontal reflection swaps x while keeping y, style and source',()=>{
  const doc=project(),original=JSON.stringify(doc);
  const proposal=mirrorProposal(doc,'selected',400);
  assert.equal(proposal.operation,'mirrorBezier');
  assert.equal('id' in proposal.candidate,false);
  assert.equal(proposal.candidate.name,'前髪（左右反転）');
  assert.equal(proposal.candidate.anchors[0].x,700);
  assert.deepEqual(proposal.candidate.anchors[0].out,[675,90]);
  assert.deepEqual(proposal.candidate.style,doc.elements[1].style);
  assert.equal(JSON.stringify(doc),original);
});
test('wrong ID, revision, hash and extra keys are rejected',()=>{
  const doc=project();
  const other=extend(doc);other.elementId='other';
  assert.throws(()=>buildProposal(doc,other,'selected'),/別のパーツ/);
  const stale=extend(doc);stale.expectedRevision=17;
  assert.throws(()=>buildProposal(doc,stale,'selected'),/版番号/);
  const changed=extend(doc);changed.baseElementHash='0000000000000000';
  assert.throws(()=>buildProposal(doc,changed,'selected'),/対象パーツ/);
  const attack=extend(doc);attack.style={fill:'#ffffff'};
  assert.throws(()=>buildProposal(doc,attack,'selected'),/不要なキー/);
  const attack2=gap(doc);attack2.id='other';
  assert.throws(()=>buildProposal(doc,attack2,'selected'),/不要なキー/);
  const wrong=extend(doc);wrong.operation='deleteElement';
  assert.throws(()=>buildProposal(doc,wrong,'selected'),/operation/);
});
test('geometry limits and different operation fields are rejected',()=>{
  const doc=project();
  const huge=extend(doc);huge.anchors=Array.from({length:61},(_,i)=>({x:i,y:0,in:[i,0],out:[i,0]}));
  assert.throws(()=>buildProposal(doc,huge,'selected'),/1〜60/);
  const bad=extend(doc);bad.anchors[0].x=Infinity;
  assert.throws(()=>buildProposal(doc,bad,'selected'),/追加する制御点/);
  const duplicate=extend(doc);duplicate.anchors[0].x=220;duplicate.anchors[0].y=120;
  assert.throws(()=>buildProposal(doc,duplicate,'selected'),/同じ位置/);
  const wrong=gap(doc);wrong.startIn='nope';
  assert.throws(()=>buildProposal(doc,wrong,'selected'),/始点/);
});
test('locked, closed, nonexistent and invalid axis are rejected',()=>{
  const locked=project(shape({locked:true}));
  assert.throws(()=>mirrorProposal(locked,'selected',400),/ロック/);
  assert.throws(()=>buildProposal(locked,extend(locked),'selected'),/ロック/);
  const closed=project(shape({closed:true}));
  assert.throws(()=>buildProposal(closed,extend(closed),'selected'),/閉じた/);
  assert.throws(()=>mirrorProposal(project(),'not-here',400),/見つかりません/);
  assert.throws(()=>mirrorProposal(project(),'selected',801),/0〜800/);
});
test('no invisible closure if original stroke and fill are both none',()=>{
  const source=project(shape({style:{stroke:'none',fill:'none',strokeWidth:0}}));
  assert.throws(()=>buildProposal(source,gap(source),'selected'),/塗り色/);
});
test('fenced JSON parse supports iOS formatting',()=>{
  const doc=project(),json=JSON.stringify(extend(doc));
  const source='\x60\x60\x60json\n'+json+'\n\x60\x60\x60';
  assert.equal(buildProposal(doc,source,'selected').operation,'extendBezier');
  assert.throws(()=>parse('not valid json'),/JSON/);
});
