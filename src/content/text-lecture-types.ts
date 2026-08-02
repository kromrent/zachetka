export type TextLectureBlock = {
  kind: "text" | "definition" | "analogy" | "example" | "steps" | "important" | "recap";
  title?: string;
  paragraphs?: string[];
  items?: string[];
};

export type TextLectureChapter = {
  id: string;
  title: string;
  eyebrow: string;
  summary: string;
  questionKey?: string;
  examQuestion?: string;
  blocks: TextLectureBlock[];
};

export type TextLectureCourse = {
  id: string;
  subject: string;
  section: string;
  title: string;
  description: string;
  estimatedMinutes: number;
  chapters: TextLectureChapter[];
  glossary: Array<{ term: string; definition: string }>;
};
