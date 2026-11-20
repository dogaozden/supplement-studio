// Small, safe post-processing of the PDF Typst writes: open with the bookmark
// panel showing (/PageMode /UseOutlines) and show the book's title, not the
// file name, in the viewer's title bar (/DisplayDocTitle). Typst (krilla)
// writes the catalog as the last plain-text object right before the xref
// table, so inserting into it only moves the xref table: startxref is
// adjusted and every object offset in the table stays valid. Anything that
// doesn't match that exact layout is returned unchanged.
const latin1 = (bytes, from, to) => {
  let s = "";
  for (let i = from; i < to; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

export function patchCatalog(bytes) {
  const tailStart = Math.max(0, bytes.length - 64);
  const tail = latin1(bytes, tailStart, bytes.length);
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!sx) return bytes;
  const xref = +sx[1];                                   // offset of "xref"
  if (latin1(bytes, xref, xref + 4) !== "xref") return bytes;
  const winStart = Math.max(0, xref - 4096);
  const win = latin1(bytes, winStart, xref);
  const cat = win.lastIndexOf("/Type /Catalog");
  const end = win.lastIndexOf("\n>>\nendobj");
  if (cat < 0 || end < cat || win.slice(cat, end).includes("/PageMode")) return bytes;
  if (win.slice(end + "\n>>\nendobj".length).trim() !== "") return bytes;   // catalog must be last
  let body = win.slice(cat, end);
  body = body.replace("/Direction /L2R", "/Direction /L2R\n    /DisplayDocTitle true");
  body += "\n  /PageMode /UseOutlines";
  const delta = body.length - (end - cat);
  const head = winStart + cat;                            // absolute start of the replaced span
  const after = latin1(bytes, winStart + end, bytes.length)
    .replace(/startxref\s+\d+\s+%%EOF\s*$/, `startxref\n${xref + delta}\n%%EOF`);
  const out = new Uint8Array(head + body.length + after.length);
  out.set(bytes.subarray(0, head), 0);
  for (let i = 0; i < body.length; i++) out[head + i] = body.charCodeAt(i);
  for (let i = 0; i < after.length; i++) out[head + body.length + i] = after.charCodeAt(i);
  return out;
}
