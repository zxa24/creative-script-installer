# website/ — developer notes

VitePress documentation site for `indesign-toolkit`.

This file lives inside `.vitepress/` deliberately: VitePress does not render
pages from this directory, and `gen-llms.mjs` skips it, so a note here cannot
accidentally become a published page or leak into `llms-full.txt`.

## Commands

```bash
cd website
npm install
npm run dev      # regenerate llms.* then serve with hot reload
npm run build    # regenerate llms.* then build to .vitepress/dist
npm run preview  # serve the built output
npm run llms     # regenerate public/llms.txt + public/llms-full.txt only
```

## Where things live

| Path | What |
| --- | --- |
| `.vitepress/site.mjs` | Site identity, published origin/base, and **the ordered page list**. Single source for both the sidebar and the llms surface. |
| `.vitepress/config.mjs` | VitePress config. Sidebar/nav are derived from `site.mjs`. |
| `.vitepress/theme/custom.css` | The whole theme override. The default theme is *not* forked. |
| `.vitepress/gen-llms.mjs` | Generates `public/llms.txt` + `public/llms-full.txt`. |
| `public/llms.txt`, `public/llms-full.txt` | **Generated. Never hand-edit.** |
| `zh/` | i18n stub. No translated content. Excluded from the llms surface. |

## Adding a page

1. Create the Markdown file.
2. Add it to `SECTIONS` in `.vitepress/site.mjs` with a `summary`.

Skipping step 2 is a **build failure**, not a silent omission: `gen-llms.mjs`
exits 1 when it finds a Markdown file on disk that is not in `SECTIONS`, and
`npm run build` chains the two with `&&`. That is the device that keeps
`llms-full.txt` from drifting behind the site.

## Publishing origin

`llms.txt` and `llms-full.txt` embed absolute URLs, built from
`SITE_ORIGIN` + `SITE_BASE` in `site.mjs`. The defaults are
`https://zxa24.github.io` and `/indesign-toolkit/`. **Confirm those match the
real GitHub Pages URL before publishing**, or override at build time:

```bash
SITE_ORIGIN=https://<owner>.github.io SITE_BASE=/<repo>/ npm run build
```

## Not set up here

There is no CI workflow in this directory. Deploying to GitHub Pages needs a
workflow under the repository's `.github/workflows/`, which is outside
`website/`.
