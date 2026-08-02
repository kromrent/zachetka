import { useEffect, useId, useRef, useState } from "react";
import { QUESTION_NOTES_OWNER_KEY } from "./QuestionNotes";
import {
  QUESTION_FOLLOWUP_MAX_LENGTH,
  QUESTION_FOLLOWUPS_CHANGED_EVENT,
  QUESTION_FOLLOWUPS_STORAGE_KEY,
  readQuestionFollowUps,
  writeQuestionFollowUps,
  type QuestionFollowUpsChangedDetail,
  type SavedQuestionFollowUp
} from "./question-followups";

type TextbookFollowUpsProps = {
  contextId: string;
  subject: string;
  section: string;
  originalQuestion: string;
  contextTitle: string;
  questionKey?: string;
  onSaved?: () => void | Promise<unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readProgressOwner = () => {
  try {
    return localStorage.getItem(QUESTION_NOTES_OWNER_KEY);
  } catch {
    return null;
  }
};

const responseErrorMessage = (status: number, body: unknown) => {
  if (status === 401) return "Войди в аккаунт, чтобы задать вопрос";
  if (status === 429) return "Слишком много запросов. Подожди минуту и попробуй снова";
  if (status === 503) return "Текстовые уточнения пока недоступны";
  if (isRecord(body) && typeof body.error === "string") return body.error;
  return "Не удалось получить ответ";
};

const savedSummary = (count: number) => {
  const lastTwo = count % 100;
  const last = count % 10;
  if (last === 1 && lastTwo !== 11) return `${count} уточнение сохранено`;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${count} уточнения сохранены`;
  return `${count} уточнений сохранено`;
};

function TextbookFollowUpsEditor({
  contextId,
  subject,
  section,
  originalQuestion,
  contextTitle,
  questionKey,
  onSaved
}: TextbookFollowUpsProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SavedQuestionFollowUp[]>(readQuestionFollowUps);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [latestAnswerId, setLatestAnswerId] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const latestAnswerRef = useRef<HTMLElement>(null);
  const onSavedRef = useRef(onSaved);
  const generatedId = useId();
  const panelId = `${generatedId}-textbook-followups-panel`;
  const textareaId = `${generatedId}-textbook-followups-question`;
  const hintId = `${generatedId}-textbook-followups-hint`;
  const counterId = `${generatedId}-textbook-followups-counter`;

  onSavedRef.current = onSaved;
  const currentItems = items.filter((item) => item.trackId === contextId);

  // Do not abort a paid request merely because the user moves to the next
  // chapter. Let it finish and save the answer; only skip updates to unmounted UI.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const applyStoredItems = () => setItems(readQuestionFollowUps());
    const onStorage = (event: StorageEvent) => {
      if (event.key === QUESTION_FOLLOWUPS_STORAGE_KEY) applyStoredItems();
    };
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<QuestionFollowUpsChangedDetail>).detail;
      if (Array.isArray(detail?.items)) setItems(detail.items);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(QUESTION_FOLLOWUPS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(QUESTION_FOLLOWUPS_CHANGED_EVENT, onChanged);
    };
  }, []);

  useEffect(() => {
    if (!latestAnswerId) return;
    latestAnswerRef.current?.focus({ preventScroll: true });
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    latestAnswerRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
  }, [latestAnswerId]);

  const ask = async () => {
    const followUp = draft.trim();
    if (followUp.length < 3 || loading || requestRef.current) return;
    const ownerAtStart = readProgressOwner();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    setSaveError("");
    setLatestAnswerId("");
    try {
      const response = await fetch("/api/lectures/follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ originalQuestion, followUp }),
        signal: controller.signal
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(responseErrorMessage(response.status, body));
      if (!isRecord(body) || typeof body.answer !== "string" || !body.answer.trim()) {
        throw new Error("Сервис вернул пустой ответ");
      }
      if (controller.signal.aborted || requestRef.current !== controller) return;
      // The paid request may outlive this screen. Never attach an answer started
      // by one account to another account that signed in while it was running.
      if (readProgressOwner() !== ownerAtStart) {
        if (mountedRef.current) setError("Аккаунт изменился во время запроса. Ответ не был сохранён — задай вопрос ещё раз");
        return;
      }

      const item: SavedQuestionFollowUp = {
        id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        trackId: contextId,
        subject,
        section,
        originalQuestion,
        question: followUp,
        answer: body.answer.trim(),
        createdAt: new Date().toISOString(),
        questionKey,
        source: "textbook"
      };
      const storedItems = readQuestionFollowUps();
      const nextItems = [item, ...storedItems.filter((saved) => saved.id !== item.id)];
      if (mountedRef.current) {
        setItems(nextItems);
        setDraft("");
        setLatestAnswerId(item.id);
      }
      try {
        writeQuestionFollowUps(nextItems);
        if (mountedRef.current) setSaveError("");
        try {
          void Promise.resolve(onSavedRef.current?.()).catch(() => undefined);
        } catch {
          // The regular account sync timer will make another attempt.
        }
      } catch {
        if (mountedRef.current) setSaveError("Ответ получен, но сохранить его на этом устройстве не удалось");
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      const message = caught instanceof Error ? caught.message : "";
      if (mountedRef.current) setError(message === "Failed to fetch" ? "Нет связи с сервером. Проверь интернет и попробуй снова" : message || "Уточнение сейчас недоступно");
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (mountedRef.current) setLoading(false);
      }
    }
  };

  const summary = currentItems.length > 0
    ? savedSummary(currentItems.length)
    : "Короткий текстовый ответ · сохранится в аккаунте";
  const answerCard = (item: SavedQuestionFollowUp) => <article
    key={item.id}
    ref={item.id === latestAnswerId ? latestAnswerRef : undefined}
    tabIndex={item.id === latestAnswerId ? -1 : undefined}
    className="textbook-followups__answer"
  >
    <strong>Ты: {item.question}</strong>
    <p>{item.answer}</p>
    <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("ru-RU")}</time>
  </article>;

  return <section className={`textbook-followups ${open ? "textbook-followups--open" : ""}`} aria-label={`Уточнения по теме: ${originalQuestion}`}>
    <button
      type="button"
      className="textbook-followups__toggle"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="textbook-followups__toggle-copy">
        <span className="textbook-followups__title">Задать вопрос по теме</span>
        <span className="textbook-followups__summary">{summary}</span>
      </span>
      <span className="textbook-followups__toggle-icon" aria-hidden="true">{open ? "−" : "+"}</span>
    </button>

    <div id={panelId} className="textbook-followups__panel" hidden={!open} aria-busy={loading}>
      <p className="textbook-followups__context"><span>{contextTitle}</span>{originalQuestion}</p>
      <label className="textbook-followups__label" htmlFor={textareaId}>Твой уточняющий вопрос</label>
      <textarea
        id={textareaId}
        className="textbook-followups__textarea"
        value={draft}
        maxLength={QUESTION_FOLLOWUP_MAX_LENGTH}
        rows={5}
        disabled={loading}
        aria-describedby={`${hintId} ${counterId}`}
        placeholder="Например: чем этот метод отличается от другого и когда его применяют?"
        onChange={(event) => {
          setDraft(event.target.value);
          setError("");
        }}
      />
      <div className="textbook-followups__meta">
        <p id={hintId}>{draft.trim().length < 3 ? "Напиши хотя бы 3 символа" : "Ответ будет текстовым и сохранится после получения"}</p>
        <span id={counterId}>{draft.length}/{QUESTION_FOLLOWUP_MAX_LENGTH}</span>
      </div>
      <button type="button" className="textbook-followups__submit" disabled={loading || draft.trim().length < 3} onClick={() => void ask()}>
        {loading ? "Ищу точный ответ…" : "Получить текстовый ответ"}
      </button>
      {loading && <p className="textbook-followups__status" role="status" aria-live="polite">Формирую короткое объяснение по теме…</p>}
      {error && <p className="textbook-followups__error" role="alert">{error}</p>}
      {saveError && <p className="textbook-followups__error" role="alert">{saveError}</p>}
      <small className="textbook-followups__note">AI видит вопрос, название и краткое содержание главы, но не весь текст. Сформулируй непонятное полностью. Каждый новый вопрос — отдельный запрос; аудио не создаётся.</small>

      {currentItems.length > 0 && <div className="textbook-followups__history">
        <h4>Уточнения к этой главе</h4>
        {currentItems.slice(0, 5).map(answerCard)}
        {currentItems.length > 5 && <details className="textbook-followups__older">
          <summary>Показать ещё {currentItems.length - 5}</summary>
          <div>{currentItems.slice(5).map(answerCard)}</div>
        </details>}
      </div>}
    </div>
  </section>;
}

export function TextbookFollowUps(props: TextbookFollowUpsProps) {
  return <TextbookFollowUpsEditor key={props.contextId} {...props}/>;
}

export default TextbookFollowUps;
