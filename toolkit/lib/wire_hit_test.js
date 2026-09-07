"use strict";

// lib/wire_hit_test.js — Geometric hit-test for connection wires on the
// font_apply_panel canvas. PURE math, no DOM — unit-testable in Node.
//
// WHY this exists (findings.md #uxp-dialog-webview-api-gaps):
//   UXP webview only honors `pointer-events: none`. `pointer-events: stroke`
//   and SVG child-override of a `none` parent are NOT honored, so the wire
//   `<path>` is never the pointer target — a click on a wire lands on the
//   canvas and starts a pan instead of opening its "Remove pairing" menu.
//   Fix: on canvas pointerdown, geometrically test the cursor against each
//   wire's curve BEFORE the pan starts; on a hit, skip the pan and open the
//   menu. This module is that geometry.
//
// Coordinate frame: all inputs are in canvas-inner content coords (the same
// frame `portPos` lives in — relative to the `.wires` SVG bbox). The caller
// converts the pointer's clientX/clientY into this frame before calling.
//
// Each wire carries its own endpoints + bezier control points (embedded by the
// panel at build time): { a:{x,y}, b:{x,y}, c1:{x,y}, c2:{x,y} }. That removes
// any need to re-derive port positions here — the test is self-contained.

// Distance from point P to the line SEGMENT A→B (clamped to the segment ends).
function pointToSegmentDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = (len2 === 0) ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var cx = ax + t * dx, cy = ay + t * dy;
    var ex = px - cx, ey = py - cy;
    return Math.sqrt(ex * ex + ey * ey);
}

// Cubic bezier scalar evaluation at parameter t in [0,1].
function cubicAt(p0, p1, p2, p3, t) {
    var mt = 1 - t;
    return mt * mt * mt * p0
        + 3 * mt * mt * t * p1
        + 3 * mt * t * t * p2
        + t * t * t * p3;
}

// Min distance from point to a wire's curve, by sampling the cubic bezier into
// `samples` segments and taking the min point-to-segment distance over the
// resulting polyline. Falls back to the straight A→B segment if control points
// are absent. samples defaults to 8 (gentle curve — plenty).
function wireDist(point, wire, samples) {
    var a = wire && wire.a, b = wire && wire.b;
    if (!a || !b) return Infinity;
    var c1 = wire.c1 || a, c2 = wire.c2 || b;
    if (typeof samples !== "number" || samples < 1) samples = 8;
    var min = Infinity;
    var prevx = a.x, prevy = a.y;
    for (var i = 1; i <= samples; i++) {
        var t = i / samples;
        var x = cubicAt(a.x, c1.x, c2.x, b.x, t);
        var y = cubicAt(a.y, c1.y, c2.y, b.y, t);
        var d = pointToSegmentDist(point.x, point.y, prevx, prevy, x, y);
        if (d < min) min = d;
        prevx = x; prevy = y;
    }
    return min;
}

// Return the CLOSEST wire within `threshold` px of `point`, or null. Ties go to
// the later wire (drawn on top), which matches what the user visually clicks.
function wireHitTest(point, wires, threshold) {
    if (!point || !wires || !wires.length) return null;
    var th = (typeof threshold === "number") ? threshold : 9;
    var best = null, bestD = th;
    for (var i = 0; i < wires.length; i++) {
        var d = wireDist(point, wires[i], 8);
        if (d <= bestD) { bestD = d; best = wires[i]; }
    }
    return best;
}

module.exports = {
    pointToSegmentDist: pointToSegmentDist,
    cubicAt: cubicAt,
    wireDist: wireDist,
    wireHitTest: wireHitTest
};
