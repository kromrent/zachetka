import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { database, databaseReady, type DbUser } from "./database.js";

try { process.loadEnvFile?.(); } catch { /* .env is optional until AI is configured */ }

const app = express();
const port = Number(process.env.PORT || 8787);
const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const run = promisify(execFile);

// Render terminates HTTPS at one reverse proxy. Trust exactly that hop so
// express-rate-limit can safely identify the real client from X-Forwarded-For.
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "40kb" }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8" }));

const sessionCookie = "zachetka_session=";
const cookieToken = (header = "") => header.split(";").map((x) => x.trim()).find((x) => x.startsWith(sessionCookie))?.slice(sessionCookie.length);
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const publicUser = (user: DbUser) => ({ id: user.id, username: user.username, displayName: user.display_name, telegram: Boolean(user.telegram_id) });
const currentUser = async (request: express.Request) => {
  const token = cookieToken(request.headers.cookie);
  if (!token) return null;
  const result = await database.query<DbUser>(`SELECT u.id, u.username, u.telegram_id, u.display_name FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>$2`, [tokenHash(token), Date.now()]);
  return result.rows[0] || null;
};
const createSession = async (response: express.Response, userId: number) => {
  const token = randomBytes(32).toString("base64url");
  await database.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", [tokenHash(token), userId, Date.now() + 30 * 86400_000]);
  response.setHeader("Set-Cookie", `zachetka_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
};
const passwordHash = (password: string, salt = randomBytes(16).toString("hex")) => `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const passwordMatches = (password: string, saved: string) => { const [salt, hash] = saved.split(":"); const candidate = scryptSync(password, salt, 64); return Boolean(hash) && timingSafeEqual(candidate, Buffer.from(hash, "hex")); };
const authRequired: express.RequestHandler = async (request, response, next) => { try { const user = await currentUser(request); if (!user) return response.status(401).json({ error: "Войди в аккаунт" }); response.locals.user = user; next(); } catch (error) { next(error); } };

app.post("/api/auth/register", async (request, response) => {
  const parsed = z.object({ username: z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_.-]+$/u), password: z.string().min(8).max(100) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Логин: от 3 символов, пароль: от 8" });
  try {
    const result = await database.query<{ id: number }>("INSERT INTO users(username,password_hash,display_name) VALUES($1,$2,$3) RETURNING id", [parsed.data.username.toLowerCase(), passwordHash(parsed.data.password), parsed.data.username]);
    const id = Number(result.rows[0].id); await database.query("INSERT INTO progress(user_id,payload) VALUES($1,$2)", [id, {}]);
    await createSession(response, id);
    response.json({ user: { id, username: parsed.data.username.toLowerCase(), displayName: parsed.data.username, telegram: false } });
  } catch { response.status(409).json({ error: "Такой логин уже занят" }); }
});

app.post("/api/auth/login", async (request, response) => {
  const parsed = z.object({ username: z.string().trim(), password: z.string() }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Заполни логин и пароль" });
  const user = (await database.query<DbUser & { password_hash: string }>("SELECT id,username,telegram_id,display_name,password_hash FROM users WHERE username=$1", [parsed.data.username.toLowerCase()])).rows[0];
  if (!user?.password_hash || !passwordMatches(parsed.data.password, user.password_hash)) return response.status(401).json({ error: "Неверный логин или пароль" });
  await createSession(response, user.id); response.json({ user: publicUser(user) });
});

app.post("/api/auth/telegram", async (request, response) => {
  const parsed = z.object({ initData: z.string().min(10).max(10_000) }).safeParse(request.body);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!parsed.success || !botToken) return response.status(503).json({ error: "Вход через Telegram пока не настроен" });
  const params = new URLSearchParams(parsed.data.initData); const receivedHash = params.get("hash") || ""; params.delete("hash"); params.delete("signature");
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest("hex");
  const authDate = Number(params.get("auth_date") || 0);
  if (receivedHash.length !== expected.length || !timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expected)) || Date.now() / 1000 - authDate > 86400) return response.status(401).json({ error: "Данные Telegram недействительны" });
  const telegram = JSON.parse(params.get("user") || "{}") as { id?: number; first_name?: string; last_name?: string; username?: string };
  if (!telegram.id) return response.status(401).json({ error: "Telegram не передал пользователя" });
  let user = (await database.query<DbUser>("SELECT id,username,telegram_id,display_name FROM users WHERE telegram_id=$1", [String(telegram.id)])).rows[0];
  const signedIn = await currentUser(request);
  if (!user && signedIn) {
    await database.query("UPDATE users SET telegram_id=$1 WHERE id=$2", [String(telegram.id), signedIn.id]);
    user = { ...signedIn, telegram_id: String(telegram.id) };
  }
  if (!user) {
    const name = [telegram.first_name, telegram.last_name].filter(Boolean).join(" ") || telegram.username || "Telegram";
    const result = await database.query<{ id: number }>("INSERT INTO users(telegram_id,display_name) VALUES($1,$2) RETURNING id", [String(telegram.id), name]);
    const id = Number(result.rows[0].id); await database.query("INSERT INTO progress(user_id,payload) VALUES($1,$2)", [id, {}]);
    user = { id, username: null, telegram_id: String(telegram.id), display_name: name };
  }
  await createSession(response, user.id); response.json({ user: publicUser(user) });
});

app.get("/api/auth/me", async (request, response) => { const user = await currentUser(request); response.json({ user: user ? publicUser(user) : null }); });
app.post("/api/auth/logout", async (request, response) => { const token = cookieToken(request.headers.cookie); if (token) await database.query("DELETE FROM sessions WHERE token_hash=$1", [tokenHash(token)]); response.setHeader("Set-Cookie", "zachetka_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"); response.json({ ok: true }); });
app.get("/api/progress", authRequired, async (_request, response) => { const row = (await database.query<{ payload: Record<string, unknown>; updated_at: string }>("SELECT payload,updated_at FROM progress WHERE user_id=$1", [response.locals.user.id])).rows[0]; response.json({ data: row?.payload || {}, updatedAt: row?.updated_at }); });
app.put("/api/progress", authRequired, async (request, response) => { const parsed = z.record(z.string(), z.unknown()).safeParse(request.body); if (!parsed.success || JSON.stringify(parsed.data).length > 1_000_000) return response.status(400).json({ error: "Некорректный прогресс" }); await database.query("INSERT INTO progress(user_id,payload,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload,updated_at=CURRENT_TIMESTAMP", [response.locals.user.id, parsed.data]); response.json({ ok: true }); });

const WrittenGrade = z.object({
  score: z.number().int().min(0).max(25),
  level: z.enum(["нет ответа", "неудовлетворительно", "с пробелами", "в целом полно", "отлично"]),
  summary: z.string(),
  strengths: z.array(z.string()).max(5),
  missing: z.array(z.string()).max(6),
  improvedAnswer: z.string()
});

const CodeGrade = z.object({
  score: z.number().int().min(0).max(50),
  level: z.enum(["нет решения", "слабое", "хорошее", "уверенное", "отличное"]),
  summary: z.string(),
  correctness: z.array(z.string()).max(6),
  issues: z.array(z.string()).max(8),
  complexity: z.string(),
  hint: z.string()
});

const GeneratedQuiz = z.object({ questions: z.array(z.object({
  text: z.string(),
  options: z.array(z.string()).length(4),
  answer: z.number().int().min(0).max(3),
  explanation: z.string()
})).length(8) });

const ReferenceAnswer = z.object({
  answer: z.string(),
  keyPoints: z.array(z.string()).min(3).max(10)
});

app.get("/api/status", (_request, response) => response.json({
  ok: true,
  ai: Boolean(client),
  java: process.env.ENABLE_LOCAL_JAVA === "true",
  model: client ? model : null
}));

app.post("/api/grade/written", authRequired, async (request, response) => {
  if (!client) return response.status(503).json({ error: "Добавь OPENAI_API_KEY в файл .env" });
  const Input = z.object({ question: z.string().min(5).max(3000), answer: z.string().min(20).max(12_000) });
  const parsed = Input.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Ответ слишком короткий или некорректный" });
  try {
    const result = await client.responses.parse({
      model,
      reasoning: { effort: "low" },
      instructions: `Ты строгий, но полезный экзаменатор магистратуры по информатике. Оценивай только содержание ответа на заданный вопрос. Шкала из официальной программы: 0-4 — нет понимания; 5-10 — три и более грубых ошибок; 11-15 — существенные пробелы или 1-2 грубые ошибки; 16-20 — в целом полный ответ с мелкими неточностями; 21-25 — полный, логичный, терминологически точный ответ. Не требуй дословности. Не выдумывай ошибок. Улучшенный ответ должен быть компактным учебным эталоном. Отвечай по-русски.`,
      input: `ВОПРОС:\n${parsed.data.question}\n\nОТВЕТ АБИТУРИЕНТА:\n${parsed.data.answer}`,
      text: { format: zodTextFormat(WrittenGrade, "written_grade") }
    });
    response.json(result.output_parsed);
  } catch (error) {
    console.error(error);
    response.status(502).json({ error: "Нейропроверка временно недоступна" });
  }
});

app.post("/api/grade/code", authRequired, async (request, response) => {
  if (!client) return response.status(503).json({ error: "Добавь OPENAI_API_KEY в файл .env" });
  const Input = z.object({ task: z.string().min(5).max(3000), code: z.string().min(20).max(30_000), compiler: z.string().max(5000).optional() });
  const parsed = Input.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Код слишком короткий или некорректный" });
  try {
    const result = await client.responses.parse({
      model,
      reasoning: { effort: "medium" },
      instructions: `Ты проверяешь практическое задание вступительного экзамена и Java-код. Шкала: 0-9 — нет решения; 10-20 — грубые ошибки/не компилируется; 21-30 — верно с 1-2 небольшими ошибками; 31-40 — верное уверенное решение, возможна неоптимальность; 41-50 — полное оптимальное решение с граничными случаями. Учитывай сообщение компилятора. Не заявляй, что код протестирован, если есть только статический анализ. Дай одну полезную подсказку, не переписывая всё решение. Отвечай по-русски.`,
      input: `ЗАДАЧА:\n${parsed.data.task}\n\nКОД:\n${parsed.data.code}\n\nКОМПИЛЯТОР:\n${parsed.data.compiler || "не запускался"}`,
      text: { format: zodTextFormat(CodeGrade, "code_grade") }
    });
    response.json(result.output_parsed);
  } catch (error) {
    console.error(error);
    response.status(502).json({ error: "Проверка кода временно недоступна" });
  }
});

app.post("/api/quiz/generate", authRequired, async (request, response) => {
  if (!client) return response.status(503).json({ error: "Добавь OPENAI_API_KEY в файл .env" });
  const Input = z.object({ subject: z.string().min(2).max(300), topics: z.array(z.string().min(5).max(2000)).length(8) });
  const parsed = Input.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Нужны ровно восемь тем" });
  try {
    const result = await client.responses.parse({
      model,
      reasoning: { effort: "low" },
      instructions: `Ты создаёшь тренировочный тест для поступления в магистратуру. Для каждой из 8 переданных экзаменационных тем создай ровно один вопрос с четырьмя короткими вариантами и ровно одним бесспорно правильным ответом. Проверяй фактическую корректность. Неправильные варианты должны быть правдоподобными, но однозначно неверными. Не спрашивай детали, которых нет в теме и которые зависят от версии продукта. Объяснение — 1-2 предложения по-русски. Сохрани порядок тем.`,
      input: `ПРЕДМЕТ: ${parsed.data.subject}\n\nТЕМЫ:\n${parsed.data.topics.map((topic, i) => `${i + 1}. ${topic}`).join("\n")}`,
      text: { format: zodTextFormat(GeneratedQuiz, "generated_quiz") }
    });
    response.json(result.output_parsed);
  } catch (error) {
    console.error(error);
    response.status(502).json({ error: "Не удалось создать новый тест" });
  }
});

app.post("/api/reference-answer", authRequired, async (request, response) => {
  if (!client) return response.status(503).json({ error: "Добавь OPENAI_API_KEY в файл .env" });
  const parsed = z.object({ question: z.string().min(5).max(3000) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Некорректный вопрос" });
  try {
    const result = await client.responses.parse({
      model,
      reasoning: { effort: "medium" },
      instructions: `Подготовь эталонный ответ на теоретический вопрос вступительного экзамена по информатике. Ответ должен соответствовать уровню 21–25 из 25: полный, логичный, терминологически точный, без воды и выдуманных фактов. Раскрой определения, связи, классификации и важные особенности, которые прямо относятся к вопросу. Добавь короткий список ключевых пунктов для самопроверки. Пиши по-русски так, чтобы ответ можно было заучивать и воспроизводить устно.`,
      input: parsed.data.question,
      text: { format: zodTextFormat(ReferenceAnswer, "reference_answer") }
    });
    response.json(result.output_parsed);
  } catch (error) {
    console.error(error);
    response.status(502).json({ error: "Не удалось подготовить эталонный ответ" });
  }
});

app.post("/api/lectures/audio", authRequired, async (request, response) => {
  if (!client) return response.status(503).json({ error: "Добавь OPENAI_API_KEY в настройки сервера" });
  const parsed = z.object({
    title: z.string().min(5).max(3000),
    mode: z.enum(["question", "section"]).default("question"),
    topics: z.array(z.string().min(3).max(2000)).max(60).optional()
  }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Некорректная тема лекции" });
  try {
    const isSection = parsed.data.mode === "section";
    const source = isSection
      ? `РАЗДЕЛ: ${parsed.data.title}\n\nВОПРОСЫ, КОТОРЫЕ НУЖНО СВЯЗНО РАСКРЫТЬ:\n${(parsed.data.topics || []).map((topic, index) => `${index + 1}. ${topic}`).join("\n")}`
      : parsed.data.title;
    const lecture = await client.responses.create({
      model,
      reasoning: { effort: "none" },
      max_output_tokens: isSection ? 1900 : 850,
      instructions: isSection
        ? `Напиши цельную расширенную учебную аудиолекцию на русском языке по разделу вступительного экзамена. Последовательно и логично раскрой каждый переданный вопрос, объединяя повторяющиеся пункты и явно проговаривая переходы между подтемами. Это должна быть полноценная лекция примерно на 8–12 минут, но текст обязан оставаться компактнее 1800 токенов для последующей озвучки. Начни сразу с содержания. Пиши связным разговорным текстом без markdown, таблиц, нумерованных списков и служебных фраз. Термины и код объясняй так, чтобы всё было понятно только на слух. Не пропускай переданные темы и не выдумывай факты. В конце повтори главные выводы.`
        : `Дай полноценный учебный ответ на один вопрос вступительного экзамена, рассчитанный на максимальную оценку 21–25 из 25. Ответ должен быть полным, логичным и терминологически точным: обязательно дай относящиеся к вопросу определения, раскрой связи, классификации, принципы работы и существенные особенности. Не требуй дословности и не добавляй сведения, не относящиеся к вопросу. Начни сразу с ответа, без приветствия и объявления темы. Удали воду, длинные вступления и повторный пересказ в конце. Пиши связным разговорным текстом на русском языке без markdown, таблиц и нумерованных списков, чтобы материал было удобно воспринимать только на слух. Термины и фрагменты кода проговаривай понятно. Обычно такой ответ должен занимать 2–4 минуты, но полнота по критериям важнее фиксированной длительности.`,
      input: source
    });
    const speech = await client.audio.speech.create({
      model: (process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts") as "gpt-4o-mini-tts",
      voice: "alloy",
      input: lecture.output_text,
      instructions: "Говори по-русски спокойно, ясно и доброжелательно, как преподаватель на лекции. Делай небольшие паузы между смысловыми частями.",
      response_format: "mp3"
    });
    const audio = Buffer.from(await speech.arrayBuffer());
    response.setHeader("Content-Type", "audio/mpeg");
    response.setHeader("Content-Length", String(audio.length));
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.send(audio);
  } catch (error) {
    console.error(error);
    response.status(502).json({ error: "Не удалось подготовить аудиолекцию" });
  }
});

app.post("/api/java/compile", authRequired, async (request, response) => {
  if (process.env.ENABLE_LOCAL_JAVA !== "true") return response.status(503).json({ error: "Локальный Java-компилятор выключен из соображений безопасности" });
  const parsed = z.object({ code: z.string().min(20).max(30_000) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Некорректный код" });
  const directory = await mkdtemp(path.join(tmpdir(), "zachetka-java-"));
  try {
    const source = path.join(directory, "Main.java");
    await writeFile(source, parsed.data.code);
    const result = await run("/usr/bin/javac", ["-encoding", "UTF-8", source], { timeout: 5000, maxBuffer: 100_000 });
    response.json({ ok: true, output: result.stderr || "Компиляция успешна" });
  } catch (error: any) {
    response.json({ ok: false, output: String(error.stderr || error.message).slice(0, 5000) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

app.use(express.static("dist"));
app.use((_request, response) => response.sendFile(path.resolve("dist/index.html")));
await databaseReady;
app.listen(port, "0.0.0.0", () => console.log(`Зачётка API: http://localhost:${port}`));
