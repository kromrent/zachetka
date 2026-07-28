import { readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";

const root = process.cwd();
const target = path.join(root, "extracted", "ocr");
const langPath = path.join(root, "node_modules", "@tesseract.js-data", "rus", "4.0.0_best_int");
await mkdir(target, { recursive: true });

const worker = await createWorker("rus", 1, {
  langPath,
  gzip: true,
  logger: (event) => event.status === "recognizing text" && process.stdout.write(`\rOCR ${Math.round(event.progress * 100)}%`)
});
const pdfs = (await readdir(root)).filter((name) => name.toLowerCase().endsWith(".pdf"));

for (const [fileIndex, filename] of pdfs.entries()) {
  const document = await getDocument(path.join(root, filename)).promise;
  const pages = [];
  console.log(`\n[${fileIndex + 1}/${pdfs.length}] ${filename} — ${document.numPages} pages`);
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;
    const { data } = await worker.recognize(await canvas.encode("png"));
    pages.push(`## Страница ${pageNumber}\n\n${data.text.trim()}`);
    console.log(`\n  page ${pageNumber}/${document.numPages}`);
  }
  await writeFile(path.join(target, `${path.parse(filename).name}.md`), `# ${filename}\n\n${pages.join("\n\n")}`);
}
await worker.terminate();
