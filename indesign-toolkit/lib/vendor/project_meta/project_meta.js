// project_meta.js — storage-agnostic _meta.json core (8D-ext-A0 v1).
//
// CONTRACT SCOPE (2026-06-08 缩水后): single-cooperating-writer
// best-effort. This lib provides:
//
//   ✓ Single-runtime CAS via sidecar lock + content-hash compare
//     (Node POSIX atomic rename; UXP / Browser best-effort per
//     adapter implementation)
//   ✓ Immutable invariant enforcement (created_at / project_id) for
//     cooperating writers
//   ✓ Atomic publication for the absent (init) path on Node via
//     linkSync; UXP / Browser adapters do best-effort equivalent
//   ✓ Semantic no-op detection (skip write when content unchanged)
//   ✓ Schema versioning + migrator framework
//   ✓ Corrupt-file recovery via Meta.reset() — single-writer safe
//   ✓ Bounded input (adapter enforces byte cap; core limits nesting)
//
// EXPLICITLY OUT OF SCOPE:
//
//   ✗ Concurrent edits by webui + idjs simultaneously: documented
//     as "don't edit in two tools at once"; last-writer-wins behavior
//     when ignored. UI layer responsible for showing banner warning.
//   ✗ External writers (dropbox sync / git checkout / antivirus):
//     not detected by sidecar lock. Document: "don't keep
//     _meta.json under active file-sync during editing".
//   ✗ Cross-runtime atomicity guarantees (webui writing IndexedDB
//     while idjs writes disk sidecar): documented as undefined.
//   ✗ Multi-writer reset() race: undefined; later reset wins.
//
// This contract aligns with realistic workflows (see toolkit task_plan
// Phase 8D-ext-A "2026-06-08 契约缩水决策" + DEV_LOG same day for
// scenario-frequency analysis).
//
// Public API:
//   ProjectMeta.parse(text)              → { ok, data?, errors? }
//   ProjectMeta.serialize(data)          → canonical JSON string
//   ProjectMeta.validate(data, schema?)  → { valid, errors, warnings? }
//   ProjectMeta.contentHash(data)        → 64-char hex sha256 (excluding
//                                          updated_at — used by CAS)
//   ProjectMeta.semanticDiff(a, b)       → bool
//   ProjectMeta.registerMigrator(fromV, toV, fn)
//   ProjectMeta.migrate(data, fromV, toV) → data | throws
//   ProjectMeta.inferDefaults(ctx)       → partial data + _confidence map
//   ProjectMeta.generateProjectId(name)  → "<slug>-<16-hex>"
//   ProjectMeta.now()                    → ISO 8601 UTC w/ ms
//   ProjectMeta.read(path, adapter, opts)
//                                        → { ok, data?, hash?, scenario,
//                                            schemaVersion?, readOnly?,
//                                            warnings?, errors? }
//   ProjectMeta.write(path, data, adapter, opts)
//                                        → { ok, written?, casError?,
//                                            updated_at?, errors? }
//
// write() opts.expected is REQUIRED:
//   - "absent": caller asserts file does not exist (init flow);
//               adapter MUST atomically publish (no zero-byte interim
//               visible — codex r3 P1 b)
//   - <hash>:   64-char hex sha256 (matches read().hash). adapter
//               verifies disk's CANONICAL CONTENT HASH (= sha256 of
//               canonical-JSON of parsed object, EXCLUDING updated_at;
//               see contentHash() implementation) under lock; else
//               casError. The hash is computed by helpers.contentHash
//               so the wording "raw" was misleading (codex r6 P2).
//
// "force" is explicitly REJECTED (codex r4 P2). Corrupt-file recovery
// goes through Meta.reset(path, data, adapter) — a separate API that
// backs up current disk content + writes fresh data, ignoring CAS &
// immutable checks (codex r4 new P1).
//
// Adapter contract (storage_node / storage_uxp / storage_browser must
// implement):
//
// MANDATORY bounded-read requirements (BOTH methods, codex r12 P2):
//   - Reject inputs > 64 KiB (65,536 bytes UTF-8) BEFORE decode/parse/
//     hash. Use cheap byte/size probe (e.g. stat.size, blob.size).
//   - Use STRICT UTF-8 decoding that REJECTS malformed sequences
//     (Node: new TextDecoder('utf-8', { fatal: true });
//      UXP: equivalent strict mode; Browser: TextDecoder fatal too).
//     Silent U+FFFD substitution is NOT acceptable — corrupt files must
//     surface as kind:"io-error" with explicit "malformed UTF-8" message.
//   - Reject non-regular files (directory, symlink, FIFO, device).
//     readText returns kind:"directory" / "io-error" accordingly;
//     writeAtomic returns ok:false with errors:[...] explaining target type.
//   - On Node: prefer lstatSync(+fstat-after-open inode compare) so a
//     symlink swap between checks doesn't bypass rejection.
//
//   readText(path) → Promise<{ ok, exists, text?, kind, errors? }>
//     kind: "file" | "missing" | "directory" | "permission" | "io-error"
//     Enforces all bounded-read requirements above.
//
//   writeAtomic(path, plannedData, expected, helpers) → Promise<{
//     ok, written?, noop?, casError?, updated_at?, errors? }>
//
//     plannedData: canonical object WITHOUT updated_at (adapter stamps
//       a fresh now() under lock if writing)
//     expected: "absent" | <hash> | "reset"
//     helpers: { now, contentHash, stripVolatile, parse, serialize,
//                currentSchemaVersion }
//
//     Adapter responsibilities:
//       - File locking (single-writer cooperation under contract scope)
//       - Bounded-read on existing target (size + UTF-8 strict + non-regular
//         rejection) BEFORE reading content
//       - CAS hash verification: helpers.contentHash(parse(disk)) === expected
//       - Immutable-field checks: created_at + project_id must not change
//       - Schema-version downgrade refusal
//       - Semantic no-op detection: plannedData hash === disk hash → return
//         {ok, written:false, noop:true} without writing
//       - Atomic publication on absent (no zero-byte interim visible — e.g.
//         tmpfile + linkSync on Node)
//       - Backup-before-replace, with backup failure aborting the write
//       - Return updated_at on success so caller can refresh state
//
// UMD: window.ProjectMeta | module.exports.

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        var SHA = require("./sha256_pure.js");
        var BCP = require("./bcp47_validate.js");
        var JSV = require("./json_schema_minimal.js");
        module.exports = factory(SHA, BCP, JSV);
    } else {
        root.ProjectMeta = factory(root.SHA256Pure, root.BCP47, root.JSONSchemaMinimal);
    }
}(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function (SHA, BCP, JSV) {
    "use strict";

    var CURRENT_SCHEMA_VERSION = 1;
    var MAX_NESTING_DEPTH = 8;
    // Bounded input also enforced on write/reset (codex r9 P1: direct
    // writes used to bypass both byte cap and depth limit, producing
    // metadata that subsequent read() couldn't load).
    var MAX_BYTE_SIZE_WRITE = 64 * 1024;

    var injectedSchema = null;
    function setSchema(schema) { injectedSchema = schema; }
    function getSchema(schema) {
        if (schema) return schema;
        if (injectedSchema) return injectedSchema;
        throw new Error("ProjectMeta: schema not provided");
    }

    // ── Canonical JSON ────────────────────────────────────────────────
    function canonicalStringify(obj, indent) {
        if (indent === undefined) indent = 2;
        function stringify(v, depth) {
            if (v === null) return "null";
            var t = typeof v;
            if (t === "string") return JSON.stringify(v);
            if (t === "number") {
                if (!isFinite(v)) throw new Error("non-finite number");
                return JSON.stringify(v);
            }
            if (t === "boolean") return v ? "true" : "false";
            if (Array.isArray(v)) {
                if (v.length === 0) return "[]";
                var pad = indent ? "\n" + new Array(indent * (depth + 1) + 1).join(" ") : "";
                var closePad = indent ? "\n" + new Array(indent * depth + 1).join(" ") : "";
                return "[" + pad + v.map(function (x) { return stringify(x, depth + 1); }).join("," + pad) + closePad + "]";
            }
            if (t === "object") {
                var keys = Object.keys(v).sort();
                if (keys.length === 0) return "{}";
                var pad = indent ? "\n" + new Array(indent * (depth + 1) + 1).join(" ") : "";
                var closePad = indent ? "\n" + new Array(indent * depth + 1).join(" ") : "";
                return "{" + pad + keys.map(function (k) {
                    return JSON.stringify(k) + ": " + stringify(v[k], depth + 1);
                }).join("," + pad) + closePad + "}";
            }
            throw new Error("cannot stringify type " + t);
        }
        return stringify(obj, 0);
    }
    function serialize(data) { return canonicalStringify(data) + "\n"; }

    // Portable UTF-8 byte counter (no Buffer in browser/UXP). Reuses
    // SHA._utf8Encode which we already vendor for hashing.
    function utf8ByteLength(s) {
        if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") {
            return Buffer.byteLength(s, "utf8");
        }
        if (SHA && typeof SHA._utf8Encode === "function") {
            return SHA._utf8Encode(s).length;
        }
        // Last-resort manual count
        var n = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c < 0x80) n += 1;
            else if (c < 0x800) n += 2;
            else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { n += 4; i++; }
            else n += 3;
        }
        return n;
    }

    function checkDepth(v, depth, maxDepth) {
        if (depth > maxDepth) return false;
        if (v === null || typeof v !== "object") return true;
        if (Array.isArray(v)) {
            for (var i = 0; i < v.length; i++) {
                if (!checkDepth(v[i], depth + 1, maxDepth)) return false;
            }
            return true;
        }
        for (var k in v) {
            if (Object.prototype.hasOwnProperty.call(v, k)) {
                if (!checkDepth(v[k], depth + 1, maxDepth)) return false;
            }
        }
        return true;
    }

    function parse(text) {
        if (typeof text !== "string") return { ok: false, errors: ["input not a string"] };
        try {
            var data = JSON.parse(text);
            if (data === null || typeof data !== "object" || Array.isArray(data)) {
                return { ok: false, errors: ["top-level must be a JSON object"] };
            }
            // Bounded nesting (codex r5 P1: SHA on deep input could blow stack)
            if (!checkDepth(data, 0, MAX_NESTING_DEPTH)) {
                return { ok: false, errors: ["JSON nesting exceeds limit (" + MAX_NESTING_DEPTH + ")"] };
            }
            return { ok: true, data: data };
        } catch (e) {
            return { ok: false, errors: ["JSON parse: " + e.message] };
        }
    }

    // ── Validation ────────────────────────────────────────────────────
    function validate(data, schema) {
        var sch = getSchema(schema);
        var r = JSV.validate(data, sch);
        var warnings = [];
        if (!r.valid) return { valid: false, errors: r.errors, warnings: warnings };
        // BCP 47 layer 2 — catalog warning (not reject)
        if (data.source_language) {
            var srcR = BCP.validate(data.source_language);
            if (!srcR.valid) {
                return { valid: false, errors: [{ path: "/source_language", keyword: "bcp47",
                    message: srcR.errors[0] || "BCP 47 violation" }], warnings: warnings };
            }
            if (srcR.warn) warnings.push({ path: "/source_language", warn: srcR.warnReason });
        }
        if (data.target_language) {
            var tgtR = BCP.validate(data.target_language);
            if (!tgtR.valid) {
                return { valid: false, errors: [{ path: "/target_language", keyword: "bcp47",
                    message: tgtR.errors[0] || "BCP 47 violation" }], warnings: warnings };
            }
            if (tgtR.warn) warnings.push({ path: "/target_language", warn: tgtR.warnReason });
        }
        return { valid: true, errors: [], warnings: warnings };
    }

    // Detect prototype-polluting keys ANYWHERE in the object (recursive).
    // Codex r13 P2: silently skipping these in safeOwnKeys let contentHash
    // collide. Must REJECT at API entry instead.
    function hasPollutingKey(v) {
        if (v === null || typeof v !== "object") return null;
        if (Array.isArray(v)) {
            for (var i = 0; i < v.length; i++) {
                var sub = hasPollutingKey(v[i]);
                if (sub) return sub;
            }
            return null;
        }
        var keys = Object.keys(v);
        for (var ki = 0; ki < keys.length; ki++) {
            var k = keys[ki];
            if (k === "__proto__" || k === "constructor" || k === "prototype") return k;
            var subN = hasPollutingKey(v[k]);
            if (subN) return subN;
        }
        return null;
    }

    // Safe shallow copy: skips prototype-polluting keys and only copies
    // own enumerable string properties. Codex r12 P2: `for...in` +
    // `out[k] = data[k]` treats `__proto__` as a prototype mutation,
    // not an own property, breaking contentHash + semanticDiff.
    function safeOwnKeys(data) {
        if (data === null || typeof data !== "object") return [];
        var keys = Object.keys(data); // own enumerable, skips inherited
        var out = [];
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
            out.push(k);
        }
        return out;
    }
    function safeAssign(dst, src) {
        var keys = safeOwnKeys(src);
        for (var i = 0; i < keys.length; i++) {
            Object.defineProperty(dst, keys[i], {
                value: src[keys[i]],
                enumerable: true,
                writable: true,
                configurable: true
            });
        }
        return dst;
    }

    // Apply canonical normalization to BCP 47 fields before write.
    function canonicalizeBcp47Fields(data) {
        var out = {};
        safeAssign(out, data);
        if (typeof out.source_language === "string") {
            var c = BCP.canonicalize(out.source_language);
            if (c) out.source_language = c;
        }
        if (typeof out.target_language === "string") {
            var c2 = BCP.canonicalize(out.target_language);
            if (c2) out.target_language = c2;
        }
        return out;
    }

    // ── Semantic diff & content hash ──────────────────────────────────
    function stripVolatile(data) {
        var out = {};
        var keys = safeOwnKeys(data);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k === "updated_at" || k === "_confidence") continue;
            out[k] = data[k];
        }
        return out;
    }
    function contentHash(data) { return SHA.hex(canonicalStringify(stripVolatile(data))); }
    function semanticDiff(a, b) { return contentHash(a) !== contentHash(b); }

    // ── Migration ─────────────────────────────────────────────────────
    var MIGRATORS = {};
    function registerMigrator(fromV, toV, fn) {
        MIGRATORS[fromV + "_to_" + toV] = fn;
    }
    function migrate(data, fromV, toV) {
        if (fromV === toV) return data;
        if (fromV > toV) throw new Error("cannot downgrade " + fromV + "→" + toV);
        var current = data;
        for (var v = fromV; v < toV; v++) {
            var key = v + "_to_" + (v + 1);
            if (!MIGRATORS[key]) throw new Error("missing migrator: " + key);
            current = MIGRATORS[key](current);
        }
        current.schema_version = toV;
        return current;
    }

    // ── Inference helpers ─────────────────────────────────────────────
    function slugify(s) {
        if (!s) return "project";
        return String(s).toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .substring(0, 80) || "project";
    }
    function titleCase(s) {
        if (!s) return s;
        return String(s).toLowerCase()
            .split(/[\s\-_]+/)
            .filter(function (w) { return w.length > 0; })
            .map(function (w) { return w.charAt(0).toUpperCase() + w.substring(1); })
            .join(" ");
    }
    // Strip common publishing suffix patterns from a folder/file basename
    // to recover the "project name" intent. Patterns:
    //   _zh-CN / -zh-CN / .zh-CN          (target lang suffix)
    //   _translated / -translated         (workflow marker)
    //   _v\d+ / -v\d+ / .v\d+             (version)
    //   .indd / .idml                     (extension)
    function stripSuffixes(basename) {
        var s = String(basename);
        // Strip extensions
        s = s.replace(/\.(indd|idml|txpkg|zip)$/i, "");
        // Strip version
        s = s.replace(/[._-]v\d+$/i, "");
        // Strip "translated"
        s = s.replace(/[._-]translated$/i, "");
        // Strip trailing BCP 47-ish lang code (2-3 letter + optional -REGION)
        s = s.replace(/[._-][a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/i, "");
        return s.trim();
    }

    function generateProjectId(name) {
        var slug = slugify(name);
        var hex;
        if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
            var buf = new Uint8Array(8);
            crypto.getRandomValues(buf);
            hex = "";
            for (var i = 0; i < buf.length; i++) {
                hex += (buf[i] < 16 ? "0" : "") + buf[i].toString(16);
            }
        } else if (typeof require === "function") {
            hex = require("crypto").randomBytes(8).toString("hex");
        } else {
            throw new Error("no entropy source for project_id");
        }
        return slug + "-" + hex;
    }
    function now() { return new Date().toISOString(); }

    // inferDefaults(ctx) — produce partial _meta + confidence map (SEPARATE
    // structures so the data is directly writable; codex r2 P1 #8: prior
    // single-object output had `_confidence` rejected by schema
    // additionalProperties:false).
    //
    // ctx fields (all optional; both new and old names supported for back-
    // compat — codex r2 P2 silent-field-drop):
    //   folderName / packageFolder / projectName  — basename for project_name
    //   docName    / indDName                     — fallback basename
    //   sourceLang / sourceLangHint               — known source BCP 47
    //   targetLang / targetLangHint               — known target BCP 47
    //   hasTranslationsJson                       — bool; if true → workflow
    //                                                candidate "translation"
    //   sessionContext: { lastSource, lastTarget } — webui session memory
    //
    // Returns { data: <partial-meta>, confidence: { field: "high"|"medium"|"low"|"unknown" } }
    // The `data` may be directly fed to write() once required fields are
    // filled in (e.g. by user confirming form). `confidence` informs UI.
    function inferDefaults(ctx) {
        ctx = ctx || {};
        var data = { schema_version: CURRENT_SCHEMA_VERSION };
        var confidence = {};

        // ── project_name (folder / package / doc name fallback) ──
        var nameSource = null;
        var nameConf = "low";
        var folder = ctx.folderName || ctx.packageFolder || ctx.projectName;
        var doc = ctx.docName || ctx.indDName;
        if (folder) {
            nameSource = stripSuffixes(folder);
            nameConf = "high";
        } else if (doc) {
            nameSource = stripSuffixes(doc);
            nameConf = "medium";
        }
        if (nameSource) {
            data.project_name = titleCase(nameSource);
            confidence.project_name = nameConf;
            data.project_id = generateProjectId(data.project_name);
            confidence.project_id = "high";
        }

        // ── source_language ── (explicit hint wins medium; session
        // fallback only when no explicit value — codex r3 P2)
        var srcExplicit = ctx.sourceLang || ctx.sourceLangHint;
        var srcRaw = srcExplicit;
        var srcFromSession = false;
        if ((!srcRaw) && ctx.sessionContext && ctx.sessionContext.lastSource) {
            srcRaw = ctx.sessionContext.lastSource;
            srcFromSession = true;
        }
        if (typeof srcRaw === "string" && BCP.isStructurallyValid(srcRaw)) {
            data.source_language = BCP.canonicalize(srcRaw);
            confidence.source_language = srcFromSession ? "low" : "medium";
        } else {
            confidence.source_language = "unknown";
        }

        // ── target_language ──
        var tgtExplicit = ctx.targetLang || ctx.targetLangHint;
        var tgtRaw = tgtExplicit;
        var tgtFromSession = false;
        if ((!tgtRaw) && ctx.sessionContext && ctx.sessionContext.lastTarget) {
            tgtRaw = ctx.sessionContext.lastTarget;
            tgtFromSession = true;
        }
        if (typeof tgtRaw === "string" && BCP.isStructurallyValid(tgtRaw)) {
            data.target_language = BCP.canonicalize(tgtRaw);
            confidence.target_language = tgtFromSession ? "low" : "medium";
        } else {
            confidence.target_language = "unknown";
        }

        // ── workflow_mode (canonical compare for same-lang detection) ──
        var src = data.source_language;
        var tgt = data.target_language;
        if (ctx.hasTranslationsJson === true) {
            data.workflow_mode = "translation";
            confidence.workflow_mode = "medium";
        } else if (src && tgt && src === tgt) {
            data.workflow_mode = "edit-only";
            confidence.workflow_mode = "medium";
        } else {
            confidence.workflow_mode = "unknown";
        }

        var t = now();
        data.created_at = t;
        data.updated_at = t;
        return { data: data, confidence: confidence };
    }

    // ── Read / write via adapter ──────────────────────────────────────
    //
    // read() returns hash of RAW disk content (the on-disk JSON object,
    // BEFORE migration). This way write() can pass that hash back as
    // expected: <hash> and the adapter's CAS against the actual disk
    // state will match. Codex r3 P1 a: previously read() hashed the
    // post-migration object → write() compared migrated-hash vs disk-
    // (still-pre-migration) → mismatch every time.
    function read(path, adapter, opts) {
        opts = opts || {};
        var schema = opts.schema;
        return Promise.resolve(adapter.readText(path)).then(function (rr) {
            if (!rr.ok && rr.kind === "missing") {
                return { ok: false, scenario: "missing", errors: rr.errors || ["file not found"] };
            }
            if (!rr.ok) {
                return { ok: false, scenario: rr.kind || "io-error", errors: rr.errors };
            }
            var pp = parse(rr.text);
            if (!pp.ok) {
                return { ok: false, scenario: "parse-error", errors: pp.errors };
            }
            var diskData = pp.data;
            var diskHash = contentHash(diskData); // hash of RAW disk object
            var v = diskData.schema_version;
            if (typeof v !== "number" || v < 0 || Math.floor(v) !== v) {
                return { ok: false, scenario: "schema-invalid",
                    errors: [{ path: "/schema_version", keyword: "type", message: "missing or non-integer schema_version" }] };
            }
            if (v > CURRENT_SCHEMA_VERSION) {
                return { ok: true, data: diskData, scenario: "newer-schema", readOnly: true,
                    hash: diskHash, schemaVersion: v };
            }
            var data = diskData;
            var migrated = false;
            if (v < CURRENT_SCHEMA_VERSION) {
                try { data = migrate(data, v, CURRENT_SCHEMA_VERSION); migrated = true; }
                catch (em) { return { ok: false, scenario: "migrate-error", errors: [em.message] }; }
            }
            var vr = validate(data, schema);
            if (!vr.valid) {
                return { ok: false, scenario: "validate-error",
                    errors: vr.errors, warnings: vr.warnings, data: data, hash: diskHash };
            }
            return { ok: true, data: data, scenario: migrated ? "migrated" : "normal",
                hash: diskHash, // hash of RAW disk content for CAS round-trip
                schemaVersion: CURRENT_SCHEMA_VERSION,
                migrated: migrated,
                warnings: vr.warnings };
        });
    }

    function write(path, data, adapter, opts) {
        opts = opts || {};
        var schema = opts.schema;
        if (!opts.expected) {
            return Promise.resolve({ ok: false, errors: ["opts.expected required: 'absent' | <hashString>"] });
        }
        if (opts.expected !== "absent" && typeof opts.expected !== "string") {
            return Promise.resolve({ ok: false, errors: ["opts.expected must be 'absent' or hash string"] });
        }
        // Codex r4 P2: "force" looked accepted because it falls through
        // to CAS path. Reject explicitly; force-overwrite goes through
        // Meta.reset() which is a separate API for corrupt recovery.
        if (opts.expected === "force") {
            return Promise.resolve({ ok: false, errors: ["'force' is not a valid expected value; use Meta.reset() for corrupt recovery"] });
        }
        // Hash must be 64-char hex (sha256 output shape) when not absent
        if (opts.expected !== "absent" && !/^[0-9a-f]{64}$/.test(opts.expected)) {
            return Promise.resolve({ ok: false, errors: ["expected hash must be 64-char hex (sha256)"] });
        }

        // Incoming schema sanity
        if (typeof data.schema_version !== "number" || data.schema_version > CURRENT_SCHEMA_VERSION) {
            return Promise.resolve({ ok: false,
                errors: [{ path: "/schema_version", keyword: "version",
                    message: "incoming schema_version " + data.schema_version + " > current " + CURRENT_SCHEMA_VERSION }] });
        }
        // Codex r10 P1: depth check FIRST (validate + hasPollutingKey both
        // recurse → stack overflow on 20K-deep input if not bounded).
        if (!checkDepth(data, 0, MAX_NESTING_DEPTH)) {
            return Promise.resolve({ ok: false, errors: ["incoming data nesting exceeds limit (" + MAX_NESTING_DEPTH + ")"] });
        }
        // Codex r12/r13 P2: REJECT polluting keys at API entry. Silently
        // skipping in safeOwnKeys let contentHash collide and canonicalize
        // silently strip. Explicit reject is the only correct semantics.
        // Must come AFTER depth check (this also recurses).
        var polluting = hasPollutingKey(data);
        if (polluting) {
            return Promise.resolve({ ok: false, errors: [{ path: "/" + polluting, keyword: "pollution",
                message: "key '" + polluting + "' is not permitted" }] });
        }
        // Codex r12 P2: size cap pre-check BEFORE validate. validate runs
        // Array.from on string codepoints (allocates ~12x the string for
        // multibyte) + regex.test; a 5 MiB string allocated ~60 MiB before
        // the post-validate check fired. Do a cheap raw size check first.
        var rawProbe = JSON.stringify(data);
        if (typeof rawProbe === "string" && utf8ByteLength(rawProbe) > MAX_BYTE_SIZE_WRITE * 2) {
            return Promise.resolve({ ok: false, errors: ["incoming data exceeds " + MAX_BYTE_SIZE_WRITE + " byte limit (raw probe ~" + utf8ByteLength(rawProbe) + ")"] });
        }
        // Canonicalize BCP 47 + validate
        data = canonicalizeBcp47Fields(data);
        var vr = validate(data, schema);
        if (!vr.valid) {
            return Promise.resolve({ ok: false, errors: vr.errors });
        }
        // Prepare canonical text WITHOUT bumping updated_at yet. Adapter
        // computes that under lock so no-op detection is meaningful.
        // Strip _confidence (inferDefaults helper) + updated_at (per
        // adapter contract: adapter stamps under lock so no-op detect
        // works). Codex r5 P2: prior loop only excluded _confidence.
        var prepared = {};
        var dKeys = safeOwnKeys(data);
        for (var i = 0; i < dKeys.length; i++) {
            var k = dKeys[i];
            if (k === "_confidence" || k === "updated_at") continue;
            prepared[k] = data[k];
        }
        // Codex r10 P1: measure the size the ADAPTER will actually write,
        // not the bare prepared object. Adapter adds updated_at + final
        // newline; r9's pre-adapter measurement underestimated by ~45
        // bytes, letting through inputs that read() then rejected.
        var sampleNow = now();
        var probeFull = {};
        safeAssign(probeFull, prepared);
        probeFull.updated_at = sampleNow;
        var preSize = utf8ByteLength(serialize(probeFull));
        if (preSize > MAX_BYTE_SIZE_WRITE) {
            return Promise.resolve({ ok: false, errors: ["incoming data exceeds " + MAX_BYTE_SIZE_WRITE + " byte limit when serialized (" + preSize + ")"] });
        }
        // Hand the adapter:
        //   path, expected, plannedData (without updated_at), now-ts
        // Adapter is responsible for: lock, CAS verification, immutable
        // checks (created_at / project_id), schema-version downgrade
        // protection, semantic no-op detection, and atomic publication.
        return Promise.resolve(adapter.writeAtomic(path, prepared, opts.expected, {
            now: now,
            contentHash: contentHash,
            stripVolatile: stripVolatile,
            parse: parse,
            serialize: serialize,
            currentSchemaVersion: CURRENT_SCHEMA_VERSION,
        })).then(function (wr) {
            return wr;
        });
    }

    // Meta.reset(path, data, adapter, opts) — admin recovery API.
    //
    // Codex r4 new P1: when disk content is unparseable/corrupt the
    // hash-CAS write path can't recover (no hash to pass). reset() is
    // the EXPLICIT escape hatch: under lock, ignore current disk
    // content, backup whatever is there, write `data` fresh.
    //
    // Must NOT be the default write path — caller must consciously
    // invoke reset() and accept that they may overwrite valid data.
    function reset(path, data, adapter, opts) {
        opts = opts || {};
        if (typeof data.schema_version !== "number" || data.schema_version > CURRENT_SCHEMA_VERSION) {
            return Promise.resolve({ ok: false,
                errors: [{ path: "/schema_version", keyword: "version",
                    message: "incoming schema_version " + data.schema_version + " > current " + CURRENT_SCHEMA_VERSION }] });
        }
        // Codex r10 P1: depth check FIRST (before hasPollutingKey + validate)
        if (!checkDepth(data, 0, MAX_NESTING_DEPTH)) {
            return Promise.resolve({ ok: false, errors: ["reset data nesting exceeds limit (" + MAX_NESTING_DEPTH + ")"] });
        }
        var pollR = hasPollutingKey(data);
        if (pollR) {
            return Promise.resolve({ ok: false, errors: [{ path: "/" + pollR, keyword: "pollution",
                message: "key '" + pollR + "' is not permitted" }] });
        }
        // Codex r12 P2: cheap pre-validate size cap
        var rawProbeR = JSON.stringify(data);
        if (typeof rawProbeR === "string" && utf8ByteLength(rawProbeR) > MAX_BYTE_SIZE_WRITE * 2) {
            return Promise.resolve({ ok: false, errors: ["reset data exceeds " + MAX_BYTE_SIZE_WRITE + " byte limit (raw probe ~" + utf8ByteLength(rawProbeR) + ")"] });
        }
        data = canonicalizeBcp47Fields(data);
        var vr = validate(data, opts.schema);
        if (!vr.valid) {
            return Promise.resolve({ ok: false, errors: vr.errors });
        }
        var prepared = {};
        var rKeys = safeOwnKeys(data);
        for (var ri = 0; ri < rKeys.length; ri++) {
            var rk = rKeys[ri];
            if (rk === "_confidence" || rk === "updated_at") continue;
            prepared[rk] = data[rk];
        }
        // Codex r10 P1: measure actual serialized form including updated_at
        var sampleNowR = now();
        var probeFullR = {};
        safeAssign(probeFullR, prepared);
        probeFullR.updated_at = sampleNowR;
        var resetSize = utf8ByteLength(serialize(probeFullR));
        if (resetSize > MAX_BYTE_SIZE_WRITE) {
            return Promise.resolve({ ok: false, errors: ["reset data exceeds " + MAX_BYTE_SIZE_WRITE + " byte limit (" + resetSize + ")"] });
        }
        // Use a dedicated "reset" expected token — adapter recognizes and
        // skips CAS/immutable/no-op checks but still backs up disk content.
        return Promise.resolve(adapter.writeAtomic(path, prepared, "reset", {
            now: now,
            contentHash: contentHash,
            stripVolatile: stripVolatile,
            parse: parse,
            serialize: serialize,
            currentSchemaVersion: CURRENT_SCHEMA_VERSION,
        })).then(function (wr) { return wr; });
    }

    return {
        CURRENT_SCHEMA_VERSION: CURRENT_SCHEMA_VERSION,
        setSchema: setSchema,
        parse: parse,
        serialize: serialize,
        reset: reset,
        validate: validate,
        contentHash: contentHash,
        stripVolatile: stripVolatile,
        semanticDiff: semanticDiff,
        registerMigrator: registerMigrator,
        migrate: migrate,
        inferDefaults: inferDefaults,
        generateProjectId: generateProjectId,
        slugify: slugify,
        titleCase: titleCase,
        stripSuffixes: stripSuffixes,
        canonicalizeBcp47Fields: canonicalizeBcp47Fields,
        now: now,
        read: read,
        write: write,
        _canonicalStringify: canonicalStringify,
        _stripVolatile: stripVolatile
    };
}));
