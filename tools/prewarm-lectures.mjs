#!/usr/bin/env node

/**
 * Pre-generate lecture MP3 files in the deployed shared PostgreSQL cache.
 *
 * Usage:
 *   node --env-file=.env tools/prewarm-lectures.mjs --mode questions
 *
 *   PREWARM_USERNAME='existing-user' PREWARM_PASSWORD='password' \
 *     node tools/prewarm-lectures.mjs --mode questions
 *
 *   PREWARM_USERNAME='existing-user' PREWARM_PASSWORD='password' \
 *     node tools/prewarm-lectures.mjs \
 *       --base-url https://zachetka-3new.onrender.com \
 *       --mode all \
 *       --max-new 20
 *
 *   node tools/prewarm-lectures.mjs --mode all --dry-run
 *
 * Options:
 *   --base-url URL                  API origin (default: Render production URL)
 *   --mode questions|sections|all  Which tracks to process (default: all)
 *   --max-new N                    Stop after N cache misses; cache hits do not count
 *   --dry-run                      Build and show the plan without logging in or sending requests
 *   --help                         Show usage
 *
 * Authentication uses either an existing username/password or the Telegram bot
 * token from .env. Secrets and session cookies are never printed.
 */

import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_BASE_URL = "https://zachetka-3new.onrender.com";
const QUESTIONS_PER_SECTION_PART = 3;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 15 * 60_000;

class AuthenticationError extends Error {}
class InterruptedError extends Error {}

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
  process.stderr.write("\nПолучен Ctrl+C. Останавливаю текущий запрос и подвожу итог…\n");
  activeController?.abort();
  if (sleepTimer) clearTimeout(sleepTimer);
  finishSleep?.();
});

function usage() {
  return `Прогрев общего кэша аудиолекций

Использование:
  node --env-file=.env tools/prewarm-lectures.mjs [параметры]

или:
  PREWARM_USERNAME='логин' PREWARM_PASSWORD='пароль' \\
    node tools/prewarm-lectures.mjs [параметры]

Параметры:
  --base-url URL                  адрес приложения (по умолчанию ${DEFAULT_BASE_URL})
  --mode questions|sections|all  вопросы, части лекций или всё (по умолчанию all)
  --max-new N                    остановиться после N новых MP3; готовые HIT не считаются
  --dry-run                      только показать план, без входа и запросов
  --help                         показать эту справку`;
}

function valueAfterEquals(argument, name) {
  const prefix = `${name}=`;
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : null;
}

function parseArguments(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    mode: "all",
    maxNew: Number.POSITIVE_INFINITY,
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

    const inlineMode = valueAfterEquals(argument, "--mode");
    if (argument === "--mode" || inlineMode !== null) {
      const value = inlineMode ?? argv[++index];
      if (!["questions", "sections", "all"].includes(value)) {
        throw new Error("--mode должен быть questions, sections или all.");
      }
      options.mode = value;
      continue;
    }

    const inlineMaxNew = valueAfterEquals(argument, "--max-new");
    if (argument === "--max-new" || inlineMaxNew !== null) {
      const value = inlineMaxNew ?? argv[++index];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error("--max-new должен быть целым неотрицательным числом.");
      }
      options.maxNew = Number(value);
      if (!Number.isSafeInteger(options.maxNew)) {
        throw new Error("--max-new слишком велик.");
      }
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

  return options;
}

async function loadTracks() {
  const bankUrl = new URL("../src/question-bank.json", import.meta.url);
  const banks = JSON.parse(await readFile(bankUrl, "utf8"));
  if (!Array.isArray(banks)) throw new Error("src/question-bank.json должен содержать массив предметов.");

  const questions = [];
  const sections = [];

  for (const bank of banks) {
    if (!bank || typeof bank.title !== "string" || !Array.isArray(bank.sections)) {
      throw new Error("Некорректная структура предмета в src/question-bank.json.");
    }

    for (let sectionIndex = 0; sectionIndex < bank.sections.length; sectionIndex += 1) {
      const section = bank.sections[sectionIndex];
      if (!section || typeof section.title !== "string" || !Array.isArray(section.questions)) {
        throw new Error(`Некорректный раздел ${sectionIndex + 1} предмета ${bank.title}.`);
      }

      section.questions.forEach((question, questionIndex) => {
        if (typeof question !== "string") {
          throw new Error(`Некорректный вопрос ${questionIndex + 1} раздела ${section.title}.`);
        }
        questions.push({
          kind: "question",
          label: `${bank.title} · ${section.title} · вопрос ${questionIndex + 1}`,
          // This is byte-for-byte the JSON shape produced by App.tsx requestBody()
          // for a question track: the undefined topics property is omitted there.
          payload: { title: question, mode: "question" }
        });
      });

      const partCount = Math.ceil(section.questions.length / QUESTIONS_PER_SECTION_PART);
      for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
        const topics = section.questions.slice(
          partIndex * QUESTIONS_PER_SECTION_PART,
          partIndex * QUESTIONS_PER_SECTION_PART + QUESTIONS_PER_SECTION_PART
        );
        sections.push({
          kind: "section",
          label: `${bank.title} · ${section.title} · часть ${partIndex + 1} из ${partCount}`,
          // This matches App.tsx: section title plus the same chunks of 3 topics.
          payload: { title: section.title, mode: "section", topics }
        });
      }
    }
  }

  return { questions, sections };
}

function compactLabel(label, maxLength = 116) {
  if (label.length <= maxLength) return label;
  return `${label.slice(0, maxLength - 1)}…`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КиБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МиБ`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ГиБ`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours} ч ${minutes} мин ${seconds} с`;
  if (minutes) return `${minutes} мин ${seconds} с`;
  return `${seconds} с`;
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const fromHeader = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(fromHeader) && fromHeader > 0) {
      return Math.min(60_000, Math.max(1_000, fromHeader));
    }
  }
  return Math.min(60_000, 2_000 * 2 ** (attempt - 1));
}

function wait(milliseconds) {
  if (stopping) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (sleepTimer) clearTimeout(sleepTimer);
      sleepTimer = null;
      finishSleep = null;
      resolve();
    };
    finishSleep = done;
    sleepTimer = setTimeout(done, milliseconds);
  });
}

async function fetchWithRetry(url, init, label) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (stopping) throw new InterruptedError("Остановлено пользователем.");

    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const release = () => {
      clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    };

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        await response.arrayBuffer().catch(() => null);
        release();
        const delay = retryDelay(response, attempt);
        process.stderr.write(
          `  ${label}: HTTP ${response.status}, повтор ${attempt}/${MAX_ATTEMPTS - 1} через ${Math.round(delay / 1000)} с.\n`
        );
        await wait(delay);
        continue;
      }
      return { response, release };
    } catch (error) {
      release();
      if (stopping) throw new InterruptedError("Остановлено пользователем.");
      if (attempt >= MAX_ATTEMPTS) throw error;
      const delay = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      process.stderr.write(
        `  ${label}: ${timedOut ? "тайм-аут запроса" : "ошибка сети"}, повтор ${attempt}/${MAX_ATTEMPTS - 1} через ${Math.round(delay / 1000)} с.\n`
      );
      await wait(delay);
    }
  }

  throw new Error(`Не удалось выполнить запрос: ${label}`);
}

async function responseError(response) {
  const text = await response.text().catch(() => "");
  if (!text) return `HTTP ${response.status}`;
  try {
    const json = JSON.parse(text);
    return typeof json?.error === "string" ? json.error : `HTTP ${response.status}`;
  } catch {
    return `${text.slice(0, 240)}${text.length > 240 ? "…" : ""}`;
  }
}

function sessionCookieFrom(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  const session = values.find((value) => value.startsWith("zachetka_session="));
  return session?.split(";", 1)[0] ?? null;
}

async function login(baseUrl, username, password) {
  const { response, release } = await fetchWithRetry(
    `${baseUrl}/api/auth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    },
    "вход"
  );

  try {
    if (response.status === 401) {
      const reason = await responseError(response);
      throw new AuthenticationError(
        `Авторизация не удалась: ${reason}. Проверь PREWARM_USERNAME и PREWARM_PASSWORD. Новый аккаунт скрипт не создаёт.`
      );
    }
    if (!response.ok) {
      throw new Error(`Не удалось войти: ${await responseError(response)} (HTTP ${response.status}).`);
    }

    const cookie = sessionCookieFrom(response.headers);
    await response.arrayBuffer();
    if (!cookie) {
      throw new AuthenticationError("Сервер не вернул сессионную cookie после входа.");
    }
    return cookie;
  } finally {
    release();
  }
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

  const { response, release } = await fetchWithRetry(
    `${baseUrl}/api/auth/telegram`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: params.toString() })
    },
    "служебный вход через Telegram"
  );

  try {
    if (!response.ok) {
      throw new AuthenticationError(
        `Служебный вход через Telegram не удался: ${await responseError(response)} (HTTP ${response.status}).`
      );
    }
    const cookie = sessionCookieFrom(response.headers);
    await response.arrayBuffer();
    if (!cookie) throw new AuthenticationError("Сервер не вернул сессионную cookie после входа через Telegram.");
    return cookie;
  } finally {
    release();
  }
}

async function consumeBytes(response) {
  if (!response.body) return Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
  }
}

function printSummary(stats, startedAt) {
  const elapsed = Date.now() - startedAt;
  process.stdout.write(
    `\nИтог: обработано ${stats.processed}/${stats.total}, ` +
    `HIT ${stats.hits}, MISS ${stats.misses}, ошибок ${stats.failures}, ` +
    `получено ${formatBytes(stats.bytes)}, время ${formatDuration(elapsed)}.\n`
  );
  if (stats.stoppedByLimit) {
    process.stdout.write(`Достигнут лимит --max-new ${stats.maxNew}; новые генерации остановлены.\n`);
  }
  if (stopping) process.stdout.write("Прогрев остановлен пользователем.\n");
  if (stats.outOfFunds) process.stdout.write("OpenAI сообщил, что доступный баланс закончился. Уже созданные MP3 сохранены.\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { questions, sections } = await loadTracks();
  const selectedTracks = options.mode === "questions"
    ? questions
    : options.mode === "sections"
      ? sections
      : [...questions, ...sections];
  const tracks = [...new Map(selectedTracks.map((track) => [JSON.stringify(track.payload), track])).values()];

  process.stdout.write(
    `Банк: ${questions.length} ответов на вопросы + ${sections.length} частей лекций. ` +
    `Выбрано: ${selectedTracks.length}, уникальных запросов: ${tracks.length} (${options.mode}).\n`
  );

  if (options.dryRun) {
    process.stdout.write("DRY RUN: вход и запросы к API не выполняются.\n");
    if (Number.isFinite(options.maxNew)) {
      process.stdout.write(
        `--max-new ${options.maxNew} будет ограничивать только фактические MISS; заранее отличить их от HIT невозможно.\n`
      );
    }
    if (tracks.length) {
      process.stdout.write(`Первый трек: ${compactLabel(tracks[0].label)}\n`);
      process.stdout.write(`Последний трек: ${compactLabel(tracks.at(-1).label)}\n`);
    }
    return;
  }

  if (options.maxNew === 0) {
    process.stdout.write("--max-new равен 0: запросы аудио не выполняются.\n");
    return;
  }

  const username = process.env.PREWARM_USERNAME;
  const password = process.env.PREWARM_PASSWORD;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if ((!username || !password) && !botToken) {
    throw new AuthenticationError(
      "Нужны PREWARM_USERNAME/PREWARM_PASSWORD существующего аккаунта либо TELEGRAM_BOT_TOKEN из .env."
    );
  }

  process.stdout.write(`Авторизую прогрев на ${options.baseUrl}…\n`);
  const cookie = username && password
    ? await login(options.baseUrl, username, password)
    : await telegramLogin(options.baseUrl, botToken);
  process.stdout.write("Вход выполнен. Начинаю последовательный прогрев.\n");

  const startedAt = Date.now();
  const stats = {
    total: tracks.length,
    processed: 0,
    hits: 0,
    misses: 0,
    failures: 0,
    bytes: 0,
    maxNew: options.maxNew,
    stoppedByLimit: false,
    outOfFunds: false
  };

  try {
    for (let index = 0; index < tracks.length; index += 1) {
      if (stopping) break;
      if (stats.misses >= options.maxNew) {
        stats.stoppedByLimit = true;
        break;
      }

      const track = tracks[index];
      process.stdout.write(`[${index + 1}/${tracks.length}] ${compactLabel(track.label)}\n`);

      try {
        const { response, release } = await fetchWithRetry(
          `${options.baseUrl}/api/lectures/audio`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: cookie
            },
            body: JSON.stringify(track.payload)
          },
          `трек ${index + 1}`
        );

        try {
          if (response.status === 401) {
            const reason = await responseError(response);
            throw new AuthenticationError(
              `Сессия не авторизована: ${reason}. Проверь существующий аккаунт и повтори запуск.`
            );
          }
          if (response.status === 402) {
            stats.outOfFunds = true;
            process.stderr.write(`  STOP: ${await responseError(response)}\n`);
            break;
          }
          if (!response.ok) {
            const reason = await responseError(response);
            stats.failures += 1;
            stats.processed += 1;
            process.stderr.write(`  ERROR HTTP ${response.status}: ${reason}\n`);
            continue;
          }

          const bytes = await consumeBytes(response);
          const cacheHeader = (response.headers.get("x-lecture-cache") || "").toUpperCase();
          const hit = cacheHeader === "HIT";
          if (hit) stats.hits += 1;
          else stats.misses += 1;
          stats.bytes += bytes;
          stats.processed += 1;

          const cacheResult = hit
            ? "HIT"
            : cacheHeader === "COALESCED"
              ? "MISS (COALESCED)"
              : "MISS";
          process.stdout.write(
            `  ${cacheResult} · ${formatBytes(bytes)} · HIT ${stats.hits} / MISS ${stats.misses}\n`
          );
        } finally {
          release();
        }
      } catch (error) {
        if (error instanceof AuthenticationError) throw error;
        if (error instanceof InterruptedError || stopping) break;
        stats.failures += 1;
        stats.processed += 1;
        process.stderr.write(`  ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    printSummary(stats, startedAt);
  }

  if (stats.failures > 0) process.exitCode = 1;
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
