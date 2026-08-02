export const QUESTION_WRITTEN_DRAFT_PREFIX = "exam-written-draft-";
export const QUESTION_WRITTEN_DRAFT_CHANGED_EVENT = "exam-written-draft-changed";
export const QUESTION_WRITTEN_ANSWER_MAX_LENGTH = 12_000;

export type WrittenDraftChangedDetail = {
  questionKey: string;
  answer: string;
};

const canonicalQuestionKeyPattern = /^([a-z0-9_-]+):(\d+)-(\d+)$/i;

export const getQuestionWrittenDraftStorageKey = (questionKey: string) => {
  const match = canonicalQuestionKeyPattern.exec(questionKey);
  if (!match) throw new Error(`Некорректный ключ экзаменационного вопроса: ${questionKey}`);
  return `${QUESTION_WRITTEN_DRAFT_PREFIX}${match[1]}-${match[2]}-${match[3]}`;
};

export const readQuestionWrittenDraft = (questionKey: string) => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(getQuestionWrittenDraftStorageKey(questionKey)) || "";
  } catch {
    return "";
  }
};

export const writeQuestionWrittenDraft = (questionKey: string, answer: string) => {
  if (typeof window === "undefined") throw new Error("Хранилище недоступно");
  window.localStorage.setItem(getQuestionWrittenDraftStorageKey(questionKey), answer);
  window.dispatchEvent(new CustomEvent<WrittenDraftChangedDetail>(QUESTION_WRITTEN_DRAFT_CHANGED_EVENT, {
    detail: { questionKey, answer }
  }));
};
