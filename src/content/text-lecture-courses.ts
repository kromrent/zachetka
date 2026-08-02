import { industrialAutomationCourse } from "./industrial-automation-course";
import { productionOrganizationCourse } from "./production-organization-course";
import type { TextLectureCourse } from "./text-lecture-types";

export const TEXT_LECTURE_SELECTED_COURSE_STORAGE_KEY = "exam-text-lecture-selected-course";

export const textLectureCourses: readonly TextLectureCourse[] = [
  industrialAutomationCourse,
  productionOrganizationCourse
];

export const defaultTextLectureCourse = industrialAutomationCourse;

export const getTextLectureCourse = (courseId: unknown): TextLectureCourse =>
  typeof courseId === "string"
    ? textLectureCourses.find((course) => course.id === courseId) || defaultTextLectureCourse
    : defaultTextLectureCourse;
