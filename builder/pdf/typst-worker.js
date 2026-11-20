// Module worker: runs the Typst compiler off the main thread (see typst-core.js).
import { compilePdf, getCompiler } from "./typst-core.js";

self.onmessage = async (event) => {
  const { id, type, base, template, data } = event.data || {};
  try {
    if (type === "warm") {
      await getCompiler(base);
      self.postMessage({ id, ok: true });
      return;
    }
    self.postMessage({ id, stage: "Loading the typesetter…" });
    await getCompiler(base);
    self.postMessage({ id, stage: "Typesetting…" });
    const res = await compilePdf(base, template, data);
    self.postMessage({ id, ok: true, ...res }, [res.pdf.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
