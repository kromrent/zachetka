import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const root = process.cwd();
const output = path.join(root, "extracted");
await mkdir(output, { recursive: true });

const pdfs = (await readdir(root)).filter((name) => name.toLowerCase().endsWith(".pdf"));
for (const filename of pdfs) {
  const document = await getDocument(path.join(root, filename)).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
    pages.push(`[[PAGE:${pageNumber}]]\n${text}`);
  }
  const target = path.join(output, `${path.parse(filename).name}.txt`);
  await writeFile(target, `[[PAGES:${document.numPages}]]\n${pages.join("\n\n")}`);
  console.log(`${filename}: ${document.numPages} pages`);
}
