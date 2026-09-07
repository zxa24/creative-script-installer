// path_resolver.js — _meta.json location resolver (8D-ext-A1).
//
// CANONICAL SoT: app-folio/vendor/path_resolver.js. A frozen copy is
// vendored into indesign-toolkit (IT) lib/vendor/ and kept byte-identical
// via tools/sync_frozen.js + tools/check_schema_drift.js (sha256 gate run
// at the paired-merge gate). DO NOT edit the IT copy by hand — edit here,
// re-run sync, commit both. See spec §6.3 + HANDOFF G1/G2.
//
// PURPOSE
// -------
// Given runtime context + an injected DirProbe, decide WHICH `_meta.json`
// path a tool should read/write, classify the storage scenario (spec §3.2),
// and surface dual-copy conflicts. This is pure decision logic over a
// directory listing — the ONLY platform-specific part is "does this file
// exist?" / "is this dir writeable?", which is injected as DirProbe so the
// 4-scenario rules + dual-copy precedence live in exactly ONE place across
// UXP / browser / Node (the contract-drift surface this feature exists to
// shrink — spec §1.3). The resolver body contains zero `fs` / `lfs` /
// `fetch` references by design.
//
// DIRPROBE CONTRACT (injected; each runtime supplies one) — FROZEN with
// the resolver, audited as a cross-repo contract face (HANDOFF G4 / ADD-2):
//
//   DirProbe = {
//     // Does a regular file exist at this exact path? MAY be implemented
//     // by calling the storage adapter's readText(path) and testing
//     // (kind !== "missing"); a lighter existence check is also fine.
//     // MUST resolve false (not throw) for a missing path.
//     exists(path) -> Promise<boolean>,
//
//     // Can the tool create/replace files in this directory? Best-effort;
//     // false on permission error or non-existent dir. MUST NOT throw.
//     writeable(dir) -> Promise<boolean>
//   }
//
// resolve(ctx, probe) -> Promise<status>
//
//   ctx = {
//     runtime:      "uxp" | "browser" | "node",
//     packageDir?:  string,   // package folder root (script_outputs/package/<pkg>/)
//     sourceDir?:   string,   // directory holding source.indd (standalone edit)
//     docSaved?:    boolean,  // UXP: is the InDesign doc saved? (default true)
//     webReadOnly?: boolean,  // browser: static-host / no local write? (default false)
//     projectId?:   string,   // browser web-only: IndexedDB key hint (may be absent for draft)
//     sep?:         string    // path separator override (else inferred from dirs)
//   }
//
// status (typed; UI warnings owned by A3) —
//   {
//     scenario:  "package-root" | "source-adjacent" | "unsaved"
//              | "web-only" | "missing",
//     path:      string | null,   // resolved _meta.json path (null for unsaved/web-only)
//     exists:    boolean,         // is _meta.json present at `path`
//     writeable: boolean,         // can the tool persist to the resolved location
//     conflicts?: [{ type:"dual-copy", paths:[pkg, src], precedence:"package-root" }],
//     alternate?: string,         // the non-chosen path under dual-copy
//     key?:       string,         // web-only: IndexedDB key (projectId) if known
//     warnings?:  string[]
//   }
//
// INVARIANTS (spec §3.2)
//   - One project per directory: at most one `_meta.json` per dir; multiple
//     .indd in the same dir share one `_meta` (same project, many docs).
//   - Dual-copy precedence: package-root `_meta.json` AND source-adjacent
//     `_meta.json` both present -> PACKAGE-ROOT WINS. status carries the
//     loser as `alternate` + a conflicts[] entry + a "duplicate _meta
//     detected" warning so the UI can offer a merge.
//   - `unsaved` / `web-only` never carry a disk path: those tiers stage in
//     memory (unsavedDocState) / IndexedDB (key=projectId) respectively and
//     are NOT schema fields.
//
// UMD: window.PathResolver | module.exports.

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.PathResolver = factory();
    }
}(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
    "use strict";

    var META_BASENAME = "_meta.json";

    // Infer the path separator from an existing dir string (Windows "\" vs
    // POSIX "/"); fall back to "/". Kept local so the resolver never imports
    // a platform path module.
    function inferSep(ctx) {
        if (ctx.sep) return ctx.sep;
        var dirs = [ctx.packageDir, ctx.sourceDir];
        for (var i = 0; i < dirs.length; i++) {
            var d = dirs[i];
            if (typeof d === "string") {
                if (d.indexOf("\\") >= 0 && d.indexOf("/") < 0) return "\\";
                if (d.indexOf("/") >= 0) return "/";
            }
        }
        return "/";
    }

    function joinMeta(dir, sep) {
        var trimmed = String(dir).replace(/[\\/]+$/, "");
        return trimmed + sep + META_BASENAME;
    }

    // Normalize a probe result to a strict boolean even if a runtime probe
    // resolves to a truthy/falsy non-bool. Probe errors are caller's job to
    // avoid (contract says MUST NOT throw), but we defend anyway: a thrown
    // exists() is treated as "unknown -> false" rather than crashing resolve.
    function safeProbe(promiseLike) {
        return Promise.resolve(promiseLike).then(
            function (v) { return !!v; },
            function () { return false; }
        );
    }

    function resolve(ctx, probe) {
        ctx = ctx || {};
        if (!probe || typeof probe.exists !== "function" || typeof probe.writeable !== "function") {
            return Promise.reject(new Error("path_resolver: probe must provide exists(path) + writeable(dir)"));
        }
        var runtime = ctx.runtime || "node";
        var sep = inferSep(ctx);

        // ── Tier-only scenarios that short-circuit before any disk probe ──
        // browser static-host: no local write authority; stage in IndexedDB.
        if (runtime === "browser" && ctx.webReadOnly === true) {
            return Promise.resolve({
                scenario: "web-only",
                path: null,
                exists: false,
                writeable: false,
                key: ctx.projectId || undefined,
                warnings: ctx.projectId ? undefined : ["web-only draft: project_id not yet assigned (rekey on confirm)"]
            });
        }
        // UXP unsaved doc: cannot anchor a path until the doc is saved.
        // Resolver returns the blocking state; caller stages filled fields in
        // unsavedDocState (in-memory) and re-resolves after save.
        if (runtime === "uxp" && ctx.docSaved === false && !ctx.packageDir) {
            return Promise.resolve({
                scenario: "unsaved",
                path: null,
                exists: false,
                writeable: false,
                warnings: ["InDesign document is unsaved; save the document before persisting _meta.json"]
            });
        }

        var pkgMeta = ctx.packageDir ? joinMeta(ctx.packageDir, sep) : null;
        var srcMeta = ctx.sourceDir ? joinMeta(ctx.sourceDir, sep) : null;

        // Treat identical package/source dirs as a single candidate (no
        // dual-copy when both point at the same place).
        if (pkgMeta && srcMeta && pkgMeta === srcMeta) {
            srcMeta = null;
        }

        if (!pkgMeta && !srcMeta) {
            return Promise.resolve({
                scenario: "missing",
                path: null,
                exists: false,
                writeable: false,
                warnings: ["no directory context (packageDir / sourceDir) supplied to resolver"]
            });
        }

        // Probe existence of every candidate concurrently.
        return Promise.all([
            pkgMeta ? safeProbe(probe.exists(pkgMeta)) : Promise.resolve(false),
            srcMeta ? safeProbe(probe.exists(srcMeta)) : Promise.resolve(false)
        ]).then(function (ex) {
            var pkgExists = ex[0];
            var srcExists = ex[1];

            // ── Dual-copy: both present -> package-root wins ──
            if (pkgMeta && srcMeta && pkgExists && srcExists) {
                return safeProbe(probe.writeable(ctx.packageDir)).then(function (w) {
                    return {
                        scenario: "package-root",
                        path: pkgMeta,
                        exists: true,
                        writeable: w,
                        alternate: srcMeta,
                        conflicts: [{ type: "dual-copy", paths: [pkgMeta, srcMeta], precedence: "package-root" }],
                        warnings: ["duplicate _meta detected (package-root + source-adjacent); package-root wins"]
                    };
                });
            }

            // ── Single existing copy ──
            if (pkgExists) {
                return safeProbe(probe.writeable(ctx.packageDir)).then(function (w) {
                    return { scenario: "package-root", path: pkgMeta, exists: true, writeable: w };
                });
            }
            if (srcExists) {
                return safeProbe(probe.writeable(ctx.sourceDir)).then(function (w) {
                    return { scenario: "source-adjacent", path: srcMeta, exists: true, writeable: w };
                });
            }

            // ── None exist: this is an init/create target ──
            // Creation preference: package-root if a packageDir was given,
            // else source-adjacent. scenario names the *intended* location;
            // exists:false signals init-write (Meta.write expected:"absent").
            if (pkgMeta) {
                return safeProbe(probe.writeable(ctx.packageDir)).then(function (w) {
                    return { scenario: "package-root", path: pkgMeta, exists: false, writeable: w };
                });
            }
            return safeProbe(probe.writeable(ctx.sourceDir)).then(function (w) {
                return { scenario: "source-adjacent", path: srcMeta, exists: false, writeable: w };
            });
        });
    }

    return {
        META_BASENAME: META_BASENAME,
        resolve: resolve,
        _inferSep: inferSep,
        _joinMeta: joinMeta
    };
}));
