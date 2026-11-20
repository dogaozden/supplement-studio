// Typst 0.14 (typst.ts web compiler, WebAssembly): load once, compile many.
// Shared by the module worker (builder/pdf/typst-worker.js, the normal path)
// and by engine.js's main-thread fallback: browsers give workers a smaller
// stack than the main thread, and Typst's PDF export of very long books
// (~1,000+ pages) can exceed a worker's stack.
//
// Everything is self-hosted: the compiler wasm ships gzipped (Cloudflare Pages
// caps a file at 25 MiB; raw is 27 MiB) and is inflated with
// DecompressionStream; fonts are the vendored EB Garamond TTFs; typst.ts's
// default remote font assets are disabled (no network at compile time).
import { createTypstCompiler } from "../assets/vendor/typst-0.14.2/ts/compiler.mjs";
import { loadFonts } from "../assets/vendor/typst-0.14.2/ts/options.init.mjs";
import * as wrapper from "../assets/vendor/typst-0.14.2/typst_ts_web_compiler.mjs";

const FONTS = [
  "EBGaramond-Regular.ttf", "EBGaramond-Italic.ttf",
  "EBGaramond-Medium.ttf", "EBGaramond-MediumItalic.ttf",
  "EBGaramond-SemiBold.ttf", "EBGaramond-SemiBoldItalic.ttf",
];

let compilerPromise = null;

async function bytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function inflateIfGzip(buf) {
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf;   // already inflated by the server
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function getCompiler(base) {
  if (!compilerPromise) {
    compilerPromise = (async () => {
      const [wasm, ...fonts] = await Promise.all([
        bytes(new URL("assets/vendor/typst-0.14.2/typst_ts_web_compiler_bg.wasm.gz", base)).then(inflateIfGzip),
        ...FONTS.map(f => bytes(new URL(`assets/fonts/typst/${f}`, base))),
      ]);
      const c = createTypstCompiler();
      await c.init({
        getWrapper: () => wrapper,
        getModule: () => wasm,
        beforeBuild: [loadFonts(fonts, { assets: false })],
      });
      return c;
    })();
    compilerPromise.catch(() => { compilerPromise = null; });
  }
  return compilerPromise;
}

function formatDiagnostics(diags) {
  return (diags || []).slice(0, 5).map(d =>
    typeof d === "string" ? d : `${d.severity || "error"}: ${d.message}${d.path ? ` (${d.path}:${d.range || ""})` : ""}`,
  ).join("\n");
}

// -> { pdf: Uint8Array, pages, provPages: {id: page}, ms }
let compiles = 0;
const RESET_EVERY = 12;   // drop Typst's incremental caches now and then (long sessions grow wasm memory)

export async function compilePdf(base, template, data) {
  const c = await getCompiler(base);
  compiles += 1;
  if (compiles % RESET_EVERY === 0) { try { await c.reset(); } catch { /* best effort */ } }
  c.addSource("/main.typ", template);
  c.mapShadow("/data.json", new TextEncoder().encode(data));
  const t0 = performance.now();
  let pages = 0;
  const provPages = {};
  const out = await c.runWithWorld({ mainFilePath: "/main.typ" }, async (world) => {
    const art = world.pdf({ diagnostics: "full" });
    try { pages = (await world.query({ selector: "<lastpage>", field: "value" }))[0] || 0; } catch { /* optional */ }
    try {
      for (const m of await world.query({ selector: "<provpage>", field: "value" })) provPages[m.l] = m.p;
    } catch { /* optional */ }
    return art;
  });
  const pdf = out?.result;
  if (!pdf || !pdf.length) throw new Error(`Typesetting failed.\n${formatDiagnostics(out?.diagnostics)}`);
  return { pdf, pages, provPages, ms: Math.round(performance.now() - t0) };
}
