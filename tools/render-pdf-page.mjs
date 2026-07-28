import { readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

const root = process.cwd();
const target = path.join(root, "extracted", "previews");
await mkdir(target, { recursive: true });
const pdfs = (await readdir(root)).filter((name) => name.toLowerCase().endsWith(".pdf"));

for (const [index, filename] of pdfs.entries()) {
  const document = await getDocument(path.join(root, filename)).promise;
  const page = await document.getPage(1);
  const viewport = page.getViewport({ scale: 1.7 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  await page.render({ canvasContext: context, viewport }).promise;
  const output = path.join(target, `subject-${index + 1}-page-1.png`);
  await canvas.encode("png").then(async (data) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(output, data);
  });
  console.log(output);
}
