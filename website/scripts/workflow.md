---
title: Group 1 — Workflow
description: 1.1 Export Translation Package and 1.2 Import Translation Package — the two scripts that make up the normal translation path.
---

# Group 1 — Workflow

**This is the normal path.** On an ordinary job you run `1.1`, send the package
out, and run `1.2` when it comes back. Nothing else is a step.

For the walkthrough with the translator's half in it, see
[The normal path](/guide/workflow).

## 1.1 Export Translation Package {#export-translation-package}

*Source: `export_translation_package.idjs`*

**Exports an offline translation package from the open document.**

Run it with the source `.indd` open. It writes a package folder at:

```text
<working folder>/script_outputs/package/<doc>_translation_package_<timestamp>/
```

The package carries, among other files:

| File | What it is |
| --- | --- |
| `preview.pdf` | A PDF of the document as it currently stands, as visual reference for the translator. |
| `segments.json` | Every translatable segment with its identity and context. |
| `translations_template.json` | The empty target side — this is what gets filled in. |
| `tid_map.json` | The segment-id ↔ document-position map used to put the text back. |
| `<doc>.idml` | An IDML copy of the document, carried with the package. |
| `manifest.json` | What the package contains, for round-trip integrity. |
| `emphasis_report.json` | What emphasis (bold / italic / colour) was found in the source. |
| `import_state.json` | State the matching import run reads back. |

### Notes

- The export opens a dialog first, so you can confirm what is being exported
  and where.
- The log lands in `script_outputs/log/`.

## 1.2 Import Translation Package {#import-translation-package}

*Source: `import_integrated.idjs`*

**Reads a translated package back into a fresh copy of the source document.**

Give it either the returned `translations.json` or the package `.zip` — a `.zip`
is extracted for you and the `translations.json` inside is found automatically.

What the run does, in order:

1. **Copy, don't edit.** The source document is opened read-only and copied to
   `<doc>.translated.indd`, which is then opened as the working document. The
   source is never written to.
2. **One interactive moment.** The working document opens visibly so you can
   resolve missing fonts or missing links once, up front. After that the
   pipeline runs without prompting.
3. **Pre-flight snapshot** of the layout state.
4. **Analyse** — build the style plan, locate every segment, run pre-flight.
5. **Gate** — if pre-flight finds a blocking problem, the run stops here.
6. **Commit** — write the translated text and apply the style plan.
7. **Post-flight** — check for overset text, failed style application, and
   mixed runs.
8. **Repair** — run the repair pass over what post-flight found.
9. **Save** — the working document is saved in place and stays open on screen.

If the run fails, the working document is closed and the half-written
`.translated.indd` is deleted. There is no partial output.

### Why it is a single open document

The whole pipeline happens in one open document with one font-resolution state.
An earlier design saved, closed and reopened between phases; that caused
recomposition to diverge, because fonts were substituted silently during the
pipeline and then confirmed by the user after reopening — frames overflowed
after the reopen even though the repair pass had logged no overflows.

### Guardrails

- **It refuses to import into a previous output.** If the active document is
  named `.translated`, `.aborted` or `.BLOCKED` and carries no import-state
  label, the run aborts. Importing into an output would double-apply the
  pipeline and cascade into `<doc>.translated.translated.indd`. Open the
  original `.indd` instead.
- **Post-flight results do not rename the file.** Post-flight statistics stay
  in `report.json` and never change the filename suffix. Post-flight passing
  does not certify the result as acceptable, and post-flight failing does not
  mean the result is unusable — both need a human to look.
- If the previous run's `.translated.indd` is still open in InDesign, the new
  output gets a timestamp appended to its name rather than fighting over the
  file.

### Notes

- Reports land in `script_outputs/report/`, logs in `script_outputs/log/`.
- See [Files and folders](/guide/folders) for what happens to the previous
  output.
