"use strict";

// Default base dir is THIS module's containing translation_mvp_uxp/ —
// derived at load time from __dirname (this file lives at lib/runtime_paths.js,
// so __dirname/.. is the project root). This works regardless of where the
// project is checked out: Program Files / NAS Z: drive / fresh git clone.
//
// Pre-2026-05-02 hard-coded "c:\Program Files\Adobe\Adobe InDesign 2026\..."
// which broke any user who didn't have InDesign installed at that exact path.
var DEFAULT_BASE_DIR = (function () {
    try {
        if (typeof __dirname === "string" && __dirname) {
            var d = __dirname.replace(/[\\\/]+$/, "");
            // Bridge-bundled / Node CommonJS: __dirname for THIS module is
            // .../translation_mvp_uxp/lib → strip trailing /lib for the root.
            // The strip is anchored to END-of-string (not lastIndexOf) so a
            // doc path like .../My_lib/translation_mvp_uxp/lib doesn't fool it.
            if (/[\\\/]lib$/.test(d)) {
                return d.replace(/[\\\/]lib$/, "");
            }
            // UXP native script-panel loader: __dirname for required modules
            // may resolve to the entry script's directory (NOT the module's
            // own directory). The entry script lives at the project root, so
            // __dirname already IS the root in that case — use it as-is.
            // Without this branch, double-clicking cjk_style_apply.idjs from
            // the InDesign Script Panel gave SOURCE_FILE_PATH = "lib/CJK.idml"
            // (no prefix) and "Failed to open source document".
            return d;
        }
    } catch (e) {}
    // Last resort: empty (forces caller to set TRANSLATION_MVP_UXP_BASE_DIR
    // or call setBaseDir() explicitly). Better to fail loud here than write
    // to a wrong path.
    return "";
})();

function safeString(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value);
}

function readEnvOverride(name) {
    try {
        if (typeof process !== "undefined" && process && process.env && process.env[name]) {
            return safeString(process.env[name]);
        }
    } catch (e1) {}
    return "";
}

function readGlobalOverride(name) {
    try {
        if (typeof globalThis !== "undefined" && globalThis && globalThis[name]) {
            return safeString(globalThis[name]);
        }
    } catch (e0) {}
    return "";
}

function readOverride(name) {
    return readGlobalOverride(name) || readEnvOverride(name);
}

function stripTrailingSlashes(pathValue) {
    return safeString(pathValue).replace(/[\\\/]+$/, "");
}

// ---------------------------------------------------------------------------
// Cross-platform path separator detection
// ---------------------------------------------------------------------------

function getSep(pathHint) {
    if (pathHint && pathHint.indexOf("\\") >= 0) { return "\\"; }
    return "/";
}

// ---------------------------------------------------------------------------
// joinPath — cross-platform (replaces joinWindowsPath)
// Uses separator from basePath; falls back to /
// ---------------------------------------------------------------------------

function joinPath(basePath, leafName) {
    var base = stripTrailingSlashes(basePath);
    var leaf = safeString(leafName).replace(/^[\\\/]+/, "");
    if (!base) { return leaf; }
    if (!leaf) { return base; }
    return base + getSep(base) + leaf;
}

// Legacy alias — existing callers use this name (33 call sites).
// Behavior now cross-platform (uses separator from basePath, not hardcoded \).
var joinWindowsPath = joinPath;

// ---------------------------------------------------------------------------
// Directory overrides (readOverride: globalThis > process.env > default)
// ---------------------------------------------------------------------------

function getBaseDir() {
    var override = readOverride("TRANSLATION_MVP_UXP_BASE_DIR");
    return stripTrailingSlashes(override || DEFAULT_BASE_DIR);
}

function setBaseDir(dir) {
    DEFAULT_BASE_DIR = stripTrailingSlashes(safeString(dir));
}

// UXP-panel-double-click fallback: when neither __dirname nor an env / global
// override is available (Adobe's native idjs loader doesn't expose __dirname
// for required modules), derive the base dir from `app.activeScript`. This is
// async (the property returns a Promise in UXP), so entry scripts must `await
// RuntimePaths.bootstrap()` at the top of their main() before any code that
// reads paths. Idempotent and safe to call repeatedly — does nothing once
// DEFAULT_BASE_DIR is non-empty.
// Diagnostic — captured so callers can dump to log when bootstrap fails.
var __BOOTSTRAP_DIAG = { tried: false, hasApp: null, hasActiveScript: null,
    awaitedType: null, awaitedKeys: null, pathRaw: null, pathFinal: null,
    err: null };
function getBootstrapDiag() { return __BOOTSTRAP_DIAG; }

async function bootstrap() {
    __BOOTSTRAP_DIAG.tried = true;
    if (DEFAULT_BASE_DIR) return DEFAULT_BASE_DIR;
    // In UXP idjs, `app` is NOT a global — it's only a local variable in
    // each module that does `require("indesign").app`. So we can't rely on
    // `typeof app !== "undefined"` here; require it explicitly.
    var idApp = null;
    try { idApp = require("indesign").app; } catch (eReq) {
        __BOOTSTRAP_DIAG.err = "require_indesign_failed: " + (eReq && eReq.message);
    }
    try {
        __BOOTSTRAP_DIAG.hasApp = !!idApp;
        if (idApp && idApp.activeScript) {
            __BOOTSTRAP_DIAG.hasActiveScript = true;
            var script = await idApp.activeScript;
            __BOOTSTRAP_DIAG.awaitedType = typeof script;
            if (script) {
                try {
                    var ks = [];
                    for (var k in script) ks.push(k);
                    __BOOTSTRAP_DIAG.awaitedKeys = ks.join(",");
                } catch (eK) {}
                // Try several plausible accessors used across UXP / ExtendScript
                // File-like values.
                var p = "";
                try {
                    p = script.nativePath || script.fsName || script.fullName
                        || script.absoluteURI || script.path || String(script);
                    p = String(p || "");
                } catch (eP) { __BOOTSTRAP_DIAG.err = "read_path:" + eP.message; }
                __BOOTSTRAP_DIAG.pathRaw = p;
                if (p) {
                    // Strip URL prefix ("file:///C:/...") if present.
                    p = p.replace(/^file:\/+/, "");
                    // Strip the script's filename → containing folder.
                    var dir = p.replace(/[\\\/][^\\\/]+$/, "");
                    __BOOTSTRAP_DIAG.pathFinal = dir;
                    if (dir) DEFAULT_BASE_DIR = stripTrailingSlashes(dir);
                }
            }
        } else if (idApp) {
            __BOOTSTRAP_DIAG.hasActiveScript = false;
        }
    } catch (e) {
        __BOOTSTRAP_DIAG.err = String(e && (e.message || e));
    }
    return DEFAULT_BASE_DIR;
}

function getIllustratorBaseDir() {
    return joinPath(getBaseDir(), "illustrator");
}

function getTempDir() {
    var override = readOverride("TRANSLATION_MVP_TEMP_DIR");
    if (override) { return stripTrailingSlashes(override); }
    // Platform default: detect from homedir
    try {
        var os = require("os");
        var home = os.homedir();
        if (home && home.indexOf("/") === 0) {
            // macOS/Linux
            return "/tmp";
        }
    } catch (e) {}
    // Windows fallback
    var home2 = "";
    try { home2 = require("os").homedir(); } catch (e) {}
    return home2 ? home2 + "\\AppData\\Local\\Temp" : "C:\\Windows\\Temp";
}

function getScratchDir() {
    // Repo-root scratch dir for ALL runtime outputs (snapshots / logs /
    // playwright reports / etc.). Single .gitignore entry `.scratch/` covers
    // everything. Override via TRANSLATION_MVP_SCRATCH_DIR for CI / custom.
    var override = readOverride("TRANSLATION_MVP_SCRATCH_DIR");
    if (override) { return stripTrailingSlashes(override); }
    return joinPath(getBaseDir(), ".scratch");
}

function getDataDir() {
    var override = readOverride("TRANSLATION_MVP_DATA_DIR");
    if (override) { return stripTrailingSlashes(override); }
    // Default: <baseDir>/.scratch/temp_data — under the unified .scratch/ tree.
    // Old default was <baseDir>/temp_data (pre-2026-05-02); env override keeps
    // backward compat for any caller that set TRANSLATION_MVP_DATA_DIR.
    return joinPath(getScratchDir(), "temp_data");
}

function getLogDir() {
    // Default: <baseDir>/.scratch/log — for snapshot_before_apply,
    // repair_after_apply etc. that previously wrote directly under
    // <baseDir>/log. env override TRANSLATION_MVP_LOG_DIR retained.
    var override = readOverride("TRANSLATION_MVP_LOG_DIR");
    if (override) { return stripTrailingSlashes(override); }
    return joinPath(getScratchDir(), "log");
}

function getDesktopDir() {
    var override = readOverride("TRANSLATION_MVP_DESKTOP_DIR");
    if (override) { return stripTrailingSlashes(override); }
    try {
        var os = require("os");
        var home = os.homedir();
        return home + (home.indexOf("/") === 0 ? "/Desktop" : "\\Desktop");
    } catch (e) {}
    return "";
}

module.exports = {
    DEFAULT_BASE_DIR: DEFAULT_BASE_DIR,
    getBaseDir: getBaseDir,
    setBaseDir: setBaseDir,
    bootstrap: bootstrap,
    getBootstrapDiag: getBootstrapDiag,
    getScratchDir: getScratchDir,
    getDataDir: getDataDir,
    getLogDir: getLogDir,
    getIllustratorBaseDir: getIllustratorBaseDir,
    getTempDir: getTempDir,
    getDesktopDir: getDesktopDir,
    getSep: getSep,
    joinPath: joinPath,
    joinWindowsPath: joinWindowsPath  // legacy alias
};
