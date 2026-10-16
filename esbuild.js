// Build script: bundle the extension host entry + copy static assets.
// Usage: node esbuild.js [--watch]
const esbuild = require("esbuild");
const { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const watch = process.argv.includes("--watch");

/** Copy a directory of static assets into dist. */
function copyDir(from, to) {
  cpSync(from, to, { recursive: true });
}

/**
 * Bundle the panel markdown renderer (src/panel/renderer.ts — the same
 * micromark engine the official web GUI uses) and inline it into
 * dist/media/native/panel.html at the __DASH_MARKDOWN__ marker. The panel's
 * CSP is script-src 'unsafe-inline' (no external scripts), so the bundle must
 * live inside the HTML. The src panel.html keeps the placeholder.
 */
async function injectRenderer() {
  const res = await esbuild.build({
    entryPoints: ["src/panel/renderer.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["es2020", "chrome120"],
    minify: true,
    write: false,
    logLevel: "info",
  });
  const bundle = res.outputFiles[0].text;
  const panelDist = "dist/media/native/panel.html";
  let html = readFileSync("src/panel/native/panel.html", "utf8");
  if (!html.includes("__DASH_MARKDOWN__")) {
    throw new Error("panel.html is missing the __DASH_MARKDOWN__ marker");
  }
  // Function replacer — a string replacement would interpret "$&"/"$'" in the
  // bundle (micromark's URL-encode regex has "$&-;") and corrupt it.
  html = html.replace("/*__DASH_MARKDOWN__*/", () => bundle);
  writeFileSync(panelDist, html);
  // Integrity: the written file must contain the bundle byte-for-byte.
  const written = readFileSync(panelDist, "utf8");
  if (!written.includes(bundle)) {
    throw new Error("renderer injection integrity check failed: bundle corrupted in panel.html");
  }
  console.log(`[esbuild] renderer inlined into panel.html (${bundle.length} bytes)`);
}

async function main() {
  rmSync("dist", { recursive: true, force: true });
  mkdirSync("dist", { recursive: true });

  const options = {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    outfile: "dist/extension.js",
    sourcemap: true,
    logLevel: "info",
  };

  // Runtime overlay: pure-ESM loader + --import entry injected into the
  // harness process (node --import dist/overlay-register.mjs ...). Must be
  // ESM (module.register) and must NOT be bundled into the CJS extension.
  const overlayOptions = {
    entryPoints: ["src/harness/overlay/register.ts", "src/harness/overlay/loader.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outdir: "dist",
    entryNames: "overlay-[name]",
    outExtension: { ".js": ".mjs" },
    sourcemap: true,
    logLevel: "info",
  };

  // Multi-window guard: spawned in front of `dsh web` (see
  // src/harness/guard.ts) so the harness cannot outlive every dsh-vsc window.
  // Plain node, bundling keeps it dependency-free like overlay-register.mjs.
  const guardOptions = {
    entryPoints: ["src/harness/guard.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: "dist/harness-guard.mjs",
    sourcemap: true,
    logLevel: "info",
  };

  copyDir("src/panel/media", "dist/media");
  copyDir("src/panel/native", "dist/media/native");
  await injectRenderer();

  if (watch) {
    const [ctx, ctxOverlay, ctxRenderer] = await Promise.all([
      esbuild.context(options),
      esbuild.context(overlayOptions),
      // Re-inject the renderer bundle into panel.html on every rebuild.
      esbuild.context({
        entryPoints: ["src/panel/renderer.ts"],
        bundle: true,
        platform: "browser",
        format: "iife",
        target: ["es2020", "chrome120"],
        minify: true,
        write: false,
        logLevel: "info",
      }),
    ]);
    ctxRenderer.onEnd(() => injectRenderer());
    await Promise.all([ctx.watch(), ctxOverlay.watch(), ctxRenderer.watch()]);
    console.log("[esbuild] watching…");
  } else {
    await Promise.all([esbuild.build(options), esbuild.build(overlayOptions), esbuild.build(guardOptions)]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
