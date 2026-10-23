---
title: Before you export
description: Get an InDesign document ready for Folio before you export its text. 3.3 Relink Missing Links finds missing images in the document's folder; 2.4 Reorganize Styles replaces hundreds of near-identical paragraph styles with a small, clean set.
---

# Before you export

Stage 1 of [Translate a layout: for designers](/folio/designer). Before you run
**1.1 Export Translation Package**, the layout should be final, InDesign should
show no [missing fonts](/folio/export-import#missing-fonts) or missing links,
and the document should be saved. Use this page when a document is not quite
ready: InDesign reports [missing links](#relink-missing-links), or the
paragraph styles have grown into [a tangle](#reorganize-styles).

These are free InDesign scripts from Creative Script Kit. You install them
once with one line ([Install](/guide/install)) and find them in the Scripts
panel under **User → indesign-toolkit-stable**
([where to find the scripts](/guide/install#where-to-find-the-scripts)).

Both tools are optional. If the document is already clean, go straight to
[2 Export and import](/folio/export-import).

## 3.3 Relink Missing Links {#relink-missing-links}

Use it when InDesign reports missing links and the files are somewhere inside
the document's folder.

1. Save the document, so the script knows which folder to search.
2. In the Scripts panel, double-click **3.3 Relink Missing Links**. It asks
   nothing.
3. Read the window that lists what it relinked and
   [what it could not find](#still-missing), then click **Close**.

It relinks each missing link to a file with the same name in the document's
folder or any folder inside it, and leaves the rest alone. All the relinks are
one undo step.

## 2.4 Reorganize Styles {#reorganize-styles}

Use it when a document has sprawled into hundreds of near-identical paragraph
styles, or into paragraphs held together by local overrides.

1. Open the document and double-click **2.4 Reorganize Styles**.
2. In its one dialog, choose how paragraphs should be grouped, then click
   **OK**. **Cancel** stops without changing anything.
3. Wait; there are no more questions. Read the summary and its warnings, then
   look through the document.

It groups paragraphs that look the same and gives each group one new paragraph
style, in the open document. It keeps the fonts as they are. The whole run is
one undo step, so if you do not like the result, undo it before you save.

## Next

[2 Export and import](/folio/export-import): export the text with
**1.1 Export Translation Package** and send it to the translator.

## Common problems

::: details Some links are still missing after 3.3
<a id="still-missing"></a>

It only relinks when it finds a file with exactly the same name (capital
letters do not matter) in the document's folder or a folder inside it. It never
guesses. Move the file into the document's folder, or relink it by hand in the
Links panel.
:::

::: details 3.3 picked a different copy of the file
When the same file name is in several places, the copy closest to the
document's folder wins. That keeps it from taking a copy buried deep inside a
packaged folder.
:::

::: details A link shows as modified, not missing
A file that still exists but has changed needs **Update Link** in the Links
panel. 3.3 only handles links whose file is missing.
:::

::: details 3.3 says it stopped searching
It stops after 4000 folders or 12 levels deep, and says so rather than quietly
searching less. Keep the linked files closer to the document.
:::

::: details Technical details
<a id="relink-missing-links-details"></a>**3.3 Relink Missing Links**
(source `relink_missing_from_doc_folder.idjs`)

For every link in the document whose status is *missing*, the script searches
**the document's folder and all of its subfolders** for a file of the same name,
matched case-insensitively. When it finds one, it relinks and updates. When it
does not, it **reports the link and leaves it alone**; it never guesses.

- **Shallow wins.** If the same filename appears in several places, the one
  closest to the document folder is taken first. That keeps it from grabbing a
  deep copy out of a packaged folder.
- **Missing only.** It handles broken links. A link whose file still exists but
  has been modified is an *Update*, not a relink, and is out of scope.
- **Dry run available.** It can report what it *would* relink without touching
  anything (automation option `dryRun`; a double-click always relinks).
- **Undo:** all relinks are wrapped in one undo step.
- **Search limits:** it stops at 4000 directories or 12 levels deep, and says so
  when it hits a limit rather than silently truncating the search.
- **It writes** its report to `<document folder>/script_outputs/log/`, falling
  back to the document folder itself if that is unavailable.

<a id="reorganize-styles-details"></a>**2.4 Reorganize Styles**
(source `reorganize_styles_inplace.idjs`)

What it does:

- Walks every paragraph in every story and captures its *effective* visual
  properties: font, size, colour, leading, indents, spacing, keep options,
  bullets, and so on.
- Clusters paragraphs by that visual fingerprint.
- Creates one `_T_p_<hash>` paragraph style per cluster with those properties
  baked in. N paragraphs typically collapse to a much smaller number of styles.
- Reassigns each paragraph to its cluster's canonical style.

What it does **not** do:

- No source file picker: it reads the active document.
- No output file: it modifies the active document in place.
- **No CJK (Chinese, Japanese and Korean) font policy.** It preserves the original Latin font family. This is
  pure style consolidation, not translation preparation.

The dialog's grouping options: dimensions, colour tolerance, auto-merge preset,
safety, soft-break handling, edit mode.

**Undo:** the whole reorganization (pre-flight, apply and repair) is one undo
step.

**It also writes:** a progress log next to the document
(`<doc>_reorganize_progress_<timestamp>.log`) for post-mortem triage, and, when
safety is on, a before-snapshot used by the post-flight repair.
:::
