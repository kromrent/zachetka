export type ListeningRange = [number, number];

export const LISTENING_RANGE_MERGE_TOLERANCE_SECONDS = 0.5;

type RangeLike = ListeningRange | readonly [number, number] | null | undefined;

export type LegacyListeningProgress = {
  listenedRanges?: readonly RangeLike[] | null;
  listenedSeconds?: number | null;
  positionSeconds?: number | null;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validDuration(duration: number): number {
  const value = finiteNumber(duration);
  return value !== null && value > 0 ? value : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Clamps, sorts and merges listened ranges.
 *
 * Tiny gaps are merged because media time updates are not emitted continuously
 * and would otherwise make actually continuous listening look fragmented.
 */
export function normalizeListeningRanges(
  ranges: readonly RangeLike[] | null | undefined,
  duration: number,
  toleranceSeconds = LISTENING_RANGE_MERGE_TOLERANCE_SECONDS,
): ListeningRange[] {
  const maximum = validDuration(duration);
  if (maximum === 0 || !ranges?.length) {
    return [];
  }

  const tolerance = Math.max(0, finiteNumber(toleranceSeconds) ?? 0);
  const normalized: ListeningRange[] = [];

  for (const range of ranges) {
    if (!range || range.length < 2) {
      continue;
    }

    const rawStart = finiteNumber(range[0]);
    const rawEnd = finiteNumber(range[1]);
    if (rawStart === null || rawEnd === null) {
      continue;
    }

    const start = clamp(rawStart, 0, maximum);
    const end = clamp(rawEnd, 0, maximum);
    if (end <= start) {
      continue;
    }

    normalized.push([start, end]);
  }

  normalized.sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  const merged: ListeningRange[] = [];
  for (const [start, end] of normalized) {
    const previous = merged[merged.length - 1];
    if (!previous || start > previous[1] + tolerance) {
      merged.push([start, end]);
      continue;
    }

    previous[1] = Math.max(previous[1], end);
  }

  return merged;
}

export const mergeListeningRanges = normalizeListeningRanges;

export function totalUniqueSeconds(
  ranges: readonly RangeLike[] | null | undefined,
  duration: number,
): number {
  return normalizeListeningRanges(ranges, duration).reduce(
    (total, [start, end]) => total + end - start,
    0,
  );
}

/**
 * Converts the old cumulative counter into one best-effort interval.
 *
 * A single interval is deliberately conservative: legacy data cannot tell
 * whether the same part was replayed, so it must not be represented as several
 * independently listened ranges.
 */
export function migrateLegacyRanges(
  progress: LegacyListeningProgress,
  duration: number,
): ListeningRange[] {
  const maximum = validDuration(duration);
  if (maximum === 0) {
    return [];
  }

  if (Array.isArray(progress.listenedRanges)) {
    return normalizeListeningRanges(progress.listenedRanges, maximum);
  }

  const legacyListenedSeconds = clamp(
    Math.max(0, finiteNumber(progress.listenedSeconds) ?? 0),
    0,
    maximum,
  );
  if (legacyListenedSeconds === 0) {
    return [];
  }

  const savedPosition = clamp(
    finiteNumber(progress.positionSeconds) ?? legacyListenedSeconds,
    0,
    maximum,
  );
  // The old counter could include repeated listening of the same beginning.
  // A position smaller than that counter is the only evidence we have about
  // the unique part, so never migrate more than the current position.
  const listenedSeconds = savedPosition > 0
    ? Math.min(legacyListenedSeconds, savedPosition)
    : legacyListenedSeconds;
  const end = savedPosition > 0 ? savedPosition : listenedSeconds;

  return [[end - listenedSeconds, end]];
}

export function addListenedRange(
  existing: readonly RangeLike[] | null | undefined,
  start: number,
  end: number,
  duration: number,
): ListeningRange[] {
  return normalizeListeningRanges(
    [...(existing ?? []), [start, end]],
    duration,
  );
}
