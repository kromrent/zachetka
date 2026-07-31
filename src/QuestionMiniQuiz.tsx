import { useCallback, useEffect, useId, useRef, useState } from "react";

export const QUESTION_MINI_QUIZ_PROGRESS_STORAGE_KEY = "exam-question-quiz-progress";
export const QUESTION_MINI_QUIZ_PROGRESS_CHANGED_EVENT = "exam-question-quiz-progress-changed";
export const QUESTION_MINI_QUIZ_QUESTION_COUNT = 8;
export const QUESTION_MINI_QUIZ_MASTERY_SCORE = 6;

export type QuestionMiniQuizItem = {
  text: string;
  options: [string, string, string, string];
  answer: number;
  explanation: string;
};

export type QuestionMiniQuizProgress = {
  bestScore: number;
  lastScore: number;
  attempts: number;
  mastered: boolean;
  updatedAt: string;
};

export type QuestionMiniQuizProgressStore = Record<string, QuestionMiniQuizProgress>;

export type QuestionMiniQuizProgressChangedDetail = {
  questionKey: string;
  progress: QuestionMiniQuizProgress;
};

export type QuestionMiniQuizProps = {
  questionKey: string;
  question: string;
  contextLabel?: string;
  className?: string;
};

type QuizStage = "idle" | "active" | "result";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clampScore = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(QUESTION_MINI_QUIZ_QUESTION_COUNT, Math.floor(value)));
};

const normalizeProgress = (value: unknown): QuestionMiniQuizProgress | null => {
  if (!isRecord(value)) return null;
  const lastScore = clampScore(value.lastScore);
  const bestScore = Math.max(clampScore(value.bestScore), lastScore);
  const attempts = typeof value.attempts === "number" && Number.isFinite(value.attempts)
    ? Math.max(0, Math.floor(value.attempts))
    : 0;
  if (attempts === 0 && bestScore === 0 && lastScore === 0 && typeof value.updatedAt !== "string") return null;
  return {
    bestScore,
    lastScore,
    attempts,
    mastered: Boolean(value.mastered) || bestScore >= QUESTION_MINI_QUIZ_MASTERY_SCORE,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
  };
};

const parseProgressStore = (value: unknown): QuestionMiniQuizProgressStore => {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value || "{}") : value;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, entry]) => [key, normalizeProgress(entry)] as const)
        .filter((entry): entry is readonly [string, QuestionMiniQuizProgress] => entry[1] !== null)
    );
  } catch {
    return {};
  }
};

/**
 * Merge account snapshots without allowing an older device to lower the best
 * score. The newest timestamp owns the last-result fields; aggregate counters
 * never move backwards.
 */
export const mergeQuestionMiniQuizProgressValues = (...values: unknown[]) => {
  const merged: QuestionMiniQuizProgressStore = {};
  for (const value of values) {
    for (const [questionKey, candidate] of Object.entries(parseProgressStore(value))) {
      const saved = merged[questionKey];
      if (!saved) {
        merged[questionKey] = candidate;
        continue;
      }
      const savedAt = Date.parse(saved.updatedAt) || 0;
      const candidateAt = Date.parse(candidate.updatedAt) || 0;
      const newest = candidateAt >= savedAt ? candidate : saved;
      const bestScore = Math.max(saved.bestScore, candidate.bestScore);
      merged[questionKey] = {
        bestScore,
        lastScore: newest.lastScore,
        attempts: Math.max(saved.attempts, candidate.attempts),
        mastered: saved.mastered || candidate.mastered || bestScore >= QUESTION_MINI_QUIZ_MASTERY_SCORE,
        updatedAt: newest.updatedAt
      };
    }
  }
  return JSON.stringify(merged);
};

const readProgressStore = (): QuestionMiniQuizProgressStore => {
  if (typeof window === "undefined") return {};
  return parseProgressStore(window.localStorage.getItem(QUESTION_MINI_QUIZ_PROGRESS_STORAGE_KEY));
};

const readQuestionProgress = (questionKey: string) => readProgressStore()[questionKey] || null;

const writeCompletedAttempt = (questionKey: string, score: number) => {
  if (typeof window === "undefined") throw new Error("Хранилище недоступно");
  const store = readProgressStore();
  const previous = store[questionKey];
  const safeScore = clampScore(score);
  const bestScore = Math.max(previous?.bestScore || 0, safeScore);
  const progress: QuestionMiniQuizProgress = {
    bestScore,
    lastScore: safeScore,
    attempts: (previous?.attempts || 0) + 1,
    mastered: bestScore >= QUESTION_MINI_QUIZ_MASTERY_SCORE,
    updatedAt: new Date().toISOString()
  };
  store[questionKey] = progress;
  window.localStorage.setItem(QUESTION_MINI_QUIZ_PROGRESS_STORAGE_KEY, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent<QuestionMiniQuizProgressChangedDetail>(QUESTION_MINI_QUIZ_PROGRESS_CHANGED_EVENT, {
    detail: { questionKey, progress }
  }));
  return progress;
};

const normalizeQuizItem = (value: unknown): QuestionMiniQuizItem | null => {
  if (!isRecord(value) || typeof value.text !== "string" || typeof value.explanation !== "string") return null;
  if (!Array.isArray(value.options) || value.options.length !== 4 || !value.options.every((option) => typeof option === "string")) return null;
  if (typeof value.answer !== "number" || !Number.isInteger(value.answer) || value.answer < 0 || value.answer > 3) return null;
  return {
    text: value.text.trim(),
    options: [...value.options] as [string, string, string, string],
    answer: value.answer,
    explanation: value.explanation.trim()
  };
};

const parseQuizResponse = (value: unknown, questionKey: string) => {
  if (!isRecord(value) || value.questionKey !== questionKey || !Array.isArray(value.questions)) {
    throw new Error("Сервер вернул некорректный мини-тест");
  }
  const questions = value.questions.map(normalizeQuizItem);
  if (questions.length !== QUESTION_MINI_QUIZ_QUESTION_COUNT || questions.some((item) => item === null)) {
    throw new Error("В мини-тесте должно быть ровно 8 вопросов с четырьмя вариантами");
  }
  return questions as QuestionMiniQuizItem[];
};

const shuffled = <T,>(values: readonly T[]) => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

const shuffleAttempt = (questions: readonly QuestionMiniQuizItem[]) => shuffled(questions).map((question) => {
  const options = shuffled(question.options.map((text, originalIndex) => ({ text, originalIndex })));
  return {
    ...question,
    options: options.map((option) => option.text) as [string, string, string, string],
    answer: options.findIndex((option) => option.originalIndex === question.answer)
  };
});

const attemptWord = (count: number) => {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "попыток";
  if (last === 1) return "попытка";
  if (last >= 2 && last <= 4) return "попытки";
  return "попыток";
};

function QuestionMiniQuizEditor({ questionKey, question, contextLabel, className }: QuestionMiniQuizProps) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<QuizStage>("idle");
  const [sourceQuestions, setSourceQuestions] = useState<QuestionMiniQuizItem[]>([]);
  const [questions, setQuestions] = useState<QuestionMiniQuizItem[]>([]);
  const [index, setIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const [resultScore, setResultScore] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [savedProgress, setSavedProgress] = useState<QuestionMiniQuizProgress | null>(() => readQuestionProgress(questionKey));
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const answerLockedRef = useRef(false);
  const advanceLockedRef = useRef(false);
  const focusRef = useRef<HTMLHeadingElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const generatedId = useId();
  const panelId = `${generatedId}-question-mini-quiz-panel`;
  const questionHeadingId = `${generatedId}-question-mini-quiz-question`;
  const feedbackId = `${generatedId}-question-mini-quiz-feedback`;

  useEffect(() => {
    // React Strict Mode replays effects in development, so set the flag in the
    // effect body as well as during initial render.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, []);

  useEffect(() => {
    const applyExternalProgress = () => setSavedProgress(readQuestionProgress(questionKey));
    const handleStorage = (event: StorageEvent) => {
      if (event.key === QUESTION_MINI_QUIZ_PROGRESS_STORAGE_KEY) applyExternalProgress();
    };
    const handleProgressChanged = (event: Event) => {
      const detail = (event as CustomEvent<QuestionMiniQuizProgressChangedDetail>).detail;
      if (detail?.questionKey === questionKey) applyExternalProgress();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(QUESTION_MINI_QUIZ_PROGRESS_CHANGED_EVENT, handleProgressChanged);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(QUESTION_MINI_QUIZ_PROGRESS_CHANGED_EVENT, handleProgressChanged);
    };
  }, [questionKey]);

  const focusCurrentContent = () => window.requestAnimationFrame(() => {
    const heading = focusRef.current;
    if (!heading) return;
    heading.scrollIntoView({ behavior: "smooth", block: "start" });
    heading.focus({ preventScroll: true });
  });

  const beginAttempt = useCallback((availableQuestions: readonly QuestionMiniQuizItem[]) => {
    answerLockedRef.current = false;
    advanceLockedRef.current = false;
    setQuestions(shuffleAttempt(availableQuestions));
    setIndex(0);
    setSelectedOption(null);
    setConfirmed(false);
    setCorrectCount(0);
    setResultScore(0);
    setError("");
    setStage("active");
    focusCurrentContent();
  }, []);

  const start = async () => {
    if (requestRef.current || loading) return;
    if (sourceQuestions.length === QUESTION_MINI_QUIZ_QUESTION_COUNT) {
      beginAttempt(sourceQuestions);
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/question-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionKey }),
        signal: controller.signal
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = isRecord(body) && typeof body.error === "string" ? body.error : "Не удалось подготовить мини-тест";
        throw new Error(message);
      }
      const loadedQuestions = parseQuizResponse(body, questionKey);
      if (!mountedRef.current || controller.signal.aborted || requestRef.current !== controller) return;
      setSourceQuestions(loadedQuestions);
      beginAttempt(loadedQuestions);
    } catch (caught) {
      if (!mountedRef.current || controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "Не удалось подготовить мини-тест");
    } finally {
      if (mountedRef.current && requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  const current = questions[index];
  const currentIsCorrect = confirmed && selectedOption === current?.answer;

  useEffect(() => {
    answerLockedRef.current = false;
    advanceLockedRef.current = false;
  }, [index, stage]);

  const confirmAnswer = () => {
    if (!current || selectedOption === null || confirmed || answerLockedRef.current) return;
    answerLockedRef.current = true;
    if (selectedOption === current.answer) setCorrectCount((value) => value + 1);
    setConfirmed(true);
  };

  const next = () => {
    if (!current || selectedOption === null || !confirmed || advanceLockedRef.current) return;
    advanceLockedRef.current = true;
    if (index < questions.length - 1) {
      setIndex((value) => value + 1);
      setSelectedOption(null);
      setConfirmed(false);
      focusCurrentContent();
      return;
    }
    const finalScore = correctCount;
    setResultScore(finalScore);
    setStage("result");
    try {
      setSavedProgress(writeCompletedAttempt(questionKey, finalScore));
    } catch {
      setError("Результат показан, но сохранить прогресс на этом устройстве не удалось");
    }
    focusCurrentContent();
  };

  const summary = savedProgress
    ? `Лучший результат ${savedProgress.bestScore}/8 · ${savedProgress.attempts} ${attemptWord(savedProgress.attempts)}`
    : "8 вопросов · примерно 3 минуты";
  const rootClassName = ["question-mini-quiz", open && "question-mini-quiz--open", className]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={rootClassName} aria-label={`Мини-тест по вопросу: ${question}`}>
      <button
        type="button"
        className="question-mini-quiz__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="question-mini-quiz__toggle-copy">
          <span className="question-mini-quiz__title">Мини-тест по этому вопросу</span>
          <span className="question-mini-quiz__hint">{summary}</span>
        </span>
        <span className="question-mini-quiz__toggle-icon" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>

      <div id={panelId} className="question-mini-quiz__panel" hidden={!open} aria-busy={loading}>
        {contextLabel && <p className="question-mini-quiz__context">{contextLabel}</p>}
        <p className="question-mini-quiz__topic"><span>Тема</span>{question}</p>

        {stage === "idle" && <div className="question-mini-quiz__intro">
          <p>Восемь коротких заданий помогут проверить определения, связи и важные детали темы.</p>
          <small>Если этот тест ещё никто не открывал, первая подготовка займёт немного времени. Затем готовый набор сохранится для всех.</small>
          <button type="button" className="question-mini-quiz__start" disabled={loading} onClick={() => void start()}>
            {loading ? "Готовлю мини-тест…" : savedProgress ? "Пройти мини-тест ещё раз" : "Начать мини-тест"}
          </button>
          {loading && <p className="question-mini-quiz__status" role="status" aria-live="polite">Загружаю восемь вопросов…</p>}
          {error && <p className="question-mini-quiz__error" role="alert">{error}</p>}
        </div>}

        {stage === "active" && current && <div className="question-mini-quiz__attempt">
          <div className="question-mini-quiz__progress-copy"><span>Вопрос {index + 1} из 8</span><b>{correctCount} верно</b></div>
          <progress value={index + (confirmed ? 1 : 0)} max={QUESTION_MINI_QUIZ_QUESTION_COUNT} aria-label={`Пройдено ${index + (confirmed ? 1 : 0)} из 8 вопросов`}/>
          <h3 ref={focusRef} tabIndex={-1} id={questionHeadingId}>{current.text}</h3>
          <div className="question-mini-quiz__options" role="radiogroup" aria-labelledby={questionHeadingId} aria-describedby={confirmed ? feedbackId : undefined}>
            {current.options.map((option, optionIndex) => {
              const selected = selectedOption === optionIndex;
              const correct = confirmed && optionIndex === current.answer;
              const wrongSelection = confirmed && selected && optionIndex !== current.answer;
              const optionClassName = [
                "question-mini-quiz__option",
                selected && "is-selected",
                correct && "is-correct",
                wrongSelection && "is-wrong"
              ].filter(Boolean).join(" ");
              return <button
                type="button"
                role="radio"
                aria-checked={selected}
                className={optionClassName}
                disabled={confirmed}
                onClick={() => setSelectedOption(optionIndex)}
                onKeyDown={(event) => {
                  const previous = event.key === "ArrowUp" || event.key === "ArrowLeft";
                  const following = event.key === "ArrowDown" || event.key === "ArrowRight";
                  if (!previous && !following && event.key !== "Home" && event.key !== "End") return;
                  event.preventDefault();
                  const target = event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? current.options.length - 1
                      : (optionIndex + (previous ? -1 : 1) + current.options.length) % current.options.length;
                  setSelectedOption(target);
                  window.requestAnimationFrame(() => optionRefs.current[target]?.focus());
                }}
                ref={(node) => { optionRefs.current[optionIndex] = node; }}
                tabIndex={selectedOption === null ? (optionIndex === 0 ? 0 : -1) : (selected ? 0 : -1)}
                key={`${index}-${optionIndex}`}
              >
                <span aria-hidden="true">{["А", "Б", "В", "Г"][optionIndex]}</span>
                <strong>{option}</strong>
                {correct && <em>Верно</em>}
                {wrongSelection && <em>Твой ответ</em>}
              </button>;
            })}
          </div>
          {!confirmed ? <button type="button" className="question-mini-quiz__confirm" disabled={selectedOption === null} onClick={confirmAnswer}>Проверить ответ</button> : <div id={feedbackId} className={`question-mini-quiz__feedback ${currentIsCorrect ? "is-correct" : "is-wrong"}`} role="status" aria-live="polite">
            <strong>{currentIsCorrect ? "Верно" : "Неверно"}</strong>
            <p>{current.explanation}</p>
            <button type="button" className="question-mini-quiz__next" onClick={next}>{index === questions.length - 1 ? "Показать результат" : "Следующий вопрос →"}</button>
          </div>}
        </div>}

        {stage === "result" && <div className="question-mini-quiz__result" aria-live="polite">
          <p className="question-mini-quiz__result-label">Мини-тест завершён</p>
          <h3 ref={focusRef} tabIndex={-1}>{resultScore}<span>/8</span></h3>
          <strong>{resultScore >= 7 ? "Тема усвоена уверенно" : resultScore >= 6 ? "Хороший результат" : resultScore >= 4 ? "Есть база — повтори слабые места" : "Стоит ещё раз разобрать тему"}</strong>
          {error && <p className="question-mini-quiz__error" role="alert">{error}</p>}
          <button type="button" className="question-mini-quiz__retry" onClick={() => beginAttempt(sourceQuestions)}>Пройти ещё раз</button>
        </div>}
      </div>
    </section>
  );
}

export function QuestionMiniQuiz(props: QuestionMiniQuizProps) {
  return <QuestionMiniQuizEditor key={props.questionKey} {...props}/>;
}

export default QuestionMiniQuiz;
