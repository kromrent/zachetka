#!/usr/bin/env node

/**
 * Download question lecture MP3 files from the deployed shared cache.
 *
 * The request payload intentionally matches App.tsx and prewarm-lectures.mjs so
 * an existing database entry is returned as a cache HIT. A MISS is accepted:
 * the server will generate and cache that track before returning it.
 *
 * Usage:
 *   node --env-file=.env tools/backup-lecture-audio.mjs
 *   node --env-file=.env tools/backup-lecture-audio.mjs --take 50
 *   node tools/backup-lecture-audio.mjs --dry-run
 */

import { createHmac, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { resolve } from "node:path";

try {
  process.loadEnvFile?.();
} catch {
  // .env is optional when variables are supplied by the shell.
}

const DEFAULT_BASE_URL = "https://zachetka-3new.onrender.com";
const DEFAULT_OUTPUT_DIR = ".lecture-backups/questions";
const DEFAULT_TAKE = 50;
const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 15 * 60_000;

class AuthenticationError extends Error {}
class InterruptedError extends Error {}
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let stopping = false;
let signalCount = 0;
let activeController = null;
let sleepTimer = null;
let finishSleep = null;

process.on("SIGINT", () => {
  signalCount += 1;
  if (signalCount > 1) {
    process.stderr.write("\nПовторный Ctrl+C: немедленная остановка.\n");
    process.exit(130);
  }

  stopping = true;
  process.stderr.write("\nПолучен Ctrl+C. Завершаю безопасно; готовые файлы останутся для продолжения.\n");
  activeController?.abort();
  if (sleepTimer) clearTimeout(sleepTimer);
  finishSleep?.();
});

function usage() {
  return `Резервное копирование аудиоответов

Использование:
  node --env-file=.env tools/backup-lecture-audio.mjs [параметры]

Параметры:
  --base-url URL      адрес приложения (по умолчанию ${DEFAULT_BASE_URL})
  --take N            первые N вопросов в порядке интерфейса (по умолчанию ${DEFAULT_TAKE})
  --output-dir PATH   каталог MP3 (по умолчанию ${DEFAULT_OUTPUT_DIR})
  --dry-run           показать план без входа, запросов и записи файлов
  --help              показать эту справку

Авторизация:
  PREWARM_USERNAME и PREWARM_PASSWORD имеют приоритет; иначе используется
  TELEGRAM_BOT_TOKEN. Секреты и cookie никогда не выводятся.`;
}

function valueAfterEquals(argument, name) {
  const prefix = `${name}=`;
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : null;
}

function parseArguments(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    take: DEFAULT_TAKE,
    outputDir: DEFAULT_OUTPUT_DIR,
    dryRun: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    const inlineBaseUrl = valueAfterEquals(argument, "--base-url");
    if (argument === "--base-url" || inlineBaseUrl !== null) {
      const value = inlineBaseUrl ?? argv[++index];
      if (!value) throw new Error("После --base-url нужен URL.");
      options.baseUrl = value;
      continue;
    }

    const inlineTake = valueAfterEquals(argument, "--take");
    if (argument === "--take" || inlineTake !== null) {
      const value = inlineTake ?? argv[++index];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error("--take должен быть целым неотрицательным числом.");
      }
      options.take = Number(value);
      if (!Number.isSafeInteger(options.take)) throw new Error("--take слишком велик.");
      continue;
    }

    const inlineOutputDir = valueAfterEquals(argument, "--output-dir");
    if (argument === "--output-dir" || inlineOutputDir !== null) {
      const value = inlineOutputDir ?? argv[++index];
      if (!value) throw new Error("После --output-dir нужен путь.");
      options.outputDir = value;
      continue;
    }

    throw new Error(`Неизвестный параметр: ${argument}`);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(options.baseUrl);
  } catch {
    throw new Error(`Некорректный --base-url: ${options.baseUrl}`);
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("--base-url должен начинаться с http:// или https://.");
  }
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
  parsedUrl.search = "";
  parsedUrl.hash = "";
  options.baseUrl = parsedUrl.toString().replace(/\/$/, "");
  options.outputDir = resolve(options.outputDir);

  return options;
}

async function loadQuestions() {
  const bankUrl = new URL("../src/question-bank.json", import.meta.url);
  const banks = JSON.parse(await readFile(bankUrl, "utf8"));
  if (!Array.isArray(banks)) {
    throw new Error("src/question-bank.json должен содержать массив предметов.");
  }

  const questions = [];
  for (const bank of banks) {
    if (!bank || typeof bank.title !== "string" || !Array.isArray(bank.sections)) {
      throw new Error("Некорректная структура предмета в src/question-bank.json.");
    }
    for (const section of bank.sections) {
      if (!section || typeof section.title !== "string" || !Array.isArray(section.questions)) {
        throw new Error(`Некорректный раздел предмета ${bank.title}.`);
      }
      for (const title of section.questions) {
        if (typeof title !== "string") {
          throw new Error(`Некорректный вопрос раздела ${section.title}.`);
        }
        questions.push({
          subject: bank.title,
          section: section.title,
          title,
          payload: { title, mode: "question" }
        });
      }
    }
  }
  return questions;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КиБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МиБ`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ГиБ`;
}

function compact(text, maxLength = 105) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function wait(milliseconds) {
  if (stopping) return Promise.resolve();
  return new Promise((resolveWait) => {
    const done = () => {
      if (sleepTimer) clearTimeout(sleepTimer);
      sleepTimer = null;
      finishSleep = null;
      resolveWait();
    };
    finishSleep = done;
    sleepTimer = setTimeout(done, milliseconds);
  });
}

function retryDelay(headers, attempt) {
  const retryAfter = headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(60_000, Math.max(1_000, parsed));
    }
  }
  return Math.min(60_000, 2_000 * 2 ** (attempt - 1));
}

function responseError(status, body) {
  const text = body.toString("utf8").trim();
  if (!text) return `HTTP ${status}`;
  try {
    const json = JSON.parse(text);
    if (typeof json?.error === "string") return json.error;
  } catch {
    // Use a short plain-text response below.
  }
  return `${text.slice(0, 240)}${text.length > 240 ? "…" : ""}`;
}

async function requestWithRetry(url, init, label) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (stopping) throw new InterruptedError("Остановлено пользователем.");

    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const body = Buffer.from(await response.arrayBuffer());
      const retryable = response.status === 429 || response.status >= 500;

      if (retryable && attempt < MAX_ATTEMPTS) {
        const delay = retryDelay(response.headers, attempt);
        process.stderr.write(
          `  ${label}: HTTP ${response.status}, повтор ${attempt}/${MAX_ATTEMPTS - 1} через ${Math.round(delay / 1000)} с.\n`
        );
        await wait(delay);
        continue;
      }

      return { status: response.status, ok: response.ok, headers: response.headers, body };
    } catch (error) {
      if (stopping) throw new InterruptedError("Остановлено пользователем.");
      if (attempt >= MAX_ATTEMPTS) throw error;
      const delay = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      process.stderr.write(
        `  ${label}: ${timedOut ? "тайм-аут запроса" : "ошибка сети"}, ` +
        `повтор ${attempt}/${MAX_ATTEMPTS - 1} через ${Math.round(delay / 1000)} с.\n`
      );
      await wait(delay);
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
  }

  throw new Error(`Не удалось выполнить запрос: ${label}`);
}

function sessionCookieFrom(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const match = /(?:^|,\s*)(zachetka_session=[^;,\s]+)/.exec(value);
    if (match) return match[1];
  }
  return null;
}

async function passwordLogin(baseUrl, username, password) {
  const result = await requestWithRetry(
    `${baseUrl}/api/auth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    },
    "вход"
  );

  if (result.status === 401) {
    throw new AuthenticationError(
      `Авторизация не удалась: ${responseError(result.status, result.body)}. ` +
      "Проверь PREWARM_USERNAME и PREWARM_PASSWORD."
    );
  }
  if (!result.ok) {
    throw new Error(`Не удалось войти: ${responseError(result.status, result.body)} (HTTP ${result.status}).`);
  }

  const cookie = sessionCookieFrom(result.headers);
  if (!cookie) throw new AuthenticationError("Сервер не вернул сессионную cookie после входа.");
  return cookie;
}

async function telegramLogin(baseUrl, botToken) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: -777000001, first_name: "Прогрев аудио" })
  });
  const checkString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(checkString).digest("hex"));

  const result = await requestWithRetry(
    `${baseUrl}/api/auth/telegram`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: params.toString() })
    },
    "служебный вход через Telegram"
  );

  if (!result.ok) {
    throw new AuthenticationError(
      `Служебный вход через Telegram не удался: ${responseError(result.status, result.body)} ` +
      `(HTTP ${result.status}).`
    );
  }
  const cookie = sessionCookieFrom(result.headers);
  if (!cookie) {
    throw new AuthenticationError("Сервер не вернул сессионную cookie после входа через Telegram.");
  }
  return cookie;
}

async function atomicWrite(filePath, data) {
  const temporaryPath =
    `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(5).toString("hex")}`;
  try {
    await writeFile(temporaryPath, data, { flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function loadManifest(manifestPath) {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!parsed || !Array.isArray(parsed.tracks)) {
      throw new Error("ожидался объект с массивом tracks");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: 1, tracks: [] };
    }
    throw new Error(
      `Не удалось прочитать ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function writeManifest(manifestPath, baseUrl, tracks) {
  const manifest = {
    version: 1,
    source: baseUrl,
    updatedAt: new Date().toISOString(),
    tracks: [...tracks].sort((left, right) => left.index - right.index)
  };
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function sameManifestTrack(entry, track) {
  return Boolean(
    entry &&
    entry.index === track.index &&
    entry.subject === track.subject &&
    entry.section === track.section &&
    entry.title === track.title &&
    entry.filename === track.filename &&
    Number.isSafeInteger(entry.bytes) &&
    entry.bytes > 0
  );
}

async function canResume(entry, track, outputDir) {
  if (!sameManifestTrack(entry, track)) return false;
  try {
    const details = await stat(resolve(outputDir, track.filename));
    return details.isFile() && details.size === entry.bytes;
  } catch {
    return false;
  }
}

async function downloadTrack(baseUrl, cookie, track) {
  const result = await requestWithRetry(
    `${baseUrl}/api/lectures/audio`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie
      },
      body: JSON.stringify(track.payload)
    },
    `трек ${track.index}`
  );

  if (result.status === 401) {
    throw new AuthenticationError(
      `Сессия не авторизована: ${responseError(result.status, result.body)}.`
    );
  }
  if (!result.ok) {
    throw new HttpError(
      result.status,
      `${responseError(result.status, result.body)} (HTTP ${result.status})`
    );
  }

  const contentType = (result.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("audio/") && !contentType.includes("mpeg")) {
    throw new Error(`Сервер вернул неожиданный Content-Type: ${contentType || "не указан"}.`);
  }
  if (result.body.length === 0) throw new Error("Сервер вернул пустой MP3.");

  return {
    audio: result.body,
    cacheHeader: (result.headers.get("x-lecture-cache") || "UNKNOWN").toUpperCase()
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const allQuestions = await loadQuestions();
  if (options.take > allQuestions.length) {
    throw new Error(
      `В банке только ${allQuestions.length} вопросов; --take не может быть больше этого числа.`
    );
  }

  const width = Math.max(3, String(Math.max(1, options.take)).length);
  const tracks = allQuestions.slice(0, options.take).map((question, zeroBasedIndex) => ({
    ...question,
    index: zeroBasedIndex + 1,
    filename: `${String(zeroBasedIndex + 1).padStart(width, "0")}.mp3`
  }));

  process.stdout.write(
    `План: первые ${tracks.length} из ${allQuestions.length} вопросов; ` +
    `каталог ${options.outputDir}.\n`
  );
  if (tracks.length) {
    process.stdout.write(
      `Первый: ${tracks[0].filename} · ${compact(tracks[0].title)}\n` +
      `Последний: ${tracks.at(-1).filename} · ${compact(tracks.at(-1).title)}\n`
    );
  }

  if (options.dryRun) {
    process.stdout.write("DRY RUN: вход, сетевые запросы и запись файлов не выполняются.\n");
    return;
  }
  if (tracks.length === 0) {
    process.stdout.write("Нечего скачивать: --take равен 0.\n");
    return;
  }

  await mkdir(options.outputDir, { recursive: true });
  const manifestPath = resolve(options.outputDir, "manifest.json");
  const existingManifest = await loadManifest(manifestPath);
  const entriesByIndex = new Map(
    existingManifest.tracks
      .filter((entry) => entry && Number.isSafeInteger(entry.index))
      .map((entry) => [entry.index, entry])
  );

  const pending = [];
  let skipped = 0;
  for (const track of tracks) {
    if (await canResume(entriesByIndex.get(track.index), track, options.outputDir)) {
      skipped += 1;
    } else {
      pending.push(track);
    }
  }

  if (skipped) process.stdout.write(`Продолжение: ${skipped} готовых MP3 пропущено, осталось ${pending.length}.\n`);
  if (pending.length === 0) {
    process.stdout.write("Все выбранные MP3 уже сохранены и совпадают с manifest.json.\n");
    return;
  }

  const username = process.env.PREWARM_USERNAME;
  const password = process.env.PREWARM_PASSWORD;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if ((!username || !password) && !botToken) {
    throw new AuthenticationError(
      "Нужны PREWARM_USERNAME/PREWARM_PASSWORD либо TELEGRAM_BOT_TOKEN."
    );
  }

  process.stdout.write(`Авторизуюсь на ${options.baseUrl}…\n`);
  const cookie = username && password
    ? await passwordLogin(options.baseUrl, username, password)
    : await telegramLogin(options.baseUrl, botToken);
  process.stdout.write("Вход выполнен. Скачиваю последовательно.\n");

  let downloaded = 0;
  let failures = 0;
  let bytes = 0;
  let hits = 0;
  let misses = 0;

  for (const track of pending) {
    if (stopping) break;
    process.stdout.write(`[${track.index}/${tracks.length}] ${compact(track.title)}\n`);

    try {
      const result = await downloadTrack(options.baseUrl, cookie, track);
      if (stopping) throw new InterruptedError("Остановлено пользователем.");

      await atomicWrite(resolve(options.outputDir, track.filename), result.audio);
      const entry = {
        index: track.index,
        subject: track.subject,
        section: track.section,
        title: track.title,
        filename: track.filename,
        bytes: result.audio.length,
        cacheHeader: result.cacheHeader
      };
      entriesByIndex.set(track.index, entry);
      await writeManifest(manifestPath, options.baseUrl, entriesByIndex.values());

      downloaded += 1;
      bytes += result.audio.length;
      if (result.cacheHeader === "HIT") hits += 1;
      else misses += 1;
      process.stdout.write(
        `  ${result.cacheHeader} · ${formatBytes(result.audio.length)} · сохранён ${track.filename}\n`
      );
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof InterruptedError || stopping) break;
      failures += 1;
      process.stderr.write(
        `  ERROR: ${error instanceof Error ? error.message : String(error)}\n`
      );
      if (error instanceof HttpError && error.status === 402) {
        process.stderr.write("  Баланс OpenAI закончился; останавливаюсь, готовые файлы сохранены.\n");
        break;
      }
    }
  }

  process.stdout.write(
    `\nИтог: скачано ${downloaded}, ранее готово ${skipped}, ошибок ${failures}, ` +
    `HIT ${hits}, MISS/COALESCED ${misses}, записано ${formatBytes(bytes)}.\n`
  );
  process.stdout.write(`MP3: ${options.outputDir}\nManifest: ${manifestPath}\n`);

  if (failures > 0) process.exitCode = 1;
  if (stopping) process.exitCode = 130;
}

main().catch((error) => {
  if (error instanceof InterruptedError || stopping) {
    process.exitCode = 130;
    return;
  }
  process.stderr.write(`Ошибка: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(`\n${usage()}\n`);
  process.exitCode = 1;
});
