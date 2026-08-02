import { useEffect, useId, useRef, useState } from "react";
import {
  getQuestionWrittenDraftStorageKey,
  QUESTION_WRITTEN_ANSWER_MAX_LENGTH,
  QUESTION_WRITTEN_DRAFT_CHANGED_EVENT,
  readQuestionWrittenDraft,
  writeQuestionWrittenDraft,
  type WrittenDraftChangedDetail
} from "./question-written-draft";

type WrittenGrade = {
  score: number;
  level: string;
  summary: string;
  strengths: string[];
  missing: string[];
  improvedAnswer: string;
};

type QuestionWrittenPracticeProps = {
  questionKey: string;
  question: string;
  contextLabel?: string;
  className?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : [];

const parseWrittenGrade = (value: unknown): WrittenGrade | null => {
  if (!isRecord(value)
    || typeof value.score !== "number"
    || typeof value.level !== "string"
    || typeof value.summary !== "string"
    || typeof value.improvedAnswer !== "string") return null;

  return {
    score: value.score,
    level: value.level,
    summary: value.summary,
    strengths: stringArray(value.strengths),
    missing: stringArray(value.missing),
    improvedAnswer: value.improvedAnswer
  };
};

const requestErrorMessage = (status: number, body: unknown) => {
  if (status === 401) return "Войди в аккаунт, чтобы проверить ответ";
  if (status === 429) return "Слишком много запросов. Подожди минуту и попробуй ещё раз";
  if (status === 503) return "Нейропроверка пока не настроена";
  if (isRecord(body) && typeof body.error === "string") return body.error;
  return "Не удалось проверить ответ";
};

function QuestionWrittenPracticeEditor({
  questionKey,
  question,
  contextLabel,
  className
}: QuestionWrittenPracticeProps) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState(() => readQuestionWrittenDraft(questionKey));
  const [result, setResult] = useState<WrittenGrade | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generatedId = useId();
  const panelId = `${generatedId}-question-written-panel`;
  const textareaId = `${generatedId}-question-written-answer`;
  const hintId = `${generatedId}-question-written-hint`;
  const counterId = `${generatedId}-question-written-counter`;

  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    const cancelPendingRequest = () => {
      requestRef.current?.abort();
      requestRef.current = null;
      setLoading(false);
    };
    const applyExternalDraft = () => {
      cancelPendingRequest();
      const nextAnswer = readQuestionWrittenDraft(questionKey);
      setAnswer(nextAnswer);
      setResult(null);
      setError("");
      setSaveError("");
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === getQuestionWrittenDraftStorageKey(questionKey)) applyExternalDraft();
    };
    const onDraftChanged = (event: Event) => {
      const detail = (event as CustomEvent<WrittenDraftChangedDetail>).detail;
      if (detail?.questionKey !== questionKey) return;
      cancelPendingRequest();
      setAnswer(detail.answer);
      setResult(null);
      setError("");
      setSaveError("");
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(QUESTION_WRITTEN_DRAFT_CHANGED_EVENT, onDraftChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(QUESTION_WRITTEN_DRAFT_CHANGED_EVENT, onDraftChanged);
    };
  }, [questionKey]);

  const focusTextarea = () => {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      textareaRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    });
  };

  const check = async () => {
    if (loading || requestRef.current || answer.trim().length < 20 || answer.length > QUESTION_WRITTEN_ANSWER_MAX_LENGTH) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/grade/written", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, answer }),
        signal: controller.signal
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(requestErrorMessage(response.status, body));
      const parsed = parseWrittenGrade(body);
      if (!parsed) throw new Error("Сервис вернул ответ в неизвестном формате");
      if (controller.signal.aborted || requestRef.current !== controller) return;
      setResult(parsed);
      window.requestAnimationFrame(() => {
        resultHeadingRef.current?.focus({ preventScroll: true });
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        resultHeadingRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
      });
    } catch (caught) {
      if (controller.signal.aborted) return;
      const message = caught instanceof Error ? caught.message : "";
      setError(message === "Failed to fetch" ? "Нет связи с сервером. Проверь интернет и попробуй ещё раз" : message || "Не удалось проверить ответ");
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  const updateAnswer = (nextAnswer: string) => {
    setAnswer(nextAnswer);
    setResult(null);
    setError("");
    try {
      writeQuestionWrittenDraft(questionKey, nextAnswer);
      setSaveError("");
    } catch {
      setSaveError("Не удалось сохранить черновик на этом устройстве");
    }
  };

  const improve = () => {
    setResult(null);
    setError("");
    focusTextarea();
  };

  const restart = () => {
    if (answer.trim() && !window.confirm("Очистить этот черновик и начать ответ заново?")) return;
    try {
      // An explicit empty value also clears the server copy on the next progress sync.
      writeQuestionWrittenDraft(questionKey, "");
      setSaveError("");
    } catch {
      setSaveError("Не удалось очистить сохранённый черновик");
      return;
    }
    setAnswer("");
    setResult(null);
    setError("");
    focusTextarea();
  };

  const summary = result
    ? `Последний результат: ${result.score} из 25`
    : answer.trim()
      ? saveError || "Черновик сохранён"
      : "Ответь своими словами · проверка 0–25";
  const rootClassName = ["question-written-practice", open && "question-written-practice--open", className]
    .filter(Boolean)
    .join(" ");

  return <section className={rootClassName} aria-label={`Письменный ответ на вопрос: ${question}`}>
    <button
      type="button"
      className="question-written-practice__toggle"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="question-written-practice__toggle-copy">
        <span className="question-written-practice__title">Письменный ответ</span>
        <span className="question-written-practice__summary">{summary}</span>
      </span>
      <span className="question-written-practice__toggle-icon" aria-hidden="true">{open ? "−" : "+"}</span>
    </button>

    <div id={panelId} className="question-written-practice__panel" hidden={!open} aria-busy={loading}>
      {contextLabel && <p className="question-written-practice__context">{contextLabel}</p>}
      <p className="question-written-practice__question"><span>Экзаменационный вопрос</span>{question}</p>
      <label className="question-written-practice__label" htmlFor={textareaId}>Твой развёрнутый ответ</label>
      <textarea
        ref={textareaRef}
        id={textareaId}
        className="question-written-practice__textarea"
        value={answer}
        maxLength={QUESTION_WRITTEN_ANSWER_MAX_LENGTH}
        rows={9}
        disabled={loading}
        aria-describedby={`${hintId} ${counterId}`}
        placeholder="Дай определение, раскрой основные пункты, приведи пример и сделай вывод…"
        onChange={(event) => updateAnswer(event.target.value)}
      />
      <div className="question-written-practice__meta">
        <p id={hintId}>{answer.length > QUESTION_WRITTEN_ANSWER_MAX_LENGTH
          ? `Сократи ответ до ${QUESTION_WRITTEN_ANSWER_MAX_LENGTH} символов`
          : answer.trim().length < 20
            ? "Для проверки нужно минимум 20 символов"
            : saveError || "Черновик сохранён автоматически"}</p>
        <span id={counterId}>{answer.length}/{QUESTION_WRITTEN_ANSWER_MAX_LENGTH}</span>
      </div>
      {saveError && <p className="question-written-practice__save-error" role="alert">{saveError}</p>}

      {!result && <button
        type="button"
        className="question-written-practice__check"
        disabled={answer.trim().length < 20 || answer.length > QUESTION_WRITTEN_ANSWER_MAX_LENGTH || loading}
        onClick={() => void check()}
      >
        {loading ? "Проверяю ответ…" : "Проверить по шкале 0–25"}
      </button>}
      {loading && <p className="question-written-practice__status" role="status" aria-live="polite">Сравниваю ответ с критериями экзамена…</p>}
      {error && <p className="question-written-practice__error" role="alert">{error}</p>}

      {result && <div className="question-written-practice__feedback" role="status" aria-live="polite">
        <p>Результат проверки</p>
        <h3 ref={resultHeadingRef} tabIndex={-1}>{result.score}<span>/25</span></h3>
        <strong>{result.level}</strong>
        <p>{result.summary}</p>
        {result.strengths.length > 0 && <section><h4>Что уже хорошо</h4><ul>{result.strengths.map((item) => <li key={item}>{item}</li>)}</ul></section>}
        {result.missing.length > 0 && <section><h4>Чего не хватает</h4><ul>{result.missing.map((item) => <li key={item}>{item}</li>)}</ul></section>}
        {result.improvedAnswer && <details><summary>Показать пример сильного ответа</summary><p>{result.improvedAnswer}</p></details>}
        <div className="question-written-practice__actions">
          <button type="button" onClick={improve}>Улучшить ответ</button>
          <button type="button" onClick={restart}>Начать заново</button>
        </div>
      </div>}
    </div>
  </section>;
}

export function QuestionWrittenPractice(props: QuestionWrittenPracticeProps) {
  // A remount isolates request/result state and loads the matching shared draft.
  return <QuestionWrittenPracticeEditor key={props.questionKey} {...props}/>;
}

export default QuestionWrittenPractice;
