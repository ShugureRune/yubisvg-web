// Run: node --test tests/rough-to-bezier.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const {convert} = require('../client/rough-to-bezier.js');

test('straight stroke becomes a two-anchor editable path without touching input', () => {
  const original = [[0, 0], [10, 0], [20, 0], [30, 0]];
  const snapshot = JSON.stringify(original);
  const anchors = convert(original, { detail: 5 });
  assert.equal(anchors.length, 2);
  assert.deepEqual([anchors[0].x, anchors[0].y], [0, 0]);
  assert.deepEqual([anchors[1].x, anchors[1].y], [30, 0]);
  assert.equal(JSON.stringify(original), snapshot);
});

test('sharp corners survive the fitting process', () => {
  const anchors = convert([[0,0],[50,0],[50,50]]);
  assert.equal(anchors.length, 3);
  assert.deepEqual([anchors[1].x, anchors[1].y], [50,0]);
  assert.deepEqual(anchors[1].in, [50,0]);
  assert.deepEqual(anchors[1].out, [50,0]);
});

test('closed rectangles do not duplicate their last anchor', () => {
  const anchors = convert([[0,0],[60,0],[60,60],[0,60],[0,0]], {closed:true});
  assert.equal(anchors.length, 4);
  assert.deepEqual(anchors.map(a=>[a.x,a.y]), [[0,0],[60,0],[60,60],[0,60]]);
});

test('closed circles reduce sample points and retain finite control handles', () => {
  const points = Array.from({length:181},(_,i)=>[
    100 + 50*Math.cos(i*Math.PI/90), 100 + 50*Math.sin(i*Math.PI/90)
  ]);
  const anchors = convert(points, {closed:true,detail:5});
  assert.ok(anchors.length >= 6 && anchors.length < 181);
  for (const anchor of anchors) {
    assert.ok([anchor.x,anchor.y,...anchor.in,...anchor.out].every(Number.isFinite));
  }
});

test('detail slider creates a meaningful reduction difference', () => {
  const points = Array.from({length:201},(_,i)=>[i*2, 20*Math.sin(i/7)]);
  assert.ok(convert(points,{detail:9}).length >= convert(points,{detail:1}).length);
});

test('invalid and too-short strokes are rejected', () => {
  assert.throws(()=>convert([[0,0]]),/2点/);
  assert.throws(()=>convert([[1,2],[NaN,2]]),/不正/);
  assert.throws(()=>convert([[0,0],[0,0]]),/短すぎ/);
});

test('long strokes never exceed the editor anchor limit', () => {
  const points = Array.from({length:10000},(_,i)=>[i/3, 80*Math.sin(i/80)]);
  const anchors = convert(points,{detail:9});
  assert.ok(anchors.length>=2 && anchors.length<=500);
});
