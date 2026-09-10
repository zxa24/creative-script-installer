// adapter_conformance.js — adapter-agnostic behavioral conformance suite
// (8D-ext-A1 G3 / ADD-1).
//
// THE problem A1 solves: three storage adapters (storage_node reference,
// storage_uxp, storage_browser) must be SEMANTICALLY EQUIVALENT against the
// one project_meta core lib. Equivalence-by-eyeballing is the contract-drift
// trap this feature exists to prevent. This module turns the *portable*
// behavioral contract into a parameterized battery any adapter must pass —
// equivalence becomes mechanical, not judgment.
//
// SCOPE — only the runtime-AGNOSTIC semantics live here (the ones that MUST
// be identical across Node / UXP / Browser):
//   CAS (absent / hash / stale-hash), immutable created_at + project_id,
//   semantic no-op, schema-downgrade refusal, incoming-schema-too-high,
//   64 KiB size cap, "force" rejection, updated_at strip, reset() recovery.
//
// OUT OF SCOPE (durability mechanisms — per-adapter, verified by each
// adapter's own probe/test, NOT here): backup (.bak) rotation, lock-file
// internals / stale-lock reclaim, atomic-publication transport (linkSync vs
// moveTo vs IDB tx), byte-level malformed-UTF-8 (Browser IDB can't hold
// malformed bytes; Node/UXP test it directly). Forcing those into a
// "portable" suite would either pass vacuously or fail spuriously.
//
// USAGE:
//   var Conf = require("./adapter_conformance.js");
//   var r = await Conf.runConformance({ Meta, adapter, fs, schema, label });
//   // r = { label, pass, fail, total, failures:[{name,error}] }
//
// The caller supplies an FsHelper paired with the adapter (same storage
// backend the adapter reads/writes) so the suite can set up + inspect disk
// state without going through Meta:
//
//   FsHelper = {
//     freshPath()            -> a unique target path/key (one per case)
//     plant(path, metaObj)   -> Promise: store serialize(metaObj) as the
//                               adapter would read it (setup helper)
//     plantRaw(path, text)   -> Promise: store arbitrary raw text (corrupt
//                               setup); MAY be absent if backend can't hold
//                               arbitrary text (suite skips those cases)
//     readRaw(path)          -> Promise<string|null>: raw stored text (inspect)
//     cleanup()              -> Promise: drop all test state
//   }
//
// UMD: window.AdapterConformance | module.exports.

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.AdapterConformance = factory();
}(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
    "use strict";

    function J(x) { try { return JSON.stringify(x); } catch (e) { return String(x); } }
    function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

    // Build a schema-valid meta object via inferDefaults (same path the real
    // callers use). `over` lets a case mutate specific fields.
    function baseData(Meta, over) {
        var inf = Meta.inferDefaults({
            folderName: "conf_project", sourceLang: "en", targetLang: "zh-CN", hasTranslationsJson: true
        });
        var d = inf.data;
        if (over) { for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) d[k] = over[k]; }
        return d;
    }
    // Deep-ish clone for a flat meta object (no nested arrays beyond contributors).
    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    var CASES = [
        // ── absent / init ─────────────────────────────────────────────
        { name: "absent-init creates a valid, readable file", fn: async function (c) {
            var p = c.fs.freshPath();
            var w = await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            assert(w.ok && w.written, "absent write must succeed: " + J(w));
            assert(w.updated_at, "absent write must return updated_at: " + J(w));
            var raw = await c.fs.readRaw(p);
            assert(raw, "file must exist after absent write");
            var parsed = JSON.parse(raw);
            assert(parsed.project_name === "Conf Project", "stored project_name: " + J(parsed.project_name));
            assert(typeof parsed.updated_at === "string", "stored updated_at present");
        }},
        { name: "absent when target exists -> casError", fn: async function (c) {
            var p = c.fs.freshPath();
            await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            var w2 = await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            assert(!w2.ok && w2.casError, "second absent must casError: " + J(w2));
        }},

        // ── read shape ────────────────────────────────────────────────
        { name: "read returns 64-hex hash + schemaVersion + normal scenario", fn: async function (c) {
            var p = c.fs.freshPath();
            await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            var r = await c.Meta.read(p, c.adapter);
            assert(r.ok && r.scenario === "normal", "read normal: " + J(r));
            assert(typeof r.hash === "string" && /^[0-9a-f]{64}$/.test(r.hash), "64-hex hash: " + J(r.hash));
            assert(r.schemaVersion === 1, "schemaVersion 1: " + J(r.schemaVersion));
        }},
        { name: "read missing target -> scenario missing", fn: async function (c) {
            var p = c.fs.freshPath();
            var r = await c.Meta.read(p, c.adapter);
            assert(!r.ok && r.scenario === "missing", "missing read: " + J(r));
        }},

        // ── CAS ───────────────────────────────────────────────────────
        { name: "write(hash) succeeds when hash matches disk", fn: async function (c) {
            var p = c.fs.freshPath();
            await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            var r = await c.Meta.read(p, c.adapter);
            var d = r.data; d.project_name = "Renamed";
            var w = await c.Meta.write(p, d, c.adapter, { expected: r.hash });
            assert(w.ok && w.written, "matching-hash write must succeed: " + J(w));
        }},
        { name: "write(stale hash) -> casError after intervening write", fn: async function (c) {
            var p = c.fs.freshPath();
            await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            var rA = await c.Meta.read(p, c.adapter);
            var rB = await c.Meta.read(p, c.adapter);
            var dB = rB.data; dB.project_name = "Writer B";
            var wB = await c.Meta.write(p, dB, c.adapter, { expected: rB.hash });
            assert(wB.ok, "writer B must succeed: " + J(wB));
            var dA = rA.data; dA.project_name = "Writer A";
            var wA = await c.Meta.write(p, dA, c.adapter, { expected: rA.hash });
            assert(!wA.ok && wA.casError, "stale writer A must casError: " + J(wA));
        }},
        { name: "semantic no-op skips write (no updated_at bump)", fn: async function (c) {
            var p = c.fs.freshPath();
            await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            var r1 = await c.Meta.read(p, c.adapter);
            var w = await c.Meta.write(p, r1.data, c.adapter, { expected: r1.hash });
            assert(w.ok && !w.written && w.noop, "identical content must noop: " + J(w));
            var r2 = await c.Meta.read(p, c.adapter);
            assert(r2.data.updated_at === r1.data.updated_at, "no-op must not bump updated_at");
        }},

        // ── immutable invariants ──────────────────────────────────────
        { name: "immutable created_at: change rejected under CAS", fn: async function (c) {
            var p = c.fs.freshPath();
            await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            var r = await c.Meta.read(p, c.adapter);
            var d = r.data; d.created_at = "2099-01-01T00:00:00.000Z"; d.project_name = "X";
            var w = await c.Meta.write(p, d, c.adapter, { expected: r.hash });
            assert(!w.ok && w.errors.some(function (e) { return e.keyword === "immutable" || /created_at/.test(e.message || e); }),
                "created_at change must be rejected: " + J(w));
        }},
        { name: "immutable project_id: change rejected under CAS", fn: async function (c) {
            var p = c.fs.freshPath();
            await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            var r = await c.Meta.read(p, c.adapter);
            var d = r.data; d.project_id = "fake-project-id-aaaaaaaaaaaaaaaa";
            var w = await c.Meta.write(p, d, c.adapter, { expected: r.hash });
            assert(!w.ok && w.errors.some(function (e) { return e.keyword === "immutable" || /project_id/.test(e.message || e); }),
                "project_id change must be rejected: " + J(w));
        }},

        // ── schema-version guards ─────────────────────────────────────
        { name: "newer-schema on disk -> readOnly + write refuses downgrade", fn: async function (c) {
            var p = c.fs.freshPath();
            var fake = baseData(c.Meta, { schema_version: 99 });
            await c.fs.plant(p, fake); // plant a v99 file directly
            var r = await c.Meta.read(p, c.adapter);
            assert(r.ok && r.readOnly && r.scenario === "newer-schema", "newer-schema read: " + J(r));
            var v1 = clone(r.data); v1.schema_version = 1; v1.project_name = "Downgrade";
            var w = await c.Meta.write(p, v1, c.adapter, { expected: r.hash });
            assert(!w.ok, "must refuse downgrade: " + J(w));
        }},
        { name: "incoming schema_version > current rejected at API entry", fn: async function (c) {
            var p = c.fs.freshPath();
            await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            var r = await c.Meta.read(p, c.adapter);
            var d = r.data; d.schema_version = 99;
            var w = await c.Meta.write(p, d, c.adapter, { expected: r.hash });
            assert(!w.ok && w.errors.some(function (e) { return e.keyword === "version" || /schema_version/.test(e.message || e); }),
                "incoming v99 must be rejected: " + J(w));
        }},

        // ── bounded input ─────────────────────────────────────────────
        { name: "64 KiB size cap rejects oversize incoming data", fn: async function (c) {
            var p = c.fs.freshPath();
            var bloated = baseData(c.Meta);
            bloated.created_at = "2026-06-08T00:00:00." + new Array(70000 + 1).join("1") + "Z";
            var w = await c.Meta.write(p, bloated, c.adapter, { expected: "absent" });
            assert(!w.ok && /exceeds.+limit/.test(w.errors[0].message || w.errors[0]),
                "oversize must be rejected: " + J(w));
        }},

        // ── API-entry guards ──────────────────────────────────────────
        { name: "'force' expected value explicitly rejected", fn: async function (c) {
            var p = c.fs.freshPath();
            await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            var r = await c.Meta.read(p, c.adapter);
            var w = await c.Meta.write(p, r.data, c.adapter, { expected: "force" });
            assert(!w.ok && w.errors.some(function (e) { return /force.*not.*valid|Meta\.reset/.test(e.message || e); }),
                "'force' must be rejected: " + J(w));
        }},
        { name: "updated_at is stripped + adapter-stamped (caller value ignored)", fn: async function (c) {
            var p = c.fs.freshPath();
            await c.Meta.write(p, baseData(c.Meta), c.adapter, { expected: "absent" });
            var r = await c.Meta.read(p, c.adapter);
            r.data.updated_at = "2099-01-01T00:00:00.000Z";
            r.data.project_name = "Forced rename";
            var w = await c.Meta.write(p, r.data, c.adapter, { expected: r.hash });
            assert(w.ok && w.written, "write must succeed: " + J(w));
            assert(w.updated_at !== "2099-01-01T00:00:00.000Z", "adapter must not honor caller updated_at: " + J(w.updated_at));
        }},

        // ── reset() recovery ──────────────────────────────────────────
        { name: "reset() recovers corrupt (unparseable) target", fn: async function (c) {
            if (typeof c.fs.plantRaw !== "function") return { skipped: "no plantRaw (backend can't hold raw text)" };
            var p = c.fs.freshPath();
            await c.fs.plantRaw(p, "{ this is not valid JSON ::: ###");
            var r = await c.Meta.read(p, c.adapter);
            assert(!r.ok && r.scenario === "parse-error", "corrupt read must be parse-error: " + J(r));
            var wReset = await c.Meta.reset(p, baseData(c.Meta), c.adapter);
            assert(wReset.ok && wReset.written && wReset.reset, "reset must recover: " + J(wReset));
            var r2 = await c.Meta.read(p, c.adapter);
            assert(r2.ok && r2.scenario === "normal", "post-reset read normal: " + J(r2));
        }},

        // ── oversized EXISTING target (codex-audit A1: the suite's only size
        // case hit the core Meta.write pre-check, never the adapter; these two
        // exercise the ADAPTER's existing-target size handling, which diverged
        // silently across the three implementations) ──
        { name: "oversized existing target: readText io-error + write rejected", fn: async function (c) {
            if (typeof c.fs.plantRaw !== "function") return { skipped: "no plantRaw" };
            var p = c.fs.freshPath();
            var big = '{"x":"' + new Array(70000 + 1).join("A") + '"}'; // > 64 KiB, valid JSON
            await c.fs.plantRaw(p, big);
            var rt = await c.adapter.readText(p);
            assert(!rt.ok && rt.kind === "io-error" && /exceed/i.test(J(rt.errors)),
                "oversized readText must be io-error: " + J(rt));
            // A CAS write against an oversized existing target is rejected by all
            // adapters (existing-size guard fires before / instead of the CAS).
            var w = await c.Meta.write(p, baseData(c.Meta), c.adapter,
                { expected: "0000000000000000000000000000000000000000000000000000000000000000" });
            assert(!w.ok, "write over oversized existing target must be rejected: " + J(w));
            // prove NO overwrite — !w.ok alone could pass an adapter that hashed +
            // CAS-rejected without an existing-size guard (codex re-audit B)
            var after = await c.fs.readRaw(p);
            assert(after === big, "rejected write must leave the oversized target byte-unchanged");
        }},
        { name: "reset() ABORTS on an oversized existing target (no overwrite >64 KiB)", fn: async function (c) {
            if (typeof c.fs.plantRaw !== "function") return { skipped: "no plantRaw" };
            var p = c.fs.freshPath();
            var big = '{"x":"' + new Array(70000 + 1).join("A") + '"}'; // > 64 KiB
            await c.fs.plantRaw(p, big);
            // reset recovers CORRUPT (small unparseable) files, NOT oversized ones —
            // storage_node refuses to clobber a >64 KiB existing value (test N1b).
            // All three adapters must refuse identically.
            var w = await c.Meta.reset(p, baseData(c.Meta), c.adapter);
            assert(!w.ok && /exceed/i.test(J(w.errors)),
                "reset must abort on oversized existing (parity w/ storage_node N1b): " + J(w));
            var after = await c.fs.readRaw(p);
            assert(after === big, "aborted reset must leave the oversized target byte-unchanged");
        }}
    ];

    async function runConformance(ctx) {
        assert(ctx && ctx.Meta && ctx.adapter && ctx.fs, "runConformance needs {Meta, adapter, fs}");
        if (ctx.schema && typeof ctx.Meta.setSchema === "function") ctx.Meta.setSchema(ctx.schema);
        var label = ctx.label || "adapter";
        var pass = 0, fail = 0, skip = 0, failures = [];
        for (var i = 0; i < CASES.length; i++) {
            var cse = CASES[i];
            try {
                var res = await cse.fn(ctx);
                if (res && res.skipped) { skip++; }
                else { pass++; }
            } catch (e) {
                fail++;
                failures.push({ name: cse.name, error: e.message || String(e) });
            }
        }
        if (typeof ctx.fs.cleanup === "function") { try { await ctx.fs.cleanup(); } catch (e) {} }
        return { label: label, pass: pass, fail: fail, skip: skip, total: CASES.length, failures: failures };
    }

    return { runConformance: runConformance, CASES: CASES, _baseData: baseData };
}));
