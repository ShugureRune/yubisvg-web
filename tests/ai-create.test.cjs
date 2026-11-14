// Run: node --test tests/ai-create.test.cjs
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildProposal,createHandoff,parse}=require('../client/ai-create-core.js');

const doc=()=>({schemaVersion:1,documentId:'drawing-1',revision:11,
  elements:[{id:'existing',name:'既存の目',kind:'bezier',locked:true,closed:false,
    anchors:[{x:1,y:2,in:[1,2],out:[1,2]},{x:3,y:4,in:[3,4],out:[3,4]}],
    style:{stroke:'#000000',fill:'none',strokeWidth:2}}]});
const shape=()=>({name:'追加の髪',kind:'bezier',closed:true,
  anchors:[{x:10,y:20,in:[10,20],out:[20,20]},
    {x:90,y:20,in:[80,20],out:[90,25]},
    {x:50,y:95,in:[50,70],out:[40,95]}],
  style:{stroke:'#522c8b',fill:'#9e77d8',strokeWidth:4}});
const single=()=>({documentId:'drawing-1',expectedRevision:11,
  operation:'createElement',element:shape()});
const many=()=>({documentId:'drawing-1',expectedRevision:11,
  operation:'createElements',elements:[shape(),shape()]});

test('handoff includes version, document context and permitted operations',()=>{
  const message=createHandoff(doc());
  assert.match(message,/createElement/);
  assert.match(message,/createElements/);
  assert.match(message,/drawing-1/);
  assert.match(message,/"expectedRevision": 11/);
});
test('single part is valid, sanitized and has no model-supplied ID',()=>{
  const project=doc(), before=JSON.stringify(project);
  const proposal=buildProposal(project,JSON.stringify(single()));
  assert.equal(proposal.elements.length,1);
  assert.equal(proposal.elements[0].name,'追加の髪');
  assert.equal('id' in proposal.elements[0],false);
  assert.equal(JSON.stringify(project),before);
});
test('multiple shapes are accepted without touching existing layers',()=>{
  const project=doc(),before=JSON.stringify(project);
  const proposal=buildProposal(project,many());
  assert.equal(proposal.elements.length,2);
  assert.equal(JSON.stringify(project),before);
});
test('JSON fenced in Markdown is accepted',()=>{
  const source='\x60\x60\x60json\n'+JSON.stringify(single())+'\n\x60\x60\x60';
  assert.equal(buildProposal(doc(),source).elements.length,1);
});
test('wrong document or stale revision fails closed',()=>{
  const wrong=single();wrong.documentId='other';
  assert.throws(()=>buildProposal(doc(),wrong),/違う作品/);
  const stale=single();stale.expectedRevision=10;
  assert.throws(()=>buildProposal(doc(),stale),/版番号/);
});
test('AI cannot supply existing IDs, modify fields or extra operations',()=>{
  const id=single();id.element.id='existing';
  assert.throws(()=>buildProposal(doc(),id),/不正な項目/);
  const additional=single();additional.deleteElements=['existing'];
  assert.throws(()=>buildProposal(doc(),additional),/新規図形以外/);
  const inject=single();inject.element.locked=true;
  assert.throws(()=>buildProposal(doc(),inject),/不正な項目/);
});
test('invalid geometry and styles are rejected',()=>{
  const bad=single();bad.element.anchors[0].x=1000000;
  assert.throws(()=>buildProposal(doc(),bad),/座標/);
  const tooFew=single();tooFew.element.anchors.pop();
  assert.throws(()=>buildProposal(doc(),tooFew),/制御点/);
  const openFill=single();openFill.element.closed=false;
  assert.throws(()=>buildProposal(doc(),openFill),/fill/);
  const wrongColor=single();wrongColor.element.style.fill='url(evil)';
  assert.throws(()=>buildProposal(doc(),wrongColor),/色や線幅/);
  const svgTag=single();svgTag.element.kind='foreignObject';
  assert.throws(()=>buildProposal(doc(),svgTag),/ベジェ図形/);
});
test('batch count, total anchors and project size limits enforced',()=>{
  const over=many();over.elements=Array.from({length:13},shape);
  assert.throws(()=>buildProposal(doc(),over),/1〜12/);
  const heavy=many();heavy.elements=Array.from({length:12},()=>{
    const e=shape();e.anchors=Array.from({length:55},(_,i)=>({
      x:i,y:i,in:[i,i],out:[i,i]}));return e;});
  assert.throws(()=>buildProposal(doc(),heavy),/600/);
  const full=doc();full.elements=Array.from({length:1500},(_,i)=>({id:'e'+i}));
  assert.throws(()=>buildProposal(full,single()),/1500/);
});
test('parser rejects malformed and very large text',()=>{
  assert.throws(()=>parse('oops'),/JSON/);
  assert.throws(()=>parse('a'.repeat(150001)),/長すぎ/);
});
