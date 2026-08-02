import { useEffect, useId, useMemo, useRef, useState } from "react";
import QuestionMiniQuiz from "./QuestionMiniQuiz";
import QuestionNotes from "./QuestionNotes";
import type { TextLectureBlock, TextLectureCourse } from "./content/text-lecture-types";
import {
  defaultTextLectureCourse,
  getTextLectureCourse,
  TEXT_LECTURE_SELECTED_COURSE_STORAGE_KEY,
  textLectureCourses
} from "./content/text-lecture-courses";
import {
  parseTextLectureProgressStore,
  TEXT_LECTURE_PROGRESS_CHANGED_EVENT,
  TEXT_LECTURE_PROGRESS_STORAGE_KEY,
  type TextLectureCourseProgress,
  type TextLectureProgressStore
} from "./text-lecture-progress";

export { TEXT_LECTURE_PROGRESS_CHANGED_EVENT, TEXT_LECTURE_PROGRESS_STORAGE_KEY } from "./text-lecture-progress";
export { TEXT_LECTURE_SELECTED_COURSE_STORAGE_KEY } from "./content/text-lecture-courses";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeCourseProgress = (
  value: unknown,
  course: TextLectureCourse
): TextLectureCourseProgress => {
  const chapterIds = new Set(course.chapters.map((chapter) => chapter.id));
  const fallbackChapterId = course.chapters[0]?.id || "";
  if (!isRecord(value)) {
    return { currentChapterId: fallbackChapterId, completedChapterIds: [], updatedAt: "" };
  }

  const currentChapterId = typeof value.currentChapterId === "string" && chapterIds.has(value.currentChapterId)
    ? value.currentChapterId
    : fallbackChapterId;
  const completedChapterIds = Array.isArray(value.completedChapterIds)
    ? [...new Set(value.completedChapterIds.filter((id): id is string => typeof id === "string" && chapterIds.has(id)))]
    : [];

  return {
    currentChapterId,
    completedChapterIds,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
  };
};

const readProgressStore = (): TextLectureProgressStore => {
  if (typeof window === "undefined") return {};
  try {
    return parseTextLectureProgressStore(window.localStorage.getItem(TEXT_LECTURE_PROGRESS_STORAGE_KEY));
  } catch {
    return {};
  }
};

const readCourseProgress = (course: TextLectureCourse) =>
  normalizeCourseProgress(readProgressStore()[course.id], course);

const writeCourseProgress = (course: TextLectureCourse, progress: TextLectureCourseProgress) => {
  if (typeof window === "undefined") return;
  const store = readProgressStore();
  store[course.id] = progress;
  window.localStorage.setItem(TEXT_LECTURE_PROGRESS_STORAGE_KEY, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent(TEXT_LECTURE_PROGRESS_CHANGED_EVENT, {
    detail: { courseId: course.id, progress }
  }));
};

const readSelectedCourseId = () => {
  if (typeof window === "undefined") return defaultTextLectureCourse.id;
  try {
    return getTextLectureCourse(
      window.localStorage.getItem(TEXT_LECTURE_SELECTED_COURSE_STORAGE_KEY)
    ).id;
  } catch {
    return defaultTextLectureCourse.id;
  }
};

const blockDefaultTitle: Record<TextLectureBlock["kind"], string> = {
  text: "",
  definition: "Определение простыми словами",
  analogy: "Понятная аналогия",
  example: "Пример",
  steps: "Как это работает по шагам",
  important: "Важно понять",
  recap: "Что нужно запомнить"
};

function TextLectureContentBlock({ block }: { block: TextLectureBlock }) {
  const title = block.title || blockDefaultTitle[block.kind];
  const isSteps = block.kind === "steps";
  const Tag = block.kind === "text" ? "section" : "aside";

  return <Tag className={`section-text-lecture__block section-text-lecture__block--${block.kind}`}>
    {title && <h3>{title}</h3>}
    {block.paragraphs?.map((paragraph, index) => <p key={`paragraph-${index}`}>{paragraph}</p>)}
    {block.items && block.items.length > 0 && (isSteps
      ? <ol>{block.items.map((item, index) => <li key={`step-${index}`}>{item}</li>)}</ol>
      : <ul>{block.items.map((item, index) => <li key={`item-${index}`}>{item}</li>)}</ul>)}
  </Tag>;
}

export function SectionTextLecture() {
  const [selectedCourseId, setSelectedCourseId] = useState(readSelectedCourseId);
  const course = getTextLectureCourse(selectedCourseId);
  const [progress, setProgress] = useState<TextLectureCourseProgress>(() => readCourseProgress(course));
  const [contentsOpen, setContentsOpen] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [selectionSaveError, setSelectionSaveError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const initialChapterRef = useRef(progress.currentChapterId);
  const coursePickerHeadingId = `${useId()}-text-lecture-courses`;
  const contentsId = `${useId()}-text-lecture-contents`;
  const glossaryId = `${useId()}-text-lecture-glossary`;

  const chapterIndex = Math.max(0, course.chapters.findIndex((chapter) => chapter.id === progress.currentChapterId));
  const chapter = course.chapters[chapterIndex] || course.chapters[0];
  const completedIds = useMemo(() => new Set(progress.completedChapterIds), [progress.completedChapterIds]);
  const completedCount = completedIds.size;
  const chapterCompleted = chapter ? completedIds.has(chapter.id) : false;
  const completionPercent = course.chapters.length > 0
    ? Math.round(completedCount / course.chapters.length * 100)
    : 0;

  const saveProgress = (next: TextLectureCourseProgress) => {
    setProgress(next);
    try {
      writeCourseProgress(course, next);
      setSaveError("");
    } catch {
      setSaveError("Не удалось сохранить прогресс на этом устройстве");
    }
  };

  const selectCourse = (nextCourseId: string, persistSelection = true) => {
    const nextCourse = getTextLectureCourse(nextCourseId);
    if (nextCourse.id !== course.id) {
      setSelectedCourseId(nextCourse.id);
      setProgress(readCourseProgress(nextCourse));
      setContentsOpen(false);
      setSaveError("");
      initialChapterRef.current = "";
    }

    if (!persistSelection || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(TEXT_LECTURE_SELECTED_COURSE_STORAGE_KEY, nextCourse.id);
      setSelectionSaveError("");
    } catch {
      setSelectionSaveError("Раздел открыт, но запомнить выбор на этом устройстве не получилось");
    }
  };

  const openChapter = (nextIndex: number) => {
    const nextChapter = course.chapters[nextIndex];
    if (!nextChapter) return;
    setContentsOpen(false);
    saveProgress({
      ...progress,
      currentChapterId: nextChapter.id,
      updatedAt: new Date().toISOString()
    });
  };

  const markChapterCompleted = () => {
    if (!chapter) return;
    saveProgress({
      currentChapterId: chapter.id,
      completedChapterIds: chapterCompleted
        ? progress.completedChapterIds
        : [...progress.completedChapterIds, chapter.id],
      updatedAt: new Date().toISOString()
    });
  };

  useEffect(() => {
    if (!chapter || initialChapterRef.current === chapter.id) {
      initialChapterRef.current = "";
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    headingRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }, [chapter]);

  useEffect(() => {
    const applyStoredProgress = () => {
      const stored = readCourseProgress(course);
      setProgress((current) => {
        const storedAt = Date.parse(stored.updatedAt) || 0;
        const currentAt = Date.parse(current.updatedAt) || 0;
        return storedAt > currentAt ? stored : current;
      });
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === TEXT_LECTURE_PROGRESS_STORAGE_KEY) applyStoredProgress();
    };
    const onProgressChanged = () => applyStoredProgress();
    window.addEventListener("storage", onStorage);
    window.addEventListener(TEXT_LECTURE_PROGRESS_CHANGED_EVENT, onProgressChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(TEXT_LECTURE_PROGRESS_CHANGED_EVENT, onProgressChanged);
    };
  }, [course]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(TEXT_LECTURE_SELECTED_COURSE_STORAGE_KEY) !== course.id) {
        window.localStorage.setItem(TEXT_LECTURE_SELECTED_COURSE_STORAGE_KEY, course.id);
      }
      setSelectionSaveError("");
    } catch {
      setSelectionSaveError("Выбранный раздел не получится запомнить на этом устройстве");
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== TEXT_LECTURE_SELECTED_COURSE_STORAGE_KEY) return;
      selectCourse(getTextLectureCourse(event.newValue).id, false);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [course.id]);

  if (!chapter) {
    return <section className="section-text-lecture section-text-lecture--empty">
      <h2>Текстовая лекция пока пуста</h2>
      <p>Главы появятся после добавления учебного материала.</p>
    </section>;
  }

  const question = chapter.examQuestion || chapter.title;
  const contextLabel = `${course.subject} · ${course.section}`;

  return <section className="section-text-lecture" aria-label={course.title}>
    <section className="section-text-lecture__course-picker" aria-labelledby={coursePickerHeadingId}>
      <header>
        <p>Текстовые лекции</p>
        <h2 id={coursePickerHeadingId}>Выбери раздел</h2>
      </header>
      <div className="section-text-lecture__course-options">
        {textLectureCourses.map((item) => {
          const selected = item.id === course.id;
          return <button
            type="button"
            key={item.id}
            className={selected ? "is-selected" : ""}
            aria-pressed={selected}
            onClick={() => selectCourse(item.id)}
          >
            <span><small>{item.subject}</small><strong>{item.section}</strong></span>
            <span className="section-text-lecture__course-option-meta">
              <small>{item.chapters.length} глав · ≈ {item.estimatedMinutes} минут</small>
              <b aria-hidden="true">{selected ? "Открыт" : "Выбрать →"}</b>
            </span>
          </button>;
        })}
      </div>
      {selectionSaveError && <p className="section-text-lecture__selection-error" role="status">{selectionSaveError}</p>}
    </section>

    <header className="section-text-lecture__hero">
      <p className="section-text-lecture__eyebrow">Подробный курс с нуля</p>
      <h2>{course.title}</h2>
      <p>{course.description}</p>
      <div className="section-text-lecture__meta">
        <span>{course.chapters.length} глав</span>
        <span>≈ {course.estimatedMinutes} минут чтения</span>
        <span>{completedCount} прочитано</span>
      </div>
      <div className="section-text-lecture__course-progress">
        <div><span>Прогресс курса</span><strong>{completionPercent}%</strong></div>
        <progress value={completedCount} max={Math.max(course.chapters.length, 1)} aria-label={`Прочитано ${completedCount} из ${course.chapters.length} глав`}/>
      </div>
    </header>

    <div className="section-text-lecture__contents">
      <button
        type="button"
        className="section-text-lecture__contents-toggle"
        aria-expanded={contentsOpen}
        aria-controls={contentsId}
        onClick={() => setContentsOpen((open) => !open)}
      >
        <span><strong>Оглавление</strong><small>Глава {chapterIndex + 1} из {course.chapters.length}</small></span>
        <b aria-hidden="true">{contentsOpen ? "−" : "+"}</b>
      </button>
      <nav id={contentsId} aria-label="Оглавление текстовой лекции" hidden={!contentsOpen}>
        {course.chapters.map((item, index) => <button
          type="button"
          key={item.id}
          className={item.id === chapter.id ? "is-current" : ""}
          aria-current={item.id === chapter.id ? "step" : undefined}
          onClick={() => openChapter(index)}
        >
          <span>{completedIds.has(item.id) ? "✓" : index + 1}</span>
          <span><small>{item.eyebrow}</small><strong>{item.title}</strong></span>
        </button>)}
      </nav>
    </div>

    <article className="section-text-lecture__chapter" aria-labelledby={`${chapter.id}-title`}>
      <header>
        <p className="section-text-lecture__chapter-count">Глава {chapterIndex + 1} из {course.chapters.length}</p>
        <p className="section-text-lecture__chapter-eyebrow">{chapter.eyebrow}</p>
        <h2 id={`${chapter.id}-title`} ref={headingRef} tabIndex={-1}>{chapter.title}</h2>
        <p className="section-text-lecture__chapter-summary">{chapter.summary}</p>
      </header>

      {chapter.examQuestion && <aside className="section-text-lecture__exam-question">
        <span>Связанный вопрос экзамена</span>
        <p>{chapter.examQuestion}</p>
      </aside>}

      <div className="section-text-lecture__reading">
        {chapter.blocks.map((block, index) => <TextLectureContentBlock block={block} key={`${chapter.id}-${block.kind}-${index}`}/>)}
      </div>

      <div className={`section-text-lecture__complete ${chapterCompleted ? "is-complete" : ""}`}>
        <div>
          <strong>{chapterCompleted ? "Глава прочитана" : "Закончил эту главу?"}</strong>
          <p>{chapterCompleted
            ? saveError ? "Отметка видна сейчас, но сохранить её не получилось." : "Отметка сохранена в твоём прогрессе."
            : "Отметь её вручную — простое открытие главы не считается изучением."}</p>
          {saveError && <p className="section-text-lecture__save-error" role="alert">{saveError}</p>}
        </div>
        <button type="button" disabled={chapterCompleted && !saveError} onClick={markChapterCompleted}>
          {saveError ? "Повторить сохранение" : chapterCompleted ? "✓ Прочитано" : "Глава прочитана"}
        </button>
      </div>

      {chapter.questionKey && <section className="section-text-lecture__practice" aria-label="Материалы для закрепления главы">
        <h3>Закрепить материал</h3>
        <p>Запиши важные мысли или проверь понимание коротким тестом.</p>
        <QuestionNotes questionKey={chapter.questionKey} question={question} contextLabel={contextLabel}/>
        <QuestionMiniQuiz questionKey={chapter.questionKey} question={question} contextLabel={contextLabel}/>
      </section>}
    </article>

    <nav className="section-text-lecture__chapter-nav" aria-label="Переход между главами">
      <button type="button" disabled={chapterIndex === 0} onClick={() => openChapter(chapterIndex - 1)}>
        <span>← Предыдущая</span>
        <strong>{course.chapters[chapterIndex - 1]?.title || "Это первая глава"}</strong>
      </button>
      <button type="button" disabled={chapterIndex === course.chapters.length - 1} onClick={() => openChapter(chapterIndex + 1)}>
        <span>Следующая →</span>
        <strong>{course.chapters[chapterIndex + 1]?.title || "Курс завершён"}</strong>
      </button>
    </nav>

    <details className="section-text-lecture__glossary" id={glossaryId}>
      <summary><span><strong>Словарь терминов</strong><small>{course.glossary.length} понятий простым языком</small></span><b aria-hidden="true">+</b></summary>
      <dl>{course.glossary.map(({ term, definition }) => <div key={term}><dt>{term}</dt><dd>{definition}</dd></div>)}</dl>
    </details>
  </section>;
}

export default SectionTextLecture;
