import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import ffmpegPath from "ffmpeg-static";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
const quizModel = process.env.OPENAI_QUIZ_MODEL || model;
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const run = promisify(execFile);
const lectureAudioJobs = new Map<string, Promise<Buffer>>();
const lectureCacheMaxBytes = Number(process.env.LECTURE_CACHE_MAX_BYTES || 800 * 1024 * 1024);
const lectureAudioBitrate = process.env.LECTURE_AUDIO_BITRATE || "48k";
const lectureTranscribeModel = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const lectureSpeechChunkMaxCharacters = 4000;
const configuredLectureSpeechSpeed = Number(process.env.LECTURE_SPEECH_SPEED || 1.2);
const lectureSpeechSpeed = Number.isFinite(configuredLectureSpeechSpeed) ? Math.min(4, Math.max(0.25, configuredLectureSpeechSpeed)) : 1.2;
const questionQuizCacheVersion = "question-mini-quiz-2026-07-31-v1";

const QuestionBank = z.array(z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  title: z.string().trim().min(2).max(500),
  sections: z.array(z.object({
    title: z.string().trim().min(2).max(500),
    questions: z.array(z.string().trim().min(5).max(5000)).min(1)
  })).min(1)
})).min(1);

// Mini quizzes only accept canonical question keys. Loading the committed bank
// on the server keeps clients from submitting arbitrary prompts and bounds the
// number of possible paid cache misses to the real exam questions.
const questionBanks = QuestionBank.parse(JSON.parse(
  await readFile(new URL("../src/question-bank.json", import.meta.url), "utf8")
));
if (new Set(questionBanks.map((bank) => bank.id)).size !== questionBanks.length) {
  throw new Error("question-bank.json contains duplicate subject ids");
}

const splitLectureTextForSpeech = (text: string, maxCharacters = lectureSpeechChunkMaxCharacters) => {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxCharacters) {
    const window = remaining.slice(0, maxCharacters + 1);
    const sentenceAt = Math.max(
      window.lastIndexOf(". ", maxCharacters),
      window.lastIndexOf("! ", maxCharacters),
      window.lastIndexOf("? ", maxCharacters)
    );
    const candidates = [
      { at: window.lastIndexOf("\n\n", maxCharacters), separatorLength: 2 },
      { at: sentenceAt, separatorLength: 1 },
      { at: window.lastIndexOf("\n", maxCharacters), separatorLength: 1 },
      { at: window.lastIndexOf(" ", maxCharacters), separatorLength: 0 }
    ];
    const boundary = candidates.find((candidate) => candidate.at >= maxCharacters * 0.55);
    const end = boundary ? boundary.at + boundary.separatorLength : maxCharacters;
    const chunk = remaining.slice(0, end).trim();
    if (!chunk) break;
    chunks.push(chunk);
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
};

const compressLectureAudio = async (sources: Buffer | Buffer[]) => {
  const parts = Array.isArray(sources) ? sources : [sources];
  const fallback = Buffer.concat(parts);
  if (!ffmpegPath) return fallback;
  const directory = await mkdtemp(path.join(tmpdir(), "zachetka-audio-"));
  const input = path.join(directory, "source.mp3");
  const manifest = path.join(directory, "parts.txt");
  const output = path.join(directory, "compressed.mp3");
  try {
    let inputArguments: string[];
    if (parts.length === 1) {
      await writeFile(input, parts[0]);
      inputArguments = ["-i", input];
    } else {
      const filenames = parts.map((_, index) => path.join(directory, `part-${String(index).padStart(3, "0")}.mp3`));
      await Promise.all(filenames.map((filename, index) => writeFile(filename, parts[index])));
      await writeFile(manifest, filenames.map((filename) => `file '${filename}'`).join("\n"));
      inputArguments = ["-f", "concat", "-safe", "0", "-i", manifest];
    }
    await run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", ...inputArguments,
      "-map_metadata", "-1", "-ac", "1", "-ar", "24000",
      "-codec:a", "libmp3lame", "-b:a", lectureAudioBitrate, "-y", output
    ], { timeout: 120_000, maxBuffer: 100_000 });
    const compressed = await readFile(output);
    return parts.length > 1 || compressed.length < fallback.length ? compressed : fallback;
  } catch (error) {
    console.error("Не удалось сжать аудиолекцию, сохраняю исходный MP3", error);
    return fallback;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

// Render terminates HTTPS at one reverse proxy. Trust exactly that hop so
// express-rate-limit can safely identify the real client from X-Forwarded-For.
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
// Progress includes saved reference answers and lecture follow-ups, so it can
// legitimately grow beyond a few dozen kilobytes.
app.use(express.json({ limit: "1mb" }));
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
app.put("/api/progress", authRequired, async (request, response) => {
  const parsed = z.record(z.string(), z.unknown()).safeParse(request.body);
  if (!parsed.success || JSON.stringify(parsed.data).length > 1_000_000) return response.status(400).json({ error: "Некорректный прогресс" });
  const connection = await database.connect();
  try {
    await connection.query("BEGIN");
    // The user row always exists, even if an older account somehow has no
    // progress row yet. Locking it serializes all progress writes for that
    // account before the upsert below and prevents cross-device lost updates.
    await connection.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [response.locals.user.id]);
    const current = (await connection.query<{ payload: Record<string, unknown> }>("SELECT payload FROM progress WHERE user_id=$1 FOR UPDATE", [response.locals.user.id])).rows[0]?.payload || {};
    const merged = { ...current, ...parsed.data };
    // Follow-ups are append-only. Merge them by id so a second open device with
    // an older snapshot cannot erase an answer saved from the phone.
    const readFollowUps = (value: unknown) => {
      try {
        const result = typeof value === "string" ? JSON.parse(value) : value;
        return Array.isArray(result) ? result.filter((item) => item && typeof item === "object" && typeof item.id === "string") : [];
      } catch { return []; }
    };
    const followUps = [...readFollowUps(current["exam-lecture-followups"]), ...readFollowUps(parsed.data["exam-lecture-followups"])];
    if (followUps.length) {
      const unique = Array.from(new Map(followUps.map((item) => [item.id, item])).values()).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      merged["exam-lecture-followups"] = JSON.stringify(unique);
    }

    // Notes are editable, so merge each question independently and keep the
    // newest timestamp. Empty records are intentional deletion tombstones.
    const readQuestionNotes = (value: unknown) => {
      try {
        const result = typeof value === "string" ? JSON.parse(value) : value;
        if (!result || typeof result !== "object" || Array.isArray(result)) return {} as Record<string, Record<string, unknown>>;
        return Object.fromEntries(Object.entries(result).filter(([, note]) => note && typeof note === "object" && !Array.isArray(note) && typeof (note as { text?: unknown }).text === "string")) as Record<string, Record<string, unknown>>;
      } catch { return {} as Record<string, Record<string, unknown>>; }
    };
    const questionNotes = readQuestionNotes(current["exam-question-notes"]);
    for (const [questionKey, note] of Object.entries(readQuestionNotes(parsed.data["exam-question-notes"]))) {
      const savedAt = Date.parse(String(questionNotes[questionKey]?.updatedAt || "")) || 0;
      const candidateAt = Date.parse(String(note.updatedAt || "")) || 0;
      if (!questionNotes[questionKey] || candidateAt >= savedAt) questionNotes[questionKey] = note;
    }
    if (Object.keys(questionNotes).length) merged["exam-question-notes"] = JSON.stringify(questionNotes);

    // Mini-test results are personal, but the best score must never move
    // backwards when two devices finish attempts from different snapshots.
    const readQuestionQuizProgress = (value: unknown) => {
      try {
        const result = typeof value === "string" ? JSON.parse(value) : value;
        if (!result || typeof result !== "object" || Array.isArray(result)) return {} as Record<string, Record<string, unknown>>;
        return Object.fromEntries(Object.entries(result).filter(([questionKey, item]) => {
          if (!/^[a-z0-9_-]+:\d+-\d+$/.test(questionKey) || !item || typeof item !== "object" || Array.isArray(item)) return false;
          const progress = item as Record<string, unknown>;
          return typeof progress.bestScore === "number"
            && typeof progress.lastScore === "number"
            && typeof progress.attempts === "number"
            && typeof progress.updatedAt === "string";
        })) as Record<string, Record<string, unknown>>;
      } catch { return {} as Record<string, Record<string, unknown>>; }
    };
    const questionQuizProgress = readQuestionQuizProgress(current["exam-question-quiz-progress"]);
    for (const [questionKey, candidate] of Object.entries(readQuestionQuizProgress(parsed.data["exam-question-quiz-progress"]))) {
      const saved = questionQuizProgress[questionKey];
      const savedAt = Date.parse(String(saved?.updatedAt || "")) || 0;
      const candidateAt = Date.parse(String(candidate.updatedAt || "")) || 0;
      const newest = !saved || candidateAt >= savedAt ? candidate : saved;
      const score = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(8, Math.floor(value))) : 0;
      const bestScore = Math.max(score(saved?.bestScore), score(candidate.bestScore), score(newest.lastScore));
      const attempts = Math.max(
        typeof saved?.attempts === "number" && Number.isFinite(saved.attempts) ? Math.max(0, Math.floor(saved.attempts)) : 0,
        typeof candidate.attempts === "number" && Number.isFinite(candidate.attempts) ? Math.max(0, Math.floor(candidate.attempts)) : 0
      );
      questionQuizProgress[questionKey] = {
        bestScore,
        lastScore: score(newest.lastScore),
        attempts,
        mastered: Boolean(saved?.mastered) || Boolean(candidate.mastered) || bestScore >= 6,
        updatedAt: String(newest.updatedAt || "")
      };
    }
    if (Object.keys(questionQuizProgress).length) merged["exam-question-quiz-progress"] = JSON.stringify(questionQuizProgress);

    // A course may be read on several devices. Keep the newest position, but
    // union completed chapters so an older snapshot cannot mark them unread.
    const readTextLectureProgress = (value: unknown) => {
      try {
        const result = typeof value === "string" ? JSON.parse(value) : value;
        if (!result || typeof result !== "object" || Array.isArray(result)) return {} as Record<string, { currentChapterId: string; completedChapterIds: string[]; updatedAt: string }>;
        return Object.fromEntries(Object.entries(result).flatMap(([courseId, item]) => {
          if (!courseId || courseId.length > 160 || !item || typeof item !== "object" || Array.isArray(item)) return [];
          const progress = item as Record<string, unknown>;
          if (typeof progress.currentChapterId !== "string" || typeof progress.updatedAt !== "string") return [];
          const completedChapterIds = Array.isArray(progress.completedChapterIds)
            ? [...new Set(progress.completedChapterIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 160))].slice(0, 500)
            : [];
          return [[courseId, { currentChapterId: progress.currentChapterId.slice(0, 160), completedChapterIds, updatedAt: progress.updatedAt }]];
        })) as Record<string, { currentChapterId: string; completedChapterIds: string[]; updatedAt: string }>;
      } catch { return {} as Record<string, { currentChapterId: string; completedChapterIds: string[]; updatedAt: string }>; }
    };
    const textLectureProgress = readTextLectureProgress(current["exam-text-lecture-progress"]);
    for (const [courseId, candidate] of Object.entries(readTextLectureProgress(parsed.data["exam-text-lecture-progress"]))) {
      const saved = textLectureProgress[courseId];
      if (!saved) {
        textLectureProgress[courseId] = candidate;
        continue;
      }
      const savedAt = Date.parse(saved.updatedAt) || 0;
      const candidateAt = Date.parse(candidate.updatedAt) || 0;
      const newest = candidateAt >= savedAt ? candidate : saved;
      textLectureProgress[courseId] = {
        currentChapterId: newest.currentChapterId,
        completedChapterIds: [...new Set([...saved.completedChapterIds, ...candidate.completedChapterIds])].slice(0, 500),
        updatedAt: newest.updatedAt
      };
    }
    if (Object.keys(textLectureProgress).length) merged["exam-text-lecture-progress"] = JSON.stringify(textLectureProgress);

    await connection.query("INSERT INTO progress(user_id,payload,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload,updated_at=CURRENT_TIMESTAMP", [response.locals.user.id, merged]);
    await connection.query("COMMIT");
    response.json({ ok: true });
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
});

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

const QuestionQuiz = z.object({ questions: z.array(z.object({
  text: z.string().min(10).max(500),
  options: z.array(z.string().min(1).max(300)).length(4),
  answer: z.number().int().min(0).max(3),
  explanation: z.string().min(5).max(800)
})).length(8) });
type QuestionQuizPayload = z.infer<typeof QuestionQuiz>;
type CanonicalQuestion = {
  questionKey: string;
  subjectTitle: string;
  sectionTitle: string;
  question: string;
};

const QuestionQuizInput = z.object({
  questionKey: z.string().trim().min(5).max(100)
}).strict();

const resolveCanonicalQuestion = (questionKey: string): CanonicalQuestion | null => {
  const match = /^([a-z0-9_-]+):(\d+)-(\d+)$/.exec(questionKey);
  if (!match) return null;
  const bank = questionBanks.find((item) => item.id === match[1]);
  const sectionIndex = Number(match[2]);
  const questionIndex = Number(match[3]);
  if (!bank || !Number.isSafeInteger(sectionIndex) || !Number.isSafeInteger(questionIndex)) return null;
  if (questionKey !== `${bank.id}:${sectionIndex}-${questionIndex}`) return null;
  const section = bank.sections[sectionIndex];
  const question = section?.questions[questionIndex];
  if (!section || !question) return null;
  return { questionKey, subjectTitle: bank.title, sectionTitle: section.title, question };
};

const quizComparisonKey = (value: string) => value.trim().replace(/\s+/gu, " ").normalize("NFKC").toLocaleLowerCase("ru-RU");
const validateQuestionQuiz = (value: unknown): QuestionQuizPayload | null => {
  const parsed = QuestionQuiz.safeParse(value);
  if (!parsed.success) return null;
  const questions = parsed.data.questions.map((item) => ({
    ...item,
    text: item.text.trim(),
    options: item.options.map((option) => option.trim()),
    explanation: item.explanation.trim()
  }));
  if (questions.some((item) => item.text.length < 10 || item.explanation.length < 5 || item.options.some((option) => !option))) return null;
  if (new Set(questions.map((item) => quizComparisonKey(item.text))).size !== questions.length) return null;
  if (questions.some((item) => new Set(item.options.map(quizComparisonKey)).size !== item.options.length)) return null;
  return { questions };
};

const questionQuizCacheKeyFor = (input: CanonicalQuestion) => createHash("sha256")
  .update(`${questionQuizCacheVersion}\n${JSON.stringify(input)}`)
  .digest("hex");

const questionQuizJobs = new Map<string, Promise<QuestionQuizPayload>>();

const readQuestionQuiz = async (cacheKey: string): Promise<QuestionQuizPayload | null> => {
  const row = (await database.query<{ payload: unknown }>(
    "SELECT payload FROM question_quiz WHERE cache_key=$1",
    [cacheKey]
  )).rows[0];
  if (!row) return null;
  const payload = validateQuestionQuiz(row.payload);
  if (!payload) {
    console.error(`Некорректная запись question_quiz для cache_key=${cacheKey}`);
    return null;
  }
  await database.query("UPDATE question_quiz SET last_accessed_at=CURRENT_TIMESTAMP WHERE cache_key=$1", [cacheKey]);
  return payload;
};

const saveQuestionQuiz = async (cacheKey: string, questionKey: string, payload: QuestionQuizPayload): Promise<QuestionQuizPayload> => {
  const row = (await database.query<{ payload: unknown }>(
    `INSERT INTO question_quiz(cache_key,question_key,payload)
     VALUES($1,$2,$3)
     ON CONFLICT(cache_key) DO UPDATE SET last_accessed_at=CURRENT_TIMESTAMP
     RETURNING payload`,
    [cacheKey, questionKey, payload]
  )).rows[0];
  const persisted = validateQuestionQuiz(row?.payload);
  if (persisted) return persisted;
  // A malformed row should never be created by this version, but repairing it
  // avoids paying for the same valid generation again after every request.
  await database.query(
    "UPDATE question_quiz SET question_key=$2,payload=$3,last_accessed_at=CURRENT_TIMESTAMP WHERE cache_key=$1",
    [cacheKey, questionKey, payload]
  );
  return payload;
};

const generateQuestionQuiz = async (input: CanonicalQuestion, cacheKey: string, ai: OpenAI): Promise<QuestionQuizPayload> => {
  const result = await ai.responses.parse({
    model: quizModel,
    max_output_tokens: 2500,
    instructions: `Создай мини-тест ровно из 8 неповторяющихся вопросов по одному теоретическому вопросу вступительного экзамена. Каждый вопрос теста должен проверять отдельный существенный аспект исходной темы: определения, связи или классификации, принципы работы, применение и типичные заблуждения. Не выходи за границы исходной формулировки и не спрашивай сведения, зависящие от версии продукта. Для каждого вопроса дай ровно четыре коротких правдоподобных варианта и только один бесспорно правильный ответ. Не повторяй варианты внутри одного вопроса. Распределяй позиции правильных ответов, не ставь их всегда под одним номером. Объяснение правильного ответа — 1–2 точных предложения по-русски.`,
    input: `ПРЕДМЕТ: ${input.subjectTitle}\nРАЗДЕЛ: ${input.sectionTitle}\nИСХОДНЫЙ ЭКЗАМЕНАЦИОННЫЙ ВОПРОС:\n${input.question}`,
    text: { format: zodTextFormat(QuestionQuiz, "question_quiz") }
  });
  const payload = validateQuestionQuiz(result.output_parsed);
  if (!payload) throw Object.assign(new Error("OpenAI вернул повторяющийся или некорректный мини-тест"), { code: "invalid_question_quiz" });
  return saveQuestionQuiz(cacheKey, input.questionKey, payload);
};

const ReferenceAnswer = z.object({
  answer: z.string(),
  keyPoints: z.array(z.string()).min(3).max(10)
});

const LectureInput = z.object({
  title: z.string().min(5).max(3000),
  mode: z.enum(["question", "section"]).default("question"),
  topics: z.array(z.string().min(3).max(2000)).max(60).optional()
});
type LectureInputData = z.infer<typeof LectureInput>;
type LectureTextSource = "generated" | "transcribed";
type LectureTextRecord = { text: string; source: LectureTextSource };
const lectureTextJobs = new Map<string, Promise<LectureTextRecord>>();

// This seed and JSON serialization intentionally match the existing audio
// cache key exactly. Changing either would orphan all already generated MP3s.
const lectureCacheKeyFor = (input: LectureInputData) => createHash("sha256")
  .update(`lecture-audio-2026-07-29-v3\n${JSON.stringify(input)}`)
  .digest("hex");

const readLectureText = async (cacheKey: string): Promise<LectureTextRecord | null> => {
  const row = (await database.query<{ text: string; source: string }>(
    "SELECT text,source FROM lecture_text WHERE cache_key=$1",
    [cacheKey]
  )).rows[0];
  if (!row) return null;
  await database.query("UPDATE lecture_text SET last_accessed_at=CURRENT_TIMESTAMP WHERE cache_key=$1", [cacheKey]);
  return { text: row.text, source: row.source === "transcribed" ? "transcribed" : "generated" };
};

const saveLectureText = async (cacheKey: string, record: LectureTextRecord): Promise<LectureTextRecord> => {
  const inserted = (await database.query<{ text: string; source: string }>(
    `INSERT INTO lecture_text(cache_key,text,source)
     VALUES($1,$2,$3)
     ON CONFLICT(cache_key) DO NOTHING
     RETURNING text,source`,
    [cacheKey, record.text, record.source]
  )).rows[0];
  if (inserted) return record;
  // Another request/process won the race. Always use its persisted script so
  // later TTS and the text endpoint expose one canonical value.
  return (await readLectureText(cacheKey)) || record;
};

const lectureSourceFor = (input: LectureInputData) => input.mode === "section"
  ? `РАЗДЕЛ: ${input.title}\n\nВОПРОСЫ, КОТОРЫЕ НУЖНО СВЯЗНО РАСКРЫТЬ:\n${(input.topics || []).map((topic, index) => `${index + 1}. ${topic}`).join("\n")}`
  : input.title;

const generateLectureText = async (input: LectureInputData): Promise<string> => {
  if (!client) throw Object.assign(new Error("OpenAI не настроен"), { code: "ai_not_configured" });
  const isSection = input.mode === "section";
  const lecture = await client.responses.create({
    model,
    reasoning: { effort: "none" },
    max_output_tokens: isSection ? 1900 : 720,
    instructions: isSection
      ? `Подготовь одну часть большой учебной аудиолекции по разделу вступительного экзамена. Раскрой все переданные вопросы по очереди, каждый как самостоятельный экзаменационный ответ уровня 21–25 из 25: полный, логичный и терминологически точный, с относящимися к вопросу определениями, связями, классификациями, принципами работы и существенными особенностями. Перед каждым ответом обязательно дословно используй переход: «Вопрос: [полная формулировка]. Ответ:», а затем сразу давай содержательный ответ. Не объединяй вопросы так, чтобы какой-либо из них потерял отдельный ответ. Пиши связным разговорным текстом на русском языке без markdown, таблиц и нумерованных списков. Термины и код проговаривай понятно на слух. Не добавляй приветствия, воду и общий повтор в конце. Текст обязан оставаться компактнее 1800 токенов для последующей озвучки; полнота по критериям важнее фиксированной длительности.`
      : `Дай полноценный учебный ответ на один вопрос вступительного экзамена, рассчитанный на максимальную оценку 21–25 из 25. Начни дословно с конструкции «Вопрос: [полная формулировка вопроса]. Ответ:», после чего сразу переходи к содержанию. Ответ должен быть логичным и терминологически точным: дай относящиеся к вопросу определения, раскрой необходимые связи, классификации, принципы работы и существенные особенности. Не добавляй сведения, не относящиеся к вопросу. Удали воду, длинные вступления и повторный пересказ в конце. Пиши связным разговорным текстом на русском языке без markdown, таблиц и нумерованных списков, чтобы материал было удобно воспринимать только на слух. Термины и фрагменты кода проговаривай понятно. Цель — компактный ответ примерно на 1,5–2 минуты; сложный составной вопрос можно раскрыть дольше, если иначе пострадают критерии максимальной оценки.`,
    input: lectureSourceFor(input)
  });
  const text = lecture.output_text.trim();
  if (!text) throw new Error("OpenAI вернул пустой текст лекции");
  return text;
};

const transcribeLectureAudio = async (cacheKey: string, audio: Buffer, contentType: string): Promise<string> => {
  if (!client) throw Object.assign(new Error("OpenAI не настроен"), { code: "ai_not_configured" });
  const transcription = await client.audio.transcriptions.create({
    file: await toFile(audio, `${cacheKey}.mp3`, { type: contentType || "audio/mpeg" }),
    model: lectureTranscribeModel,
    language: "ru",
    response_format: "json"
  });
  const text = transcription.text.trim();
  if (!text) throw new Error("OpenAI вернул пустую расшифровку лекции");
  return text;
};

const createLectureText = async (cacheKey: string, input: LectureInputData): Promise<LectureTextRecord> => {
  // Old MP3s predate lecture_text. Their text must come from that exact audio;
  // generating a fresh answer could make the displayed text disagree with it.
  const cachedAudio = (await database.query<{ audio: Buffer; content_type: string }>(
    "SELECT audio,content_type FROM lecture_audio WHERE cache_key=$1",
    [cacheKey]
  )).rows[0];
  const record: LectureTextRecord = cachedAudio
    ? { text: await transcribeLectureAudio(cacheKey, cachedAudio.audio, cachedAudio.content_type), source: "transcribed" }
    : { text: await generateLectureText(input), source: "generated" };
  return saveLectureText(cacheKey, record);
};

const getOrCreateLectureText = async (cacheKey: string, input: LectureInputData) => {
  const cached = await readLectureText(cacheKey);
  if (cached) return { ...cached, cache: "HIT" as const };
  const existingJob = lectureTextJobs.get(cacheKey);
  if (existingJob) return { ...(await existingJob), cache: "COALESCED" as const };
  const job = createLectureText(cacheKey, input);
  lectureTextJobs.set(cacheKey, job);
  try {
    return { ...(await job), cache: "MISS" as const };
  } finally {
    if (lectureTextJobs.get(cacheKey) === job) lectureTextJobs.delete(cacheKey);
  }
};

app.get("/api/status", (_request, response) => response.json({
  ok: true,
  ai: Boolean(client),
  java: process.env.ENABLE_LOCAL_JAVA === "true",
  model: client ? model : null,
  questionQuiz: { model: client ? quizModel : null, questionsPerTopic: 8, cache: "postgresql" },
  lectureAudio: { bitrate: lectureAudioBitrate, compression: Boolean(ffmpegPath), speed: lectureSpeechSpeed, maxCharactersPerPart: lectureSpeechChunkMaxCharacters },
  lectureText: { transcriptionModel: lectureTranscribeModel },
  features: { lectureFollowUps: true, lectureText: true, uniqueListeningProgress: true, questionNotes: true, writtenRetry: true, questionQuiz: true }
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

app.post("/api/question-quiz", authRequired, async (request, response) => {
  const parsed = QuestionQuizInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Нужен корректный ключ вопроса" });
  const canonical = resolveCanonicalQuestion(parsed.data.questionKey);
  if (!canonical) return response.status(404).json({ error: "Вопрос не найден в экзаменационной программе" });
  const cacheKey = questionQuizCacheKeyFor(canonical);
  try {
    const cached = await readQuestionQuiz(cacheKey);
    if (cached) {
      response.setHeader("X-Question-Quiz-Cache", "HIT");
      return response.json({ questionKey: canonical.questionKey, ...cached });
    }

    // Ready cache entries remain usable even if the API key or balance is no
    // longer available. OpenAI is checked only after the PostgreSQL lookup.
    const ai = client;
    if (!ai) return response.status(503).json({ error: "Этот тест ещё не сохранён, а OpenAI не настроен" });

    const existingJob = questionQuizJobs.get(cacheKey);
    const quizJob = existingJob || generateQuestionQuiz(canonical, cacheKey, ai);
    if (!existingJob) questionQuizJobs.set(cacheKey, quizJob);
    try {
      const payload = await quizJob;
      response.setHeader("X-Question-Quiz-Cache", existingJob ? "COALESCED" : "MISS");
      response.json({ questionKey: canonical.questionKey, ...payload });
    } finally {
      if (questionQuizJobs.get(cacheKey) === quizJob) questionQuizJobs.delete(cacheKey);
    }
  } catch (error) {
    console.error(error);
    const code = (error as { code?: string; error?: { code?: string } })?.code
      || (error as { error?: { code?: string } })?.error?.code;
    if (code === "insufficient_quota") {
      return response.status(402).json({ error: "Баланс OpenAI закончился; уже готовые тесты сохранены" });
    }
    response.status(502).json({ error: "Не удалось подготовить мини-тест" });
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

app.post("/api/lectures/follow-up", authRequired, async (request, response) => {
  if (!client) return response.status(503).json({ error: "Уточняющие вопросы временно недоступны: OpenAI не настроен" });
  const parsed = z.object({
    originalQuestion: z.string().trim().min(5).max(3000),
    followUp: z.string().trim().min(3).max(2000)
  }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Некорректный исходный или уточняющий вопрос" });
  try {
    const result = await client.responses.create({
      model,
      reasoning: { effort: "low" },
      max_output_tokens: 600,
      instructions: `Ответь по-русски точно, понятно и строго в контексте исходного экзаменационного вопроса. Отвечай только на заданное уточнение и не повторяй весь основной ответ. Если уточнение двусмысленно, кратко обозначь принятое допущение. Используй короткие абзацы; не используй markdown-таблицы.`,
      input: `ИСХОДНЫЙ ЭКЗАМЕНАЦИОННЫЙ ВОПРОС:\n${parsed.data.originalQuestion}\n\nУТОЧНЯЮЩИЙ ВОПРОС:\n${parsed.data.followUp}`
    });
    const answer = result.output_text.trim();
    if (!answer) throw new Error("OpenAI вернул пустой ответ на уточняющий вопрос");
    response.json({ answer });
  } catch (error) {
    console.error(error);
    response.status(502).json({ error: "Не удалось получить ответ на уточняющий вопрос" });
  }
});

app.post("/api/lectures/text", authRequired, async (request, response) => {
  const parsed = LectureInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Некорректная тема лекции" });
  try {
    const result = await getOrCreateLectureText(lectureCacheKeyFor(parsed.data), parsed.data);
    response.setHeader("X-Lecture-Text-Cache", result.cache);
    response.setHeader("Cache-Control", "private, max-age=31536000");
    response.json({ text: result.text, source: result.source });
  } catch (error) {
    console.error(error);
    const code = (error as { code?: string })?.code;
    if (code === "ai_not_configured") {
      return response.status(503).json({ error: "Текст этой лекции ещё не сохранён, а OpenAI не настроен" });
    }
    if (code === "insufficient_quota") {
      return response.status(402).json({ error: "Баланс OpenAI закончился; готовые тексты лекций сохранены" });
    }
    response.status(502).json({ error: "Не удалось подготовить текст лекции" });
  }
});

app.post("/api/lectures/audio", authRequired, async (request, response) => {
  const parsed = LectureInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Некорректная тема лекции" });
  try {
    const cacheKey = lectureCacheKeyFor(parsed.data);
    const cached = (await database.query<{ audio: Buffer; content_type: string }>("SELECT audio,content_type FROM lecture_audio WHERE cache_key=$1", [cacheKey])).rows[0];
    if (cached) {
      await database.query("UPDATE lecture_audio SET last_accessed_at=CURRENT_TIMESTAMP WHERE cache_key=$1", [cacheKey]);
      response.setHeader("Content-Type", cached.content_type); response.setHeader("Content-Length", String(cached.audio.length)); response.setHeader("X-Lecture-Cache", "HIT"); response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      return response.send(cached.audio);
    }
    if (!client) return response.status(503).json({ error: "Добавь OPENAI_API_KEY в настройки сервера" });
    const existingJob = lectureAudioJobs.get(cacheKey);
    const audioJob = existingJob || (async () => {
      const lecture = await getOrCreateLectureText(cacheKey, parsed.data);
      // The API accepts at most 4096 characters per speech request. Every part
      // is a substring of the already persisted canonical text, and ffmpeg
      // joins the resulting MP3s back into one track.
      const speechParts = await Promise.all(splitLectureTextForSpeech(lecture.text).map((input) => client.audio.speech.create({
        model: (process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts") as "gpt-4o-mini-tts",
        voice: "alloy",
        input,
        instructions: "Говори по-русски спокойно, ясно и доброжелательно, как преподаватель на лекции. Делай небольшие паузы между смысловыми частями.",
        speed: lectureSpeechSpeed,
        response_format: "mp3"
      })));
      const audio = await compressLectureAudio(await Promise.all(speechParts.map(async (speech) => Buffer.from(await speech.arrayBuffer()))));
      if (audio.length <= lectureCacheMaxBytes) {
        const usage = Number((await database.query<{ total: string }>("SELECT COALESCE(SUM(byte_size),0)::text AS total FROM lecture_audio")).rows[0]?.total || 0);
        let bytesToFree = usage + audio.length - lectureCacheMaxBytes;
        if (bytesToFree > 0) {
          const oldest = (await database.query<{ cache_key: string; byte_size: number }>("SELECT cache_key,byte_size FROM lecture_audio ORDER BY last_accessed_at ASC")).rows;
          const remove: string[] = [];
          for (const item of oldest) { if (bytesToFree <= 0) break; remove.push(item.cache_key); bytesToFree -= item.byte_size; }
          if (remove.length) await database.query("DELETE FROM lecture_audio WHERE cache_key=ANY($1::text[])", [remove]);
        }
        await database.query("INSERT INTO lecture_audio(cache_key,audio,content_type,byte_size) VALUES($1,$2,'audio/mpeg',$3) ON CONFLICT(cache_key) DO UPDATE SET last_accessed_at=CURRENT_TIMESTAMP", [cacheKey, audio, audio.length]);
      }
      return audio;
    })();
    if (!existingJob) lectureAudioJobs.set(cacheKey, audioJob);
    const audio = await audioJob.finally(() => { if (lectureAudioJobs.get(cacheKey) === audioJob) lectureAudioJobs.delete(cacheKey); });
    response.setHeader("Content-Type", "audio/mpeg");
    response.setHeader("Content-Length", String(audio.length));
    response.setHeader("X-Lecture-Cache", existingJob ? "COALESCED" : "MISS");
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.send(audio);
  } catch (error) {
    console.error(error);
    if ((error as { code?: string })?.code === "insufficient_quota") {
      return response.status(402).json({ error: "Баланс OpenAI закончился; уже готовые аудио сохранены" });
    }
    response.status(502).json({ error: "Не удалось подготовить аудиолекцию" });
  }
});

app.get("/api/lectures/cache-status", authRequired, async (_request, response) => {
  const [audioResult, textResult] = await Promise.all([
    database.query<{ count: string; bytes: string }>("SELECT COUNT(*)::text AS count,COALESCE(SUM(byte_size),0)::text AS bytes FROM lecture_audio"),
    database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM lecture_text")
  ]);
  const status = audioResult.rows[0];
  response.json({ tracks: Number(status?.count || 0), texts: Number(textResult.rows[0]?.count || 0), bytes: Number(status?.bytes || 0), maxBytes: lectureCacheMaxBytes });
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
