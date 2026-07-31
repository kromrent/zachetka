import { useCallback, useEffect, useId, useRef, useState } from "react";

export const QUESTION_NOTES_STORAGE_KEY = "exam-question-notes";
export const QUESTION_NOTES_OWNER_KEY = "zachetka-question-notes-owner";
export const QUESTION_NOTES_CHANGED_EVENT = "exam-question-notes-changed";
export const QUESTION_NOTE_MAX_LENGTH = 4_000;

export type QuestionNote = {
  text: string;
  question: string;
  contextLabel?: string;
  updatedAt: string;
};

export type QuestionNotesStore = Record<string, QuestionNote>;

export type QuestionNotesChangedDetail = {
  questionKey: string;
  note: QuestionNote | null;
};

export type QuestionNotesProps = {
  questionKey: string;
  question: string;
  contextLabel?: string;
  className?: string;
  onSave?: () => void | Promise<unknown>;
};

const AUTO_SAVE_DELAY_MS = 1_200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeNote = (value: unknown): QuestionNote | null => {
  // Accept plain strings as a small forward-compatible escape hatch if an early
  // local build happened to save a simpler Record<string, string> shape.
  if (typeof value === "string") {
    return value.trim()
      ? { text: value, question: "", updatedAt: "" }
      : null;
  }
  if (!isRecord(value) || typeof value.text !== "string") return null;
  return {
    text: value.text,
    question: typeof value.question === "string" ? value.question : "",
    contextLabel: typeof value.contextLabel === "string" ? value.contextLabel : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
  };
};

const parseNotesStore = (value: unknown): QuestionNotesStore => {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value || "{}") : value;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => [key, normalizeNote(value)] as const)
        .filter((entry): entry is readonly [string, QuestionNote] => entry[1] !== null)
    );
  } catch {
    return {};
  }
};

export const mergeQuestionNotesValues = (...values: unknown[]) => {
  const merged: QuestionNotesStore = {};
  for (const value of values) {
    for (const [questionKey, note] of Object.entries(parseNotesStore(value))) {
      const saved = merged[questionKey];
      const savedAt = Date.parse(saved?.updatedAt || "") || 0;
      const candidateAt = Date.parse(note.updatedAt || "") || 0;
      if (!saved || candidateAt >= savedAt) merged[questionKey] = note;
    }
  }
  return JSON.stringify(merged);
};

const readNotesStore = (): QuestionNotesStore => {
  if (typeof window === "undefined") return {};
  return parseNotesStore(window.localStorage.getItem(QUESTION_NOTES_STORAGE_KEY));
};

const readQuestionNote = (questionKey: string) => readNotesStore()[questionKey] || null;

const writeQuestionNote = ({
  questionKey,
  question,
  contextLabel,
  text
}: Pick<QuestionNotesProps, "questionKey" | "question" | "contextLabel"> & { text: string }) => {
  if (typeof window === "undefined") throw new Error("Хранилище недоступно");

  const store = readNotesStore();
  const savedText = text.trim() ? text : "";
  // Keep an empty, timestamped record as a tombstone. Otherwise a note deleted
  // on one device could be resurrected by an older copy during server merge.
  const note: QuestionNote = {
    text: savedText,
    question,
    contextLabel,
    updatedAt: new Date().toISOString()
  };
  store[questionKey] = note;

  window.localStorage.setItem(QUESTION_NOTES_STORAGE_KEY, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent<QuestionNotesChangedDetail>(QUESTION_NOTES_CHANGED_EVENT, {
    detail: { questionKey, note }
  }));

  return { note, savedText };
};

function QuestionNotesEditor({ questionKey, question, contextLabel, className, onSave }: QuestionNotesProps) {
  const initialNoteRef = useRef<QuestionNote | null>(null);
  if (initialNoteRef.current === null) initialNoteRef.current = readQuestionNote(questionKey);
  const initialNote = initialNoteRef.current;

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initialNote?.text || "");
  const [savedText, setSavedText] = useState(initialNote?.text || "");
  const [lastSavedAt, setLastSavedAt] = useState(initialNote?.updatedAt || "");
  const [saveState, setSaveState] = useState<"idle" | "saved" | "error">(
    initialNote ? "saved" : "idle"
  );
  const [saveError, setSaveError] = useState("");
  const draftRef = useRef(draft);
  const savedTextRef = useRef(savedText);
  const onSaveRef = useRef(onSave);
  const textareaId = `${useId()}-question-note`;
  const panelId = `${textareaId}-panel`;

  draftRef.current = draft;
  savedTextRef.current = savedText;
  onSaveRef.current = onSave;

  const dirty = draft !== savedText;
  const hasSavedNote = Boolean(savedText.trim());

  const saveDraft = useCallback(() => {
    if (draftRef.current === savedTextRef.current) return;
    try {
      const saved = writeQuestionNote({ questionKey, question, contextLabel, text: draftRef.current });
      draftRef.current = saved.savedText;
      savedTextRef.current = saved.savedText;
      setDraft(saved.savedText);
      setSavedText(saved.savedText);
      setLastSavedAt(saved.note?.updatedAt || new Date().toISOString());
      setSaveError("");
      setSaveState("saved");
      try {
        void Promise.resolve(onSaveRef.current?.()).catch(() => undefined);
      } catch {
        // The note is already safe in localStorage. A failed immediate server
        // sync can be retried by the application's regular progress timer.
      }
    } catch {
      setSaveError("Не удалось сохранить заметку на этом устройстве");
      setSaveState("error");
    }
  }, [contextLabel, question, questionKey]);

  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(saveDraft, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, saveDraft]);

  // Do not lose the last keystrokes when the user immediately moves to another
  // question before the debounce timer has fired.
  useEffect(() => () => {
    if (draftRef.current === savedTextRef.current) return;
    try {
      writeQuestionNote({ questionKey, question, contextLabel, text: draftRef.current });
      try {
        void Promise.resolve(onSaveRef.current?.()).catch(() => undefined);
      } catch {
        // localStorage remains the source of truth until the next sync attempt.
      }
    } catch {
      // The component is already leaving the screen; the visible save action
      // remains the place where a storage error can be communicated accessibly.
    }
  }, [contextLabel, question, questionKey]);

  useEffect(() => {
    const applyExternalValue = () => {
      if (draftRef.current !== savedTextRef.current) return;
      const note = readQuestionNote(questionKey);
      const nextText = note?.text || "";
      draftRef.current = nextText;
      savedTextRef.current = nextText;
      setDraft(nextText);
      setSavedText(nextText);
      setLastSavedAt(note?.updatedAt || "");
      setSaveState(note ? "saved" : "idle");
      setSaveError("");
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === QUESTION_NOTES_STORAGE_KEY) applyExternalValue();
    };
    const handleQuestionNotesChanged = (event: Event) => {
      const detail = (event as CustomEvent<QuestionNotesChangedDetail>).detail;
      if (detail?.questionKey === questionKey) applyExternalValue();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(QUESTION_NOTES_CHANGED_EVENT, handleQuestionNotesChanged);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(QUESTION_NOTES_CHANGED_EVENT, handleQuestionNotesChanged);
    };
  }, [questionKey]);

  const status = saveState === "error"
    ? saveError
    : dirty
      ? "Есть несохранённые изменения — они сохранятся автоматически"
      : saveState === "saved"
        ? "Сохранено"
        : "Заметка пока пустая";
  const statusKind = saveState === "error" ? "error" : dirty ? "unsaved" : saveState;
  const rootClassName = ["question-notes", open && "question-notes--open", className]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={rootClassName} aria-label={`Заметки к вопросу: ${question}`}>
      <button
        type="button"
        className="question-notes__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="question-notes__toggle-copy">
          <span className="question-notes__title">Мои заметки</span>
          <span className="question-notes__hint">
            {dirty ? "Есть изменения" : hasSavedNote ? "Есть сохранённая заметка" : "Добавить заметку"}
          </span>
        </span>
        <span className="question-notes__toggle-icon" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>

      <div className="question-notes__panel" id={panelId} hidden={!open}>
          {contextLabel && <p className="question-notes__context">{contextLabel}</p>}
          <label className="question-notes__label" htmlFor={textareaId}>Заметка к этому вопросу</label>
          <textarea
            id={textareaId}
            className="question-notes__textarea"
            value={draft}
            maxLength={QUESTION_NOTE_MAX_LENGTH}
            rows={6}
            aria-describedby={`${textareaId}-status ${textareaId}-counter`}
            placeholder="Запиши важные мысли, формулировки или то, что нужно повторить…"
            onBlur={() => {
              if (draftRef.current !== savedTextRef.current) saveDraft();
            }}
            onChange={(event) => {
              const nextDraft = event.target.value;
              // Persist every keystroke locally. The debounced save below is
              // still useful for status/onSave, while this protects the final
              // characters if a mobile PWA is killed or hydration reloads it.
              draftRef.current = nextDraft;
              setDraft(nextDraft);
              setSaveError("");
              setSaveState("idle");
              try {
                writeQuestionNote({ questionKey, question, contextLabel, text: nextDraft });
              } catch {
                setSaveError("Не удалось сохранить заметку на этом устройстве");
                setSaveState("error");
              }
            }}
          />
          <div className="question-notes__meta">
            <p
              id={`${textareaId}-status`}
              className={`question-notes__status question-notes__status--${statusKind}`}
              role="status"
              aria-live="polite"
            >
              {status}
              {!dirty && lastSavedAt && saveState === "saved" && (
                <time className="question-notes__saved-at" dateTime={lastSavedAt}>
                  {` · ${new Date(lastSavedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}`}
                </time>
              )}
            </p>
            <span id={`${textareaId}-counter`} className="question-notes__counter">
              {draft.length}/{QUESTION_NOTE_MAX_LENGTH}
            </span>
          </div>
          <div className="question-notes__actions">
            <button
              type="button"
              className="question-notes__save"
              disabled={!dirty}
              onClick={saveDraft}
            >
              Сохранить заметку
            </button>
          </div>
      </div>
    </section>
  );
}

export function QuestionNotes(props: QuestionNotesProps) {
  // Remounting the editor prevents a previous question's draft from flashing or
  // being autosaved under the next question's key when navigation changes props.
  return <QuestionNotesEditor key={props.questionKey} {...props} />;
}

export default QuestionNotes;
