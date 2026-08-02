import {
  productionOrganizationFoundationsChapters,
  productionOrganizationFoundationsGlossary
} from "./production-organization-foundations";
import {
  productionOrganizationOptimizationChapters,
  productionOrganizationOptimizationGlossary
} from "./production-organization-optimization";
import type { TextLectureCourse } from "./text-lecture-types";

export const productionOrganizationCourse: TextLectureCourse = {
  id: "management-production-organization-v1",
  subject: "Организация цифрового производства",
  section: "Организация и оптимизация производства",
  title: "Организация и оптимизация производства с нуля",
  description: "Полный путь от устройства машиностроительного производства, производственного цикла и оперативного управления до логистики, Lean, расчёта эффективности, сетевого планирования и имитационного моделирования. Понятия вводятся последовательно и связываются в одну работающую систему.",
  estimatedMinutes: 260,
  chapters: [
    ...productionOrganizationFoundationsChapters,
    ...productionOrganizationOptimizationChapters
  ],
  glossary: [
    ...productionOrganizationFoundationsGlossary,
    ...productionOrganizationOptimizationGlossary
  ]
};
