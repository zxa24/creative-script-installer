"use strict";

/**
 * lib/dialog_base_css.js — CSS every <dialog> starts from, so a dialog looks the
 * same however the script was launched (owner 2026-09-25/26).
 *
 * Why: launched through the bridge (plugin document), input / select / button
 * carry a UA margin of 8px as inline-blocks; in block flow that inflates each
 * label→control gap to ~43-47px. A Scripts-panel double-click does not. Measured
 * 2026-09-26 in bridge: Import Settings content 1045px inside a 640px window
 * (the bottom third unreachable — UXP does not scroll on wheel), reorganize
 * radio rows 31px each. findings `dialog-control-margins-differ-by-launch-context`.
 *
 * Put controlMarginReset(scope) FIRST in a dialog's style list. With a scope like
 * "dialog.bp-dlg" a selector is `dialog.bp-dlg input` = specificity (0,1,2), so a
 * dialog's own margin rules must be ≥ two classes (e.g. `.bp-body .opt-row input
 * { margin-right }` = (0,2,1)) to keep winning — all current ones are (checked
 * 2026-09-26). A one-class rule like `.bp-body input { margin: … }` would LOSE.
 */

function controlMarginReset(scope) {
    var s = String(scope || "dialog");
    return [s + " input", s + " select", s + " button", s + " textarea"].join(", ") + " { margin: 0; }";
}

module.exports = { controlMarginReset: controlMarginReset };
