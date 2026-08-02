export const TEXT_LECTURE_PROGRESS_STORAGE_KEY = "exam-text-lecture-progress";
export const TEXT_LECTURE_PROGRESS_CHANGED_EVENT = "exam-text-lecture-progress-changed";

export type TextLectureCourseProgress = {
  currentChapterId: string;
  completedChapterIds: string[];
  updatedAt: string;
};

export type TextLectureProgressStore = Record<string, TextLectureCourseProgress>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseTextLectureProgressStore = (value: unknown): TextLectureProgressStore => {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value || "{}") : value;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([courseId, raw]) => {
      if (!courseId || !isRecord(raw) || typeof raw.currentChapterId !== "string" || typeof raw.updatedAt !== "string") return [];
      const completedChapterIds = Array.isArray(raw.completedChapterIds)
        ? [...new Set(raw.completedChapterIds.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 500)
        : [];
      return [[courseId, {
        currentChapterId: raw.currentChapterId,
        completedChapterIds,
        updatedAt: raw.updatedAt
      } satisfies TextLectureCourseProgress]];
    }));
  } catch {
    return {};
  }
};

export const mergeTextLectureProgressValues = (...values: unknown[]) => {
  const merged: TextLectureProgressStore = {};
  for (const value of values) {
    for (const [courseId, candidate] of Object.entries(parseTextLectureProgressStore(value))) {
      const saved = merged[courseId];
      if (!saved) {
        merged[courseId] = candidate;
        continue;
      }
      const savedAt = Date.parse(saved.updatedAt) || 0;
      const candidateAt = Date.parse(candidate.updatedAt) || 0;
      const newest = candidateAt >= savedAt ? candidate : saved;
      merged[courseId] = {
        currentChapterId: newest.currentChapterId,
        completedChapterIds: [...new Set([...saved.completedChapterIds, ...candidate.completedChapterIds])],
        updatedAt: newest.updatedAt
      };
    }
  }
  return JSON.stringify(merged);
};
