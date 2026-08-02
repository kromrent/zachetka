export const QUESTION_FOLLOWUPS_STORAGE_KEY = "exam-lecture-followups";
export const QUESTION_FOLLOWUPS_CHANGED_EVENT = "exam-question-followups-changed";
export const QUESTION_FOLLOWUP_MAX_LENGTH = 2_000;

export type SavedQuestionFollowUp = {
  id: string;
  trackId: string;
  subject: string;
  section: string;
  originalQuestion: string;
  question: string;
  answer: string;
  createdAt: string;
  questionKey?: string;
  source?: "audio" | "textbook";
};

export type QuestionFollowUpsChangedDetail = {
  items: SavedQuestionFollowUp[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseQuestionFollowUps = (value: unknown): SavedQuestionFollowUp[] => {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value || "[]") : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedQuestionFollowUp => isRecord(item)
      && typeof item.id === "string"
      && typeof item.trackId === "string"
      && typeof item.subject === "string"
      && typeof item.section === "string"
      && typeof item.originalQuestion === "string"
      && typeof item.question === "string"
      && typeof item.answer === "string"
      && typeof item.createdAt === "string");
  } catch {
    return [];
  }
};

export const mergeQuestionFollowUpsValues = (...values: unknown[]) => {
  const unique = new Map<string, SavedQuestionFollowUp>();
  for (const value of values) {
    for (const item of parseQuestionFollowUps(value)) unique.set(item.id, item);
  }
  return JSON.stringify([...unique.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
};

export const readQuestionFollowUps = () => {
  if (typeof window === "undefined") return [];
  try {
    return parseQuestionFollowUps(window.localStorage.getItem(QUESTION_FOLLOWUPS_STORAGE_KEY));
  } catch {
    return [];
  }
};

export const writeQuestionFollowUps = (items: SavedQuestionFollowUp[]) => {
  if (typeof window === "undefined") throw new Error("Хранилище недоступно");
  window.localStorage.setItem(QUESTION_FOLLOWUPS_STORAGE_KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent<QuestionFollowUpsChangedDetail>(QUESTION_FOLLOWUPS_CHANGED_EVENT, {
    detail: { items }
  }));
};
