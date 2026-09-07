---
title: Group 4 — Brand Presets
description: 4.1 Export Brand Preset and 4.2 Apply Brand Preset — capture one document's tuned paragraph-style geometry and transfer it onto a sibling document without redoing the work by hand.
---

# Group 4 — Brand Presets

**These are tools, not steps.** They exist for one situation: you tuned the
paragraph styles of one document over several rounds, and a sibling document
needs to match — without you redoing it by hand.

`4.1` captures. `4.2` applies. Together they close the round trip.

## 4.1 Export Brand Preset {#export-brand-preset}

*Source: `export_brand_style_preset.idjs`*

**Captures the tuned geometry of this document's generated paragraph styles
into a brand preset file.**

It reads the active document's `_T_p_*` paragraph-style definitions and writes
their geometry into a `brand_style_preset.json`:

- point size and leading
- indents and space before / space after
- justification and composer
- fill colour
- rules above and below

**It is read-only on the document.** It builds a preset *from* the styles; it
does not modify them. The one undo-block it opens exists only to hold a
consistent points-based measurement context while reading numbers, and to give
a clean single-undo boundary — nothing is written to the document.

**Output:** `brand_style_preset.json` at the resolved brand-level path — by
default next to the saved `.indd` — plus a summary log.

## 4.2 Apply Brand Preset {#apply-brand-preset}

*Source: `apply_brand_style_preset.idjs`*

**Applies a brand preset's geometry onto a sibling document's matching
paragraph styles.**

It loads a `brand_style_preset.json` captured by
[`4.1`](#export-brand-preset) and writes its tuned geometry onto the active
document's matching `_T_p_*` paragraph-style **definitions**.

**It never touches fonts.** `appliedFont` and `fontStyle` are out of scope, by
design.

### How it finds the preset

1. An explicitly given path, used verbatim.
2. Otherwise, `<saved document folder>/*_brand_style_preset.json`.
3. If neither turns one up, it reports "no preset found" and exits cleanly —
   that is not treated as an error.

### What happens when the target document disagrees

Conflicts are resolved per dimension, not per style.

**Protected dimensions** — point size, leading, indents, keep options,
justification, composer — are reconciled three ways against what was last
applied and what the style was created with:

| The live value is… | Result |
| --- | --- |
| the same as what was last applied | safe to update — take the preset's value |
| the same as the creation baseline (never touched locally) | take the preset's value |
| different from both — someone tuned it locally | **keep the local value** and report it |

**Always-apply dimensions** — space before / space after, fill colour, rules
above and below — have no reconstructable creation baseline, so the preset's
value is always written. The colour and rule writes are then **read back and
verified**, and reported as applied-OK or applied-FAILED. A write that silently
did not land is reported, not swallowed.

### Reading the report

The headline number is **reuse rate** — matched styles divided by total. A style
counts as matched even if one of its dimensions was kept local or failed to
apply.

Three separate counts sit next to it so "reuse" is never misread as "everything
transferred":

- **applied rate**
- **kept-local count**
- **applied-failed count**

Read all four together.
