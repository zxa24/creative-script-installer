---
title: The normal path
description: Export a translation package from the laid-out document, have it translated, then import it back into a copy of that document. Two scripts, in order.
---

# The normal path

On an ordinary job you run **two** scripts, in this order:

1. [`1.1 Export Translation Package`](/scripts/workflow#export-translation-package)
2. …translation happens elsewhere…
3. [`1.2 Import Translation Package`](/scripts/workflow#import-translation-package)

Everything in groups `2.x`, `3.x` and `4.x` is a tool you reach for when
something needs fixing. They are not steps.

## Step 1 — Export the package

Open the source `.indd` document in InDesign, then run
**`1.1 Export Translation Package`** from the Scripts panel.

It writes a package folder under your working folder:

```text
script_outputs/package/<doc>_translation_package_<timestamp>/
```

Inside it, among other files:

| File | What it is |
| --- | --- |
| `preview.pdf` | A visual reference of the document as it stands. |
| `segments.json` | Every translatable text segment, with its identity and context. |
| `translations_template.json` | The file the translator fills in — the empty target side. |
| `tid_map.json` | The mapping from segment ids back to positions in the document. |
| `<doc>.idml` | An IDML copy of the document, carried with the package. |
| `manifest.json` | What the package contains, for round-trip integrity. |

Hand the package to whoever does the translation.

## Step 2 — Translate

The translator fills in the target side and returns a **`translations.json`**,
either on its own or inside the package `.zip`.

::: tip Formatting is opt-in
Formatting that the translator did not mark by hand is not carried over to the
target automatically. If the translator did not mark it, the pipeline does not
apply it.
:::

## Step 3 — Import the package back

Open the **original** source `.indd` again — not a previous output — and run
**`1.2 Import Translation Package`**.

It will ask you for the `translations.json` (or the package `.zip`, which it
extracts for you). Then it:

1. Makes a copy of the source document as `<doc>.translated.indd` and opens it.
   **The source document is never written to.**
2. Pauses here so you can resolve missing fonts or missing links once.
3. Analyses the document, builds the style plan, and locates every segment.
4. Gates: if pre-flight finds a blocking problem, it stops before touching
   anything.
5. Writes the translated text and applies the style plan.
6. Runs post-flight checks (overset text, failed style application, mixed runs)
   and a repair pass.
7. Saves `<doc>.translated.indd` and leaves it open on screen.

If the import fails, it closes the working document and deletes the
half-written `.translated.indd`. It does not leave you a partial result.

::: warning Import from the original, not from an output
If the active document is already a `.translated` / `.aborted` / `.BLOCKED`
output, the import refuses to run. Importing into an output would double-apply
the pipeline and produce `<doc>.translated.translated.indd`. Open the original
`.indd` instead.
:::

## Step 4 — Look at it

Open `<doc>.translated.indd` and check the result. The report of what happened
is in `script_outputs/report/`, and the run log is in `script_outputs/log/`.

At this point you are either done, or you have a specific problem — and a
specific problem is what the tool groups are for:

| Symptom | Reach for |
| --- | --- |
| Wrong fonts for the new language | [`2.1 Apply Font Pairing`](/scripts/type-and-styles#apply-font-pairing) |
| Chinese text is composing badly | [`2.2 Apply CJK Styles`](/scripts/type-and-styles#apply-cjk-styles) |
| A run of text is the wrong weight | [`2.3 Set Selection Weight`](/scripts/type-and-styles#set-selection-weight) |
| Hundreds of near-identical paragraph styles | [`2.4 Reorganize Styles`](/scripts/type-and-styles#reorganize-styles) |
| Punctuation rendering on the wrong font | [`2.5 Repair Cluster GREP`](/scripts/type-and-styles#repair-cluster-grep) |
| Underlines look broken under CJK glyphs | [`2.6 Convert Underline to Rule`](/scripts/type-and-styles#convert-underline-to-rule) |
| Broken image links | [`3.3 Relink Missing Links`](/scripts/check-and-repair#relink-missing-links) |
| "What actually changed since last round?" | [`3.4 Highlight Translation Changes`](/scripts/check-and-repair#highlight-translation-changes) |
| Layout damage after a bulk apply | [`3.1`](/scripts/check-and-repair#snapshot-before-apply) + [`3.2`](/scripts/check-and-repair#repair-after-apply) |
| A sibling document should match this one's type | [`4.1`](/scripts/brand-presets#export-brand-preset) + [`4.2`](/scripts/brand-presets#apply-brand-preset) |

## Where the files live

See [Files and folders](/guide/folders). Short version: the working folder holds
`<doc>.indd` and `<doc>.translated.indd`, and everything else goes under
`script_outputs/`.
