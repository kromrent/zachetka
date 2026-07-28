import { readFile, writeFile } from "node:fs/promises";

const filename = new URL("../src/question-bank.json", import.meta.url);
const banks = JSON.parse(await readFile(filename, "utf8"));
for (const bank of banks) {
  const count = bank.sections.reduce((sum, section) => sum + section.questions.length, 0);
  bank.id = count <= 35 ? "management" : bank.sections.some((section) => section.title === "Компьютерная графика") ? "java" : "systems";
  bank.title = bank.id === "management" ? "Организация цифрового производства" : bank.id === "systems" ? "Интеллектуальные системы управления цифровой инфраструктурой предприятия" : "Разработка высоконагруженных приложений и Java-инженерия";
  if (bank.id === "management" && bank.sections.length === 1 && bank.sections[0].questions.length === 30) {
    const questions = bank.sections[0].questions;
    bank.sections = [
      { title: "Промышленная автоматизация", questions: questions.slice(0, 15) },
      { title: "Организация и оптимизация производства", questions: questions.slice(15) }
    ];
  }
}
banks.sort((a, b) => ["management", "systems", "java"].indexOf(a.id) - ["management", "systems", "java"].indexOf(b.id));
await writeFile(filename, JSON.stringify(banks, null, 2));
