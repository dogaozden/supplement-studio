# pdf.js (Mozilla, Apache-2.0)

pdfjs-dist 6.5.438 **legacy** `legacy/build/pdf.min.mjs` + `legacy/build/pdf.worker.min.mjs`. Used only to draw the studio's live preview of the PDF (builder/ui/preview.js); the PDF itself comes from the Typst engine.

The legacy build carries its own polyfills. The modern build calls `Uint8Array.prototype.toHex`, which browsers older than Chrome 140 / Safari 18.2 / Firefox 133 lack, and the preview then failed with "a.toHex is not a function".
