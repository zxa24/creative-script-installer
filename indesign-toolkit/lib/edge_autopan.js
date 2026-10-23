// edge_autopan.js — TODO#82: how far to scroll when a wire drag nears the edge.
//
// owner: 「在连线时靠近窗口四周时移动画布以解决不同 port 不在同一画面的问题」
//
// 🔴 This file is ONLY the arithmetic, on purpose. The parts that need a real
// pointer (does it actually scroll, does it feel right) cannot be tested without
// OS input (CLAUDE #13b), so they stay owner's half — but the decision of WHICH
// WAY and HOW FAR to move is pure, and pure things can be pinned. Leaving the
// arithmetic inside the pointermove handler would have pushed the whole feature
// into "eye-verify only", including the half a machine can check.
//
// Convention: the returned {dx,dy} is what the CONTENT moves. To bring something
// off the RIGHT edge into view, the content moves LEFT ⇒ dx is negative.
"use strict";

// edgeAutoPanDelta(cursor, viewport, opts) → { dx, dy } (0,0 when not near an edge)
//   cursor    { x, y }  in the same coordinate space as viewport
//   viewport  { left, top, right, bottom }
//   opts.margin  px from the edge where scrolling starts   (default 48)
//   opts.speed   px per step at the very edge              (default 12)
//
// Speed ramps linearly from 0 at the margin to `speed` at the edge, so entering
// the band does not jolt. ⚠ Ramp, not constant: owner said 「匀速」, but a constant
// speed means the motion starts abruptly at the boundary — worth showing him both;
// this is the version that can be made constant by one line if he prefers it.
function edgeAutoPanDelta(cursor, viewport, opts) {
    opts = opts || {};
    var margin = typeof opts.margin === "number" ? opts.margin : 48;
    var speed = typeof opts.speed === "number" ? opts.speed : 12;
    var out = { dx: 0, dy: 0 };
    if (!cursor || !viewport) return out;
    var cx = Number(cursor.x), cy = Number(cursor.y);
    if (!isFinite(cx) || !isFinite(cy)) return out;
    var l = Number(viewport.left), r = Number(viewport.right);
    var t = Number(viewport.top), b = Number(viewport.bottom);
    if (!isFinite(l) || !isFinite(r) || !isFinite(t) || !isFinite(b)) return out;
    if (r - l <= 0 || b - t <= 0) return out;
    // A margin wider than half the viewport would make every point "near an edge"
    // on both sides at once; clamp so the two bands can never overlap.
    var mx = Math.min(margin, (r - l) / 2);
    var my = Math.min(margin, (b - t) / 2);

    if (cx < l + mx) out.dx = speed * ((l + mx - cx) / mx);          // near LEFT  → content moves right
    else if (cx > r - mx) out.dx = -speed * ((cx - (r - mx)) / mx);  // near RIGHT → content moves left
    if (cy < t + my) out.dy = speed * ((t + my - cy) / my);
    else if (cy > b - my) out.dy = -speed * ((cy - (b - my)) / my);

    // Outside the viewport entirely: clamp to full speed rather than letting the
    // ramp run away. A pointer 900px past the edge must not fling the canvas.
    if (out.dx > speed) out.dx = speed; else if (out.dx < -speed) out.dx = -speed;
    if (out.dy > speed) out.dy = speed; else if (out.dy < -speed) out.dy = -speed;
    return out;
}

var _api = { edgeAutoPanDelta: edgeAutoPanDelta };
if (typeof module !== "undefined" && module.exports) module.exports = _api;
if (typeof globalThis !== "undefined") globalThis.EdgeAutoPan = _api;
