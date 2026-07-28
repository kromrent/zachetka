import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

try { process.loadEnvFile(); } catch { /* handled below */ }
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing in .env");

const root = process.cwd();
const sourceDir = path.join(root, "extracted", "ocr");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const SourceBank = z.object({
  title: z.string(),
  sections: z.array(z.object({ title: z.string(), questions: z.array(z.string()) })),
  tasks: z.array(z.string())
});

const filenames = (await readdir(sourceDir)).filter((name) => name.endsWith(".md"));
const banks = [];
for (const filename of filenames) {
  const raw = await readFile(path.join(sourceDir, filename), "utf8");
  console.log(`Structuring ${filename}...`);
  const response = await client.responses.parse({
    model,
    reasoning: { effort: "low" },
    instructions: `Ты восстанавливаешь точный перечень вопросов из OCR официальной программы вступительного экзамена на русском языке.

Правила:
1. Сохрани абсолютно каждый нумерованный экзаменационный вопрос до раздела «Регламент» или «Список рекомендуемой литературы».
2. Сохрани структуру тематических разделов. Если разделов нет, создай один раздел «Все темы».
3. Пункты после заголовка «Задачи» помести в tasks, а не в sections.
4. Исправь только очевидные OCR-искажения терминов и латиницы по контексту: Java, JavaScript, SQL, JDBC, XML, HTML, JSP, Servlet, ORM, Hibernate, OSI, SCADA, Modbus, HART, RS-232, RS-485, LD, FBD, ST и подобные.
5. Удали номера пунктов, номера страниц, подписи, регламент, критерии, литературу и OCR-мусор.
6. Не придумывай вопросы, не объединяй разные нумерованные пункты и не дроби один пункт на несколько.
7. Не добавляй ответы и пояснения.`,
    input: raw,
    text: { format: zodTextFormat(SourceBank, "question_bank") }
  });
  if (!response.output_parsed) throw new Error(`No structured output for ${filename}`);
  const count = response.output_parsed.sections.reduce((sum, section) => sum + section.questions.length, 0);
  const id = count <= 35 ? "management" : response.output_parsed.sections.some((section) => section.title === "Компьютерная графика") ? "java" : "systems";
  const title = id === "management" ? "Организация цифрового производства" : id === "systems" ? "Интеллектуальные системы управления цифровой инфраструктурой предприятия" : "Разработка высоконагруженных приложений и Java-инженерия";
  banks.push({ id, title, source: filename.replace(/\.md$/, ".pdf"), sections: response.output_parsed.sections, tasks: response.output_parsed.tasks });
}

banks.sort((a, b) => ["management", "systems", "java"].indexOf(a.id) - ["management", "systems", "java"].indexOf(b.id));
await writeFile(path.join(root, "src", "question-bank.json"), JSON.stringify(banks, null, 2));
for (const bank of banks) {
  const questionCount = bank.sections.reduce((sum, section) => sum + section.questions.length, 0);
  console.log(`${bank.id}: ${bank.sections.length} sections, ${questionCount} questions, ${bank.tasks.length} tasks`);
}
