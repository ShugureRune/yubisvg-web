/* YubiSVG v0.7: convert a freehand stroke into editable cubic Bezier anchors.
 * Pure geometry: no DOM, no image access and no saved-document changes.
 */
(function (root) {
  'use strict';

  const round = value => Math.round(value * 10) / 10;
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function cleanedPoints(raw) {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 30000) {
      throw new Error('2点以上のラフ線が必要です');
    }
    const points = [];
    for (const p of raw) {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) {
        throw new Error('ラフ線に不正な座標があります');
      }
      if (!points.length || distance(p, points[points.length - 1]) >= 0.2) {
        points.push([p[0], p[1]]);
      }
    }
    if (points.length < 2) throw new Error('線が短すぎます。もう少し長く描いてください');
    // Avoid quadratic work on exceptionally long touch gestures.
    if (points.length <= 3500) return points;
    const stride = Math.ceil(points.length / 3500);
    const reduced = points.filter((_, index) => index % stride === 0);
    if (distance(reduced[reduced.length - 1], points[points.length - 1]) > 0.01) {
      reduced.push(points[points.length - 1]);
    }
    return reduced;
  }

  function smooth(points, closed) {
    const n = points.length;
    return points.map((p, i) => {
      if ((!closed && (i === 0 || i === n - 1)) || sharpCorner(points, i, closed)) return p.slice();
      const before = points[(i + n - 1) % n];
      const after = points[(i + 1) % n];
      return [
        before[0] * 0.2 + p[0] * 0.6 + after[0] * 0.2,
        before[1] * 0.2 + p[1] * 0.6 + after[1] * 0.2
      ];
    });
  }

  function segmentDistanceSq(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
    return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
  }

  // Iterative Ramer-Douglas-Peucker (safe even for thousands of points).
  function simplify(points, tolerance) {
    const n = points.length, keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    const stack = [[0, n - 1]], tolSq = tolerance * tolerance;
    while (stack.length) {
      const [start, end] = stack.pop();
      let best = tolSq, bestIndex = -1;
      for (let i = start + 1; i < end; i++) {
        const d = segmentDistanceSq(points[i], points[start], points[end]);
        if (d > best) { best = d; bestIndex = i; }
      }
      if (bestIndex !== -1) {
        keep[bestIndex] = 1;
        stack.push([start, bestIndex], [bestIndex, end]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  function sharpCorner(points, index, closed) {
    const n = points.length;
    if (!closed && (index === 0 || index === n - 1)) return false;
    const prev = points[(index + n - 1) % n], cur = points[index], next = points[(index + 1) % n];
    const ax = cur[0] - prev[0], ay = cur[1] - prev[1];
    const bx = next[0] - cur[0], by = next[1] - cur[1];
    const length = Math.hypot(ax, ay) * Math.hypot(bx, by);
    return length > 0.001 && (ax * bx + ay * by) / length < 0.48;
  }

  function control(from, directionX, directionY, segmentLength) {
    const length = Math.hypot(directionX, directionY);
    const scale = length ? Math.min(1, segmentLength * 0.48 / length) : 0;
    return [round(from[0] + directionX * scale), round(from[1] + directionY * scale)];
  }

  function convert(raw, options = {}) {
    const closed = Boolean(options.closed);
    const detail = Math.max(1, Math.min(9, Number(options.detail) || 5));
    const points = cleanedPoints(raw);
    // For loops whose last sample almost touches the first, do not create
    // a duplicate endpoint. The closing cubic will reconnect the two ends.
    if (closed && points.length > 3 && distance(points[0], points[points.length - 1]) < 12) {
      points.pop();
    }
    const softened = smooth(points, closed);
    let tolerance = 0.8 + (9 - detail) * 0.5;
    let fitted = simplify(softened, tolerance);
    for (let i = 0; fitted.length > 500 && i < 12; i++) {
      tolerance *= 1.5;
      fitted = simplify(softened, tolerance);
    }
    if (fitted.length < (closed ? 3 : 2)) {
      // Keep a minimal closed loop if aggressive simplification collapsed it.
      if (!closed) throw new Error('変換できる長さの線がありません');
      fitted = simplify(softened, 0.01);
      if (fitted.length < 3) throw new Error('閉じた図形には3点以上必要です');
    }
    if (fitted.length > 500) throw new Error('線が複雑すぎます。短めに分けて描いてください');

    const n = fitted.length;
    const anchors = fitted.map(p => ({
      x: round(p[0]), y: round(p[1]),
      in: [round(p[0]), round(p[1])], out: [round(p[0]), round(p[1])]
    }));
    // Catmull-Rom -> cubic Bezier with corner protection and bounded handles.
    const segments = closed ? n : n - 1;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % n, a = fitted[i], b = fitted[j];
      const before = fitted[(i + n - 1) % n], after = fitted[(j + 1) % n];
      const p0 = (!closed && i === 0) ? a : before;
      const p3 = (!closed && j === n - 1) ? b : after;
      const len = distance(a, b);
      const outX = sharpCorner(fitted, i, closed) ? 0 : (b[0] - p0[0]) / 6;
      const outY = sharpCorner(fitted, i, closed) ? 0 : (b[1] - p0[1]) / 6;
      const inX = sharpCorner(fitted, j, closed) ? 0 : (a[0] - p3[0]) / 6;
      const inY = sharpCorner(fitted, j, closed) ? 0 : (a[1] - p3[1]) / 6;
      anchors[i].out = control(a, outX, outY, len);
      anchors[j].in = control(b, inX, inY, len);
    }
    return anchors;
  }

  root.YubiRoughCurve = Object.freeze({ convert });
  if (typeof module !== 'undefined' && module.exports) module.exports = { convert };
})(typeof window !== 'undefined' ? window : globalThis);
