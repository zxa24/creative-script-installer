"use strict";

/**
 * lib/dialog_label_delegate.js
 *
 * UXP HTML `<dialog>` workaround: click events on `<label for="id">` text
 * do NOT propagate to the associated input the way browsers do. Probe
 * results (2026-05-28):
 *   - `<label for="cb">Text</label>` + `<input id="cb">`: clicking "Text"
 *     does not toggle the checkbox.
 *   - `<label><input>Text</label>` (nested): works as expected.
 *
 * For dialogs already authored with the separate-label pattern, attaching
 * this delegated handler at the dialog level fixes the UX without changing
 * any HTML markup.
 *
 * Public API:
 *   wireLabelClicks(dialogElement)
 *     → adds a single bubble-phase click listener that intercepts label[for]
 *       clicks and forwards them to the associated input. Idempotent within
 *       a given dialog instance (call once per dialog after innerHTML is set).
 *
 * Implementation notes:
 *   - Checkbox: UXP `input.click()` correctly toggles `.checked` AND fires
 *     change listeners. Just forward.
 *   - Radio: UXP `input.click()` fires the click event but does NOT toggle
 *     `.checked` on its own — we have to manage state manually (uncheck
 *     siblings in the same `name` group, set `.checked = true`, then fire
 *     click + change events so listeners react).
 *   - State updates from `input.click()` settle asynchronously in UXP
 *     (synchronous reads right after a click() may show the old value).
 *     This matters for self-driven test code, not for real user flows —
 *     the next user interaction (e.g. clicking OK) happens after settle.
 */

function wireLabelClicks(dialogEl) {
    if (!dialogEl || typeof dialogEl.addEventListener !== "function") return;
    dialogEl.addEventListener("click", function (e) {
        // Direct input clicks: let native behavior handle it.
        if (e.target && e.target.tagName === "INPUT") return;
        var label = (e.target && e.target.closest) ? e.target.closest("label") : null;
        if (!label) return;
        var forId = label.getAttribute("for");
        if (!forId) return;
        // Use the dialog scope, not document — multiple dialogs may share id
        // namespaces during transitions.
        var input = dialogEl.querySelector("#" + forId);
        if (!input) return;
        var t = input.type;
        if (t === "checkbox") {
            // UXP toggles + fires change for synthetic clicks on checkboxes.
            input.click();
        } else if (t === "radio") {
            if (input.checked) return; // no-op when already selected
            var name = input.name;
            if (name) {
                var siblings = dialogEl.querySelectorAll('input[type="radio"][name="' + name + '"]');
                for (var i = 0; i < siblings.length; i++) {
                    if (siblings[i] !== input) siblings[i].checked = false;
                }
            }
            input.checked = true;
            input.click();
            // Also fire `change` explicitly — some UXP runtimes don't fire
            // change on synthetic radio click(). Best-effort; safe to ignore
            // if the listener doesn't pick up dispatched events.
            try { input.dispatchEvent(new Event("change", { bubbles: true })); } catch (eE) {}
        }
    });
}

module.exports = {
    wireLabelClicks: wireLabelClicks
};
