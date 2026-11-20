# Vendored Typst web compiler

- `ts/` — `@myriaddreamin/typst.ts` 0.7.0 ESM build (Apache-2.0, see LICENSE), `.d.mts` files dropped.
- `typst_ts_web_compiler.mjs`, `wasm-pack-shim.mjs` — `@myriaddreamin/typst-ts-web-compiler` 0.7.0 wasm-bindgen wrapper.
- `typst_ts_web_compiler_bg.wasm.gz` — the compiler (Typst 0.14.2), gzip -9. Shipped compressed because
  Cloudflare Pages caps a single file at 25 MiB (raw wasm is 27 MiB); `builder/pdf/typst-worker.js` inflates it
  with `DecompressionStream`.

Upgrade: `npm install @myriaddreamin/typst.ts@X @myriaddreamin/typst-ts-web-compiler@X` in a scratch dir, copy
`dist/esm/**/*.mjs` to `ts/`, the two `pkg/*.mjs` files here, and `gzip -9` the wasm. Then match the CLI used by
`scripts/pdf/build_pdf.mjs` to the bundled Typst version and rerun the PDF tests.

The directory name carries the version on purpose: deploy/_headers caches /app/assets/vendor/* as immutable, so an upgrade must use a new directory name (and update builder/pdf/typst-core.js).
