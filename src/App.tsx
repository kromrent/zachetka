import { useEffect, useMemo, useRef, useState } from "react";
import { codeTasks, demoQuestions, subjects, writtenQuestions, type Question, type Subject } from "./data";
import questionBankData from "./question-bank.json";
import { addListenedRange, migrateLegacyRanges, totalUniqueSeconds, type ListeningRange } from "./listening-progress";
import { mergeQuestionNotesValues, QUESTION_NOTES_OWNER_KEY, QUESTION_NOTES_STORAGE_KEY, QuestionNotes } from "./QuestionNotes";

type Bank = { id: string; title: string; sections: { title: string; questions: string[] }[]; tasks: string[] };
const questionBanks = questionBankData as Bank[];
type SavedReference = { id: string; subject: string; section: string; question: string; answer: string; keyPoints: string[]; savedAt: string };
type TaskProgress = { id: string; task: string; code: string; score: number; level: string; completed: boolean; updatedAt: string };
type LectureProgress = { id: string; subject: string; section: string; title: string; listenedSeconds: number; listenedRanges?: ListeningRange[]; positionSeconds?: number; duration: number; percent: number; completed: boolean; updatedAt: string };
type LectureFollowUp = { id: string; trackId: string; subject: string; section: string; originalQuestion: string; question: string; answer: string; createdAt: string };
type AccountUser = { id: number; username: string | null; displayName: string; telegram: boolean };
const readStore = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) || "") as T; } catch { return fallback; } };
const saveReference = (item: SavedReference) => { const current = readStore<Record<string, SavedReference>>("exam-reference-answers", {}); current[item.id] = item; localStorage.setItem("exam-reference-answers", JSON.stringify(current)); };
const progressSnapshot = () => Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => Boolean(key?.startsWith("exam-"))).map((key) => [key, localStorage.getItem(key)]));
const syncProgress = () => fetch("/api/progress", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(progressSnapshot()) }).catch(() => null);
type Screen = "home" | "learn" | "quiz" | "written" | "code" | "exam" | "answers" | "stats" | "account" | "lectures";
type AppHistoryState = { zachetka: true; screen: Screen; subjectId: string; depth: number };
const screens: Screen[] = ["home", "learn", "quiz", "written", "code", "exam", "answers", "stats", "account", "lectures"];
const isScreen = (value: unknown): value is Screen => typeof value === "string" && screens.includes(value as Screen);
const historyState = (): Partial<AppHistoryState> | null => {
  if (typeof window === "undefined") return null;
  const state = window.history.state;
  return state?.zachetka === true ? state as Partial<AppHistoryState> : null;
};
const findSubject = (id: unknown) => subjects.find((item) => item.id === id);
const brackets = ["{", "}", "(", ")", "[", "]", ";", "=", "=>"];

function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    const saved = historyState()?.screen;
    return isScreen(saved) ? saved : "home";
  });
  const [subject, setSubject] = useState<Subject>(() => findSubject(historyState()?.subjectId) || findSubject(localStorage.getItem("exam-selected-subject")) || findSubject("java") || subjects[0]);
  const [done, setDone] = useState(() => Number(localStorage.getItem("exam-done") || 0));
  const [user, setUser] = useState<AccountUser | null>(null);
  useEffect(() => {
    const current = historyState();
    const initialState: AppHistoryState = {
      zachetka: true,
      screen,
      subjectId: subject.id,
      depth: typeof current?.depth === "number" && current.depth >= 0 ? current.depth : 0
    };
    window.history.replaceState(initialState, "");
    const restore = (event: PopStateEvent) => {
      const state = event.state as Partial<AppHistoryState> | null;
      if (state?.zachetka !== true || !isScreen(state.screen)) return;
      const restoredSubject = findSubject(state.subjectId);
      if (restoredSubject) {
        setSubject(restoredSubject);
        localStorage.setItem("exam-selected-subject", restoredSubject.id);
      }
      setScreen(state.screen);
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((body) => setUser(body.user)).catch(() => null);
    const telegram = (window as any).Telegram?.WebApp;
    if (telegram?.initData) {
      telegram.ready(); telegram.expand();
      fetch("/api/auth/telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: telegram.initData }) }).then((r) => r.json()).then((body) => body.user && setUser(body.user)).catch(() => null);
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    const marker = `zachetka-synced-${user.id}`;
    const userId = String(user.id);
    const notesOwner = localStorage.getItem(QUESTION_NOTES_OWNER_KEY);
    const mayImportLocalNotes = !notesOwner || notesOwner === userId;
    // localStorage is shared by every login in this browser. Do not import a
    // previous account's personal notes when somebody else signs in.
    if (!mayImportLocalNotes) localStorage.removeItem(QUESTION_NOTES_STORAGE_KEY);
    localStorage.setItem(QUESTION_NOTES_OWNER_KEY, userId);
    if (!sessionStorage.getItem(marker) || !mayImportLocalNotes) fetch("/api/progress").then((r) => r.json()).then(async (remote) => {
      sessionStorage.setItem(marker, "1");
      if (remote.data && Object.keys(remote.data).length) {
        const localNotes = mayImportLocalNotes ? localStorage.getItem(QUESTION_NOTES_STORAGE_KEY) : null;
        const remoteNotes = remote.data[QUESTION_NOTES_STORAGE_KEY];
        Object.entries(remote.data).forEach(([key, value]) => typeof value === "string" && localStorage.setItem(key, value));
        if (localNotes || remoteNotes) localStorage.setItem(QUESTION_NOTES_STORAGE_KEY, mergeQuestionNotesValues(remoteNotes, localNotes));
        window.location.reload();
      }
      else await syncProgress();
    }).catch(() => null);
    const timer = window.setInterval(syncProgress, 5000);
    return () => { clearInterval(timer); syncProgress(); };
  }, [user]);

  const navigate = (next: Screen, selected?: Subject) => {
    const nextSubject = selected || subject;
    if (selected) {
      setSubject(selected);
      localStorage.setItem("exam-selected-subject", selected.id);
    }
    if (next === screen && nextSubject.id === subject.id) {
      window.scrollTo(0, 0);
      return;
    }
    const current = historyState();
    const depth = typeof current?.depth === "number" && current.depth >= 0 ? current.depth + 1 : 1;
    window.history.pushState({ zachetka: true, screen: next, subjectId: nextSubject.id, depth } satisfies AppHistoryState, "");
    setScreen(next);
    window.scrollTo(0, 0);
  };
  const selectSubject = (selected: Subject) => {
    setSubject(selected);
    localStorage.setItem("exam-selected-subject", selected.id);
    const current = historyState();
    window.history.replaceState({
      zachetka: true,
      screen,
      subjectId: selected.id,
      depth: typeof current?.depth === "number" && current.depth >= 0 ? current.depth : 0
    } satisfies AppHistoryState, "");
  };
  const goHome = () => {
    if (screen === "home") {
      window.scrollTo(0, 0);
      return;
    }
    const current = historyState();
    if (typeof current?.depth === "number" && current.depth > 0) {
      window.history.go(-current.depth);
      return;
    }
    window.history.replaceState({ zachetka: true, screen: "home", subjectId: subject.id, depth: 0 } satisfies AppHistoryState, "");
    setScreen("home");
    window.scrollTo(0, 0);
  };
  const goBack = () => {
    const current = historyState();
    if (screen !== "home" && typeof current?.depth === "number" && current.depth > 0) {
      window.history.back();
      return;
    }
    goHome();
  };
  useEffect(() => {
    const backButton = (window as any).Telegram?.WebApp?.BackButton;
    if (!backButton) return;
    const handleBack = () => goBack();
    if (screen === "home") backButton.hide();
    else {
      backButton.show();
      backButton.onClick(handleBack);
    }
    return () => backButton.offClick?.(handleBack);
  }, [screen, subject.id]);

  const learningScreens: Screen[] = ["learn", "quiz", "written", "code", "exam", "answers"];

  return <main className="shell">
    <header className="topbar">
      <button className="brand" onClick={goHome} aria-label="На главную"><span>З</span> зачётка</button>
      <div className="top-actions"><button className={`account-pill ${user ? "online" : ""}`} onClick={() => navigate("account")}>{user ? user.displayName : "Войти"}</button><button className="avatar" aria-label={`Прогресс: завершено подходов — ${done}`} title="Открыть прогресс" onClick={() => navigate("stats")}>{done}</button></div>
    </header>
    {screen === "home" && <Home done={done} subject={subject} selectSubject={selectSubject} navigate={navigate} />}
    {screen === "learn" && <Learn subject={subject} onBack={goBack} />}
    {screen === "quiz" && <Quiz subject={subject} onBack={goBack} onComplete={() => { const n = done + 1; setDone(n); localStorage.setItem("exam-done", String(n)); }} />}
    {screen === "written" && <Written subject={subject} onBack={goBack} />}
    {screen === "code" && <CodeTask subject={subject} onBack={goBack} />}
    {screen === "exam" && <Exam subject={subject} onBack={goBack} />}
    {screen === "answers" && <AnswerLibrary onBack={goBack} />}
    {screen === "stats" && <Stats done={done} onBack={goBack} onOpenSubject={(selected) => navigate("learn", selected)} />}
    {screen === "account" && <Account user={user} setUser={setUser} onBack={goBack} />}
    {screen === "lectures" && <Lectures onBack={goBack} />}
    <nav className="mobile-nav" aria-label="Основная навигация">
      <button className={screen === "home" ? "active" : ""} aria-current={screen === "home" ? "page" : undefined} onClick={goHome}><b aria-hidden="true">⌂</b><span>Главная</span></button>
      <button className={learningScreens.includes(screen) ? "active" : ""} aria-current={learningScreens.includes(screen) ? "page" : undefined} onClick={() => navigate("learn", subject)}><b aria-hidden="true">□</b><span>Учить</span></button>
      <button className={screen === "lectures" ? "active" : ""} aria-current={screen === "lectures" ? "page" : undefined} onClick={() => navigate("lectures")}><b aria-hidden="true">♫</b><span>Слушать</span></button>
      <button className={screen === "stats" ? "active" : ""} aria-current={screen === "stats" ? "page" : undefined} onClick={() => navigate("stats")}><b aria-hidden="true">↗</b><span>Прогресс</span></button>
    </nav>
  </main>;
}

function Account({ user, setUser, onBack }: { user: AccountUser | null; setUser: (user: AccountUser | null) => void; onBack: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login"); const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const submit = async () => { setLoading(true); setError(""); try { const response = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); setUser(body.user); } catch (e: any) { setError(e.message || "Не удалось войти"); } finally { setLoading(false); } };
  const logout = async () => { await syncProgress(); await fetch("/api/auth/logout", { method: "POST" }); setUser(null); };
  return <section className="account-page"><button className="back" onClick={onBack}>← На главную</button><p className="eyebrow">Синхронизация</p><h1>{user ? "Аккаунт подключён" : "Продолжай с любого устройства"}</h1>{user ? <div className="account-card"><span className="sync-dot">●</span><div><strong>{user.displayName}</strong><p>{user.telegram ? "Вход через Telegram" : `Логин: ${user.username}`}<br/>Прогресс автоматически сохраняется каждые несколько секунд.</p></div><button className="secondary" onClick={logout}>Выйти</button></div> : <div className="auth-box"><div className="auth-tabs"><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Войти</button><button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Создать аккаунт</button></div><label>Логин<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></label><label>Пароль<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <p className="inline-error">{error}</p>}<button className="primary" disabled={loading || username.length < 3 || password.length < 8} onClick={submit}>{loading ? "Подключаю…" : mode === "login" ? "Войти и загрузить прогресс" : "Создать и синхронизировать"}</button><p className="auth-note">Внутри Telegram вход произойдёт автоматически. Пароль там вводить не потребуется.</p></div>}</section>;
}

function Home({ done, subject, selectSubject, navigate }: { done: number; subject: Subject; selectSubject: (subject: Subject) => void; navigate: (s: Screen, subject?: Subject) => void }) {
  const bank = questionBanks.find((item) => item.id === subject.id);
  const questionCount = bank?.sections.reduce((sum, section) => sum + section.questions.length, 0) || 0;
  const latestLecture = Object.values(readStore<Record<string, LectureProgress>>("exam-lecture-progress", {}))
    .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))[0];
  return <>
    <section className="hero">
      <div><p className="eyebrow">Твоя подготовка</p><h1>Спокойно.<br/><em>Ты сдашь.</em></h1></div>
      <div className="hero-score"><strong>{done}</strong><span>подходов<br/>завершено</span></div>
    </section>
    <button className="home-continue" onClick={() => navigate(latestLecture ? "lectures" : "learn", subject)}>
      <span>{latestLecture ? "Продолжить слушать" : "Начать подготовку"}</span>
      <strong>{latestLecture?.title || subject.title}</strong>
      <small>{latestLecture ? `${latestLecture.section} · ${Math.round(latestLecture.percent)}% прослушано` : `${questionCount} вопросов · ${bank?.sections.length || 0} разделов`}</small>
      <b aria-hidden="true">→</b>
    </button>
    <section><div className="section-title"><h2>Предметы</h2><span>{subjects.length} курса · {subjects.reduce((sum, item) => sum + item.pages, 0)} страниц</span></div>
      <div className="subjects">{subjects.map((item, i) => { const bank = questionBanks.find((x) => x.id === item.id); const count = bank?.sections.reduce((sum, section) => sum + section.questions.length, 0) || 0; return <button className={`subject ${item.color}`} key={item.id} onClick={() => navigate("learn", item)}>
        <span className="subject-index">0{i + 1}</span><span className="subject-code">{item.short}</span><strong>{item.title}</strong><small>{count} вопросов · {bank?.tasks.length || 0} задач</small><span className="arrow">↗</span>
      </button>})}</div>
    </section>
    <section><div className="section-title"><h2>Режим</h2><span>выбери формат</span></div>
      <div className="mode-subject-picker" aria-label="Предмет для режима">
        <span>Сейчас изучаем</span>
        <div>{subjects.map((item) => <button key={item.id} className={item.id === subject.id ? "active" : ""} aria-pressed={item.id === subject.id} onClick={() => selectSubject(item)}>{item.short}<small>{questionBanks.find((entry) => entry.id === item.id)?.sections.reduce((sum, section) => sum + section.questions.length, 0) || 0}</small></button>)}</div>
      </div>
      <div className="modes">
        <button onClick={() => navigate("learn", subject)}><i>00</i><span><strong>Все темы</strong><small>{questionCount} вопросов · карточки</small></span><b>→</b></button>
        <button onClick={() => navigate("quiz", subject)}><i>01</i><span><strong>Быстрый тест</strong><small>{Math.min(8, questionCount)} вопросов · один ответ</small></span><b>→</b></button>
        <button onClick={() => navigate("written", subject)}><i>02</i><span><strong>Письменный ответ</strong><small>{questionCount} вопросов · проверка по критериям</small></span><b>→</b></button>
        <button disabled={!bank?.tasks.length} onClick={() => navigate("code", subject)}><i>03</i><span><strong>Написать код</strong><small>{bank?.tasks.length ? `${bank.tasks.length} задач · редактор на телефоне` : "В этом предмете задач нет"}</small></span><b>→</b></button>
        <button onClick={() => navigate("exam", subject)}><i>04</i><span><strong>Полный билет</strong><small>60 минут · 100 баллов</small></span><b>→</b></button>
        <button onClick={() => navigate("answers")}><i>05</i><span><strong>Эталонные ответы</strong><small>Ответы на 21–25 баллов</small></span><b>→</b></button>
        <button onClick={() => navigate("lectures")}><i>06</i><span><strong>Лекции</strong><small>Слушать ответы по темам в фоне</small></span><b>♫</b></button>
      </div>
    </section>
    <section className="exam-format"><p className="eyebrow">Как на экзамене · 60 минут</p><div><span><b>25</b> теория №1</span><span><b>25</b> теория №2</span><span><b>50</b> задача</span><strong>100 баллов</strong></div></section>
    <p className="import-note"><span>●</span> Импорт: 23 страницы распознаны локально</p>
  </>;
}

type LectureTrack = { id: string; subject: string; section: string; sectionKey: string; title: string; mode: "question" | "section"; questionKeys: string[]; topics?: string[]; part?: number; partCount?: number };
function Lectures({ onBack }: { onBack: () => void }) {
  type LectureTextEntry = { text?: string; source?: "generated" | "transcribed" | "cache"; loading: boolean; error?: string };
  const [lectureMode, setLectureMode] = useState<"questions" | "sections">("questions");
  const [subjectId, setSubjectId] = useState("all"); const [sectionId, setSectionId] = useState("all");
  const [index, setIndex] = useState(() => Number(localStorage.getItem("exam-lecture-index") || 0));
  const [audioUrl, setAudioUrl] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [speed, setSpeed] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [repeatCurrent, setRepeatCurrent] = useState(() => localStorage.getItem("exam-lecture-repeat") === "true");
  const [queueQuery, setQueueQuery] = useState(""); const [unlistenedOnly, setUnlistenedOnly] = useState(false);
  const [listeningProgress, setListeningProgress] = useState<Record<string, LectureProgress>>(() => readStore("exam-lecture-progress", {}));
  const [lectureTextCache, setLectureTextCache] = useState<Record<string, LectureTextEntry>>({});
  const [expandedTextTrackId, setExpandedTextTrackId] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null); const activeRowRef = useRef<HTMLButtonElement>(null); const urlRef = useRef(""); const loadedTrackRef = useRef<LectureTrack | null>(null); const loadVersionRef = useRef(0); const recordListeningRef = useRef<(force?: boolean) => void>(() => undefined); const lastProgressWrite = useRef(0); const lastMediaTime = useRef(0); const pendingRanges = useRef<ListeningRange[]>([]); const seeking = useRef(false);
  const lectureTextCacheRef = useRef<Record<string, LectureTextEntry>>({});
  const lectureTextRequestsRef = useRef<Record<string, AbortController>>({});
  const sections = subjectId === "all" ? [] : questionBanks.find((bank) => bank.id === subjectId)?.sections || [];
  const tracks = useMemo<LectureTrack[]>(() => {
    const banks = questionBanks.filter((bank) => subjectId === "all" || bank.id === subjectId);
    if (lectureMode === "sections") return banks.flatMap((bank) => bank.sections.flatMap((section, sectionIndex) => {
      if (sectionId !== "all" && subjectId !== "all" && String(sectionIndex) !== sectionId) return [];
      const questionsPerPart = 3;
      const parts = Array.from({ length: Math.ceil(section.questions.length / questionsPerPart) }, (_, partIndex) => section.questions.slice(partIndex * questionsPerPart, partIndex * questionsPerPart + questionsPerPart));
      return parts.map((topics, partIndex) => ({
        id: `full-section-${bank.id}-${sectionIndex}-part-${partIndex}`,
        subject: bank.title,
        section: section.title,
        sectionKey: `${bank.id}-${sectionIndex}`,
        title: `${section.title} · часть ${partIndex + 1} из ${parts.length}`,
        mode: "section" as const,
        topics,
        questionKeys: topics.map((_, topicIndex) => `${bank.id}:${sectionIndex}-${partIndex * questionsPerPart + topicIndex}`),
        part: partIndex + 1,
        partCount: parts.length
      }));
    }));
    return banks.flatMap((bank) => bank.sections.flatMap((section, sectionIndex) => section.questions
      .filter(() => sectionId === "all" || (subjectId !== "all" && String(sectionIndex) === sectionId))
      .map((title, questionIndex) => ({
        id: `question-${bank.id}-${sectionIndex}-${questionIndex}`,
        subject: bank.title,
        section: section.title,
        sectionKey: `${bank.id}-${sectionIndex}`,
        title,
        questionKeys: [`${bank.id}:${sectionIndex}-${questionIndex}`],
        mode: "question" as const
      }))));
  }, [lectureMode, subjectId, sectionId]);
  const sectionCount = new Set(tracks.map((track) => track.sectionKey)).size;
  const currentIndex = tracks.length ? index % tracks.length : 0; const current = tracks[currentIndex];
  const visibleTracks = useMemo(() => {
    const query = queueQuery.trim().toLocaleLowerCase("ru-RU");
    return tracks.map((track, originalIndex) => ({ track, originalIndex })).filter(({ track }) => {
      if (unlistenedOnly && listeningProgress[track.id]?.completed) return false;
      if (!query) return true;
      return [track.subject, track.section, track.title, ...(track.topics || [])].join(" ").toLocaleLowerCase("ru-RU").includes(query);
    });
  }, [tracks, queueQuery, unlistenedOnly, listeningProgress]);
  useEffect(() => { loadVersionRef.current += 1; recordListeningRef.current(true); audioRef.current?.pause(); loadedTrackRef.current = null; pendingRanges.current = []; setIndex(0); setAudioUrl(""); setIsPlaying(false); setLoading(false); setError(""); if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = ""; } }, [lectureMode, subjectId, sectionId]);
  useEffect(() => () => { loadVersionRef.current += 1; recordListeningRef.current(true); if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  useEffect(() => { activeRowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [current?.id, queueQuery, unlistenedOnly]);
  const requestBody = (track: LectureTrack) => ({ title: track.mode === "section" ? track.section : track.title, mode: track.mode, topics: track.topics });
  const updateLectureText = (trackId: string, patch: Partial<LectureTextEntry>) => {
    setLectureTextCache((previous) => {
      const next = { ...previous, [trackId]: { ...previous[trackId], loading: false, ...patch } };
      lectureTextCacheRef.current = next;
      return next;
    });
  };
  const loadLectureText = async (track: LectureTrack, retry = false) => {
    const cached = lectureTextCacheRef.current[track.id];
    if (!retry && (cached?.text || cached?.loading)) return;
    if (lectureTextRequestsRef.current[track.id]) return;
    const controller = new AbortController();
    lectureTextRequestsRef.current[track.id] = controller;
    updateLectureText(track.id, { loading: true, error: "" });
    try {
      const response = await fetch("/api/lectures/text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody(track)), signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Текст лекции недоступен");
      if (typeof body.text !== "string" || !body.text.trim()) throw new Error("Сервер вернул пустой текст лекции");
      updateLectureText(track.id, { text: body.text.trim(), source: body.source, loading: false, error: "" });
    } catch (e: any) {
      if (e?.name !== "AbortError") updateLectureText(track.id, { loading: false, error: e?.message || "Не удалось загрузить текст лекции" });
    } finally {
      if (lectureTextRequestsRef.current[track.id] === controller) delete lectureTextRequestsRef.current[track.id];
    }
  };
  useEffect(() => () => { Object.values(lectureTextRequestsRef.current).forEach((controller) => controller.abort()); }, []);
  const cacheLocation = (track: LectureTrack) => {
    const version = "v4";
    return { cacheName: `zachetka-lectures-${version}`, cacheKey: `/lecture-cache-${version}/${track.id}.mp3` };
  };
  const prefetch = async (track: LectureTrack | undefined) => {
    if (!track || !("caches" in window)) return;
    const { cacheName, cacheKey } = cacheLocation(track); const cache = await caches.open(cacheName); if (await cache.match(cacheKey)) return;
    const response = await fetch("/api/lectures/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody(track)) });
    if (response.ok) await cache.put(cacheKey, response);
  };
  const load = async (nextIndex = currentIndex, autoplay = true) => {
    const track = tracks[nextIndex]; if (!track) return; const loadVersion = ++loadVersionRef.current; setLoading(true); setError("");
    try {
      const { cacheName, cacheKey } = cacheLocation(track); const cache = "caches" in window ? await caches.open(cacheName) : null;
      let audioResponse = cache ? await cache.match(cacheKey) : undefined;
      if (!audioResponse) { const response = await fetch("/api/lectures/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody(track)) }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || "Аудио недоступно"); } audioResponse = response; if (cache) await cache.put(cacheKey, response.clone()); }
      const blob = await audioResponse.blob(); if (loadVersion !== loadVersionRef.current) return; audioRef.current?.pause(); recordListeningRef.current(true); if (urlRef.current) URL.revokeObjectURL(urlRef.current); const url = URL.createObjectURL(blob); urlRef.current = url; loadedTrackRef.current = track; lastMediaTime.current = 0; pendingRanges.current = []; seeking.current = false; lastProgressWrite.current = 0; setIndex(nextIndex); setAudioUrl(url); localStorage.setItem("exam-lecture-index", String(nextIndex));
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.section, album: track.subject });
      if (autoplay) window.setTimeout(() => { if (loadVersion === loadVersionRef.current) audioRef.current?.play().catch(() => null); }, 50);
    } catch (e: any) { if (loadVersion === loadVersionRef.current) setError(e.message || "Не удалось загрузить лекцию"); } finally { if (loadVersion === loadVersionRef.current) setLoading(false); }
  };
  const recordListening = (force = false) => {
    const audio = audioRef.current; const track = loadedTrackRef.current; if (!audio || !track || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const rangeStart = lastMediaTime.current; const rangeEnd = audio.currentTime;
    if (!seeking.current && rangeEnd > rangeStart) pendingRanges.current = addListenedRange(pendingRanges.current, rangeStart, rangeEnd, audio.duration);
    else if (!seeking.current && audio.loop && rangeStart > audio.duration - 2 && rangeEnd < 2) {
      pendingRanges.current = addListenedRange(pendingRanges.current, rangeStart, audio.duration, audio.duration);
      pendingRanges.current = addListenedRange(pendingRanges.current, 0, rangeEnd, audio.duration);
    }
    lastMediaTime.current = rangeEnd;
    const saved = readStore<Record<string, LectureProgress>>("exam-lecture-progress", {}); const previous = saved[track.id];
    let listenedRanges = migrateLegacyRanges(previous || {}, audio.duration);
    for (const [start, end] of pendingRanges.current) listenedRanges = addListenedRange(listenedRanges, start, end, audio.duration);
    const listenedSeconds = totalUniqueSeconds(listenedRanges, audio.duration); const percent = Math.min(100, listenedSeconds / audio.duration * 100); const completed = percent >= 50;
    const justCompleted = completed && !previous?.completed; if (!force && !justCompleted && Date.now() - lastProgressWrite.current < 5000) return;
    lastProgressWrite.current = Date.now(); pendingRanges.current = [];
    const item: LectureProgress = { id: track.id, subject: track.subject, section: track.section, title: track.title, listenedSeconds, listenedRanges, positionSeconds: audio.currentTime, duration: audio.duration, percent, completed, updatedAt: new Date().toISOString() };
    const next = { ...saved, [track.id]: item }; localStorage.setItem("exam-lecture-progress", JSON.stringify(next)); setListeningProgress(next);
  };
  recordListeningRef.current = recordListening;
  const move = (delta: number) => { if (!tracks.length) return; recordListening(true); load((currentIndex + delta + tracks.length) % tracks.length); };
  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) { load(currentIndex); return; }
    if (audio.paused) audio.play().catch(() => null);
    else audio.pause();
  };
  const toggleRepeat = () => setRepeatCurrent((enabled) => {
    const next = !enabled;
    localStorage.setItem("exam-lecture-repeat", String(next));
    return next;
  });
  useEffect(() => {
    const flush = () => recordListeningRef.current(true);
    const flushWhenHidden = () => { if (document.hidden) flush(); };
    window.addEventListener("pagehide", flush); document.addEventListener("visibilitychange", flushWhenHidden);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", flushWhenHidden); };
  }, []);
  useEffect(() => { if (!("mediaSession" in navigator)) return; navigator.mediaSession.setActionHandler("nexttrack", () => move(1)); navigator.mediaSession.setActionHandler("previoustrack", () => move(-1)); return () => { navigator.mediaSession.setActionHandler("nexttrack", null); navigator.mediaSession.setActionHandler("previoustrack", null); }; });
  const currentProgress = current ? listeningProgress[current.id] : null;
  const currentLectureText = current ? lectureTextCache[current.id] : undefined;
  return <section className="lectures-page">
    <button className="back" onClick={() => { loadVersionRef.current += 1; recordListening(true); onBack(); }}>← На главную</button>
    <div className="lecture-head"><div><p className="eyebrow">Фоновое обучение</p><h1>Лекции</h1><p>Слушай отдельные вопросы подряд или одну цельную лекцию по всему разделу.</p></div><span>♫</span></div>
    <div className="lecture-mode-tabs">
      <button className={lectureMode === "questions" ? "active" : ""} onClick={() => { if (lectureMode !== "questions") { loadVersionRef.current += 1; setLectureMode("questions"); } }}><strong>Все вопросы</strong><small>каждый вопрос — отдельный трек</small></button>
      <button className={lectureMode === "sections" ? "active" : ""} onClick={() => { if (lectureMode !== "sections") { loadVersionRef.current += 1; setLectureMode("sections"); } }}><strong>По разделам</strong><small>полноценная связная лекция</small></button>
    </div>
    <div className="lecture-filters">
      <label>Предмет<select value={subjectId} onChange={(e) => { loadVersionRef.current += 1; setSubjectId(e.target.value); setSectionId("all"); }}><option value="all">Все предметы</option>{questionBanks.map((bank) => <option value={bank.id} key={bank.id}>{bank.title}</option>)}</select></label>
      <label>Раздел<select value={sectionId} disabled={subjectId === "all"} onChange={(e) => { loadVersionRef.current += 1; setSectionId(e.target.value); }}><option value="all">Все разделы</option>{sections.map((section, i) => <option value={i} key={section.title}>{section.title}</option>)}</select></label>
    </div>
    {current && <div className="lecture-player" aria-busy={loading}>
      <div className="lecture-number">{currentIndex + 1} / {tracks.length}</div><small>{current.subject} · {current.section}</small><h2>{current.title}</h2>
      {current.mode === "section" && <p className="lecture-coverage">Часть {current.part} из {current.partCount} · {current.topics?.length || 0} полных ответа · части включаются автоматически</p>}
      {currentProgress && <p className={`lecture-listened ${currentProgress.completed ? "completed" : ""}`}>{currentProgress.completed ? "✓ Засчитано" : `Прослушано ${Math.round(currentProgress.percent)}%`} · засчитывается после 50%</p>}
      {!audioUrl ? <button className="lecture-start" disabled={loading} onClick={() => load(currentIndex)}>{loading ? "Готовлю лекцию…" : currentProgress?.completed ? "▶ Прослушать ещё раз" : "▶ Начать слушать"}</button> : <><audio ref={audioRef} src={audioUrl} controls playsInline loop={repeatCurrent} onPlay={() => { setIsPlaying(true); if (audioRef.current) lastMediaTime.current = audioRef.current.currentTime; prefetch(tracks[(currentIndex + 1) % tracks.length]).catch(() => null); }} onSeeking={() => { seeking.current = true; if (audioRef.current) lastMediaTime.current = audioRef.current.currentTime; }} onSeeked={() => { if (audioRef.current) lastMediaTime.current = audioRef.current.currentTime; seeking.current = false; }} onTimeUpdate={() => recordListening()} onPause={() => { setIsPlaying(false); recordListening(true); }} onEnded={() => { setIsPlaying(false); recordListening(true); if (!repeatCurrent) move(1); }} onLoadedMetadata={() => { if (!audioRef.current) return; audioRef.current.playbackRate = speed; const loadedTrack = loadedTrackRef.current; const saved = loadedTrack ? readStore<Record<string, LectureProgress>>("exam-lecture-progress", {})[loadedTrack.id] : null; const position = saved?.positionSeconds ?? 0; if (saved && !saved.completed && position > 0 && position < audioRef.current.duration * .95) audioRef.current.currentTime = position; lastMediaTime.current = audioRef.current.currentTime; }} /><div className="lecture-controls"><button onClick={() => move(-1)}>← Предыдущая</button><label>Скорость<select value={speed} onChange={(e) => { const value = Number(e.target.value); setSpeed(value); if (audioRef.current) audioRef.current.playbackRate = value; }}><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><button className={repeatCurrent ? "active" : ""} aria-pressed={repeatCurrent} onClick={toggleRepeat}>↻ {repeatCurrent ? "Повтор включён" : "На повтор"}</button><button onClick={() => move(1)}>Следующая →</button></div></>}
      {loading && <p className="lecture-loading" role="status" aria-live="polite">{audioUrl ? "Готовлю следующий трек…" : "Загружаю аудио…"}</p>}{error && <p className="inline-error" role="alert" aria-live="assertive">{error}</p>}
      <section className="lecture-text-panel">
        <button type="button" className="lecture-text-toggle" aria-expanded={expandedTextTrackId === current.id} aria-controls={`lecture-text-${current.id}`} onClick={() => {
          const willOpen = expandedTextTrackId !== current.id;
          setExpandedTextTrackId(willOpen ? current.id : "");
          if (willOpen) void loadLectureText(current);
        }}><span><strong>Текст лекции</strong><small>{currentLectureText?.source === "transcribed" ? "Автоматическая расшифровка старой записи" : currentLectureText?.text ? "Точный текст озвучки" : "Читать вместе с аудио"}</small></span><b aria-hidden="true">{expandedTextTrackId === current.id ? "−" : "+"}</b></button>
        {expandedTextTrackId === current.id && <div id={`lecture-text-${current.id}`} className="lecture-text-content" role="region" aria-label={`Текст лекции: ${current.title}`} aria-busy={Boolean(currentLectureText?.loading)}>
          {currentLectureText?.loading && <p className="lecture-text-loading" role="status" aria-live="polite">Загружаю текст лекции…</p>}
          {currentLectureText?.error && <div className="lecture-text-error" role="alert"><p>{currentLectureText.error}</p><button type="button" onClick={() => void loadLectureText(current, true)}>Попробовать ещё раз</button></div>}
          {currentLectureText?.source === "transcribed" && currentLectureText.text && <p className="lecture-text-note">Этот текст восстановлен из старого MP3 автоматически, поэтому в терминах и знаках препинания возможны небольшие неточности.</p>}
          {currentLectureText?.text && <article>{currentLectureText.text.split(/\n\s*\n/).filter(Boolean).map((paragraph, paragraphIndex) => <p key={`${current.id}-paragraph-${paragraphIndex}`}>{paragraph}</p>)}</article>}
        </div>}
      </section>
    </div>}
    {current && <LectureQuestionNotes key={current.id} track={current}/>}
    {current && <LectureFollowUps track={current}/>}
    {current && audioUrl && <aside className="lecture-mini-player" aria-label="Компактный плеер">
      <div><small>{current.section}</small><strong>{current.title}</strong><span>{Math.round(currentProgress?.percent || 0)}%</span></div>
      <button onClick={togglePlayback} aria-label={isPlaying ? "Поставить на паузу" : "Продолжить воспроизведение"}>{isPlaying ? "Ⅱ" : "▶"}</button>
      <button onClick={() => move(1)} aria-label="Следующая лекция">→</button>
      <button className={repeatCurrent ? "active" : ""} aria-pressed={repeatCurrent} aria-label={repeatCurrent ? "Отключить повтор" : "Включить повтор"} onClick={toggleRepeat}>↻</button>
    </aside>}
    <div className="lecture-queue"><div className="section-title"><h2>{lectureMode === "questions" ? "Все вопросы" : "Полные лекции по разделам"}</h2><span>{lectureMode === "questions" ? `${tracks.length} вопросов` : `${sectionCount} разделов · ${tracks.length} частей`}</span></div>
      <div className="lecture-queue-tools"><input type="search" value={queueQuery} onChange={(event) => setQueueQuery(event.target.value)} placeholder="Найти вопрос или раздел…" aria-label="Поиск по очереди лекций"/><button className={unlistenedOnly ? "active" : ""} aria-pressed={unlistenedOnly} onClick={() => setUnlistenedOnly((enabled) => !enabled)}>○ Только непрослушанные</button></div>
      <div className="lecture-queue-list">{visibleTracks.length > 0 ? visibleTracks.flatMap(({ track, originalIndex }, visibleIndex) => {
        const progress = listeningProgress[track.id];
        const previousTrack = visibleTracks[visibleIndex - 1]?.track;
        const row = <button ref={originalIndex === currentIndex ? activeRowRef : undefined} aria-current={originalIndex === currentIndex ? "true" : undefined} className={`${originalIndex === currentIndex ? "active " : ""}${progress?.completed ? "listened" : ""}`} key={track.id} onClick={() => { recordListening(true); load(originalIndex); }}><span>{progress?.completed ? "✓" : originalIndex + 1}</span><div><small>{track.subject} · {track.section}</small><strong>{track.title}</strong>{track.mode === "section" && <em>{track.topics?.length || 0} вопроса: сначала формулировка, затем полный ответ</em>}{progress && !progress.completed && <em>Прослушано {Math.round(progress.percent)}%</em>}</div></button>;
        if (previousTrack?.sectionKey === track.sectionKey) return [row];
        return [<div className="lecture-section-divider" key={`section-${track.sectionKey}`}><span>{track.subject}</span><strong>{track.section}</strong></div>, row];
      }) : <div className="empty lecture-queue-empty" role="status">{queueQuery.trim() || unlistenedOnly ? "По выбранным фильтрам ничего не найдено." : "В этой подборке пока нет лекций."}</div>}</div>
    </div>
  </section>;
}

function LectureQuestionNotes({ track }: { track: LectureTrack }) {
  const [topicIndex, setTopicIndex] = useState(0);
  const questions = track.mode === "section" ? track.topics || [] : [track.title];
  const activeIndex = Math.min(topicIndex, Math.max(questions.length - 1, 0));
  const question = questions[activeIndex] || track.title;
  const questionKey = track.questionKeys[activeIndex] || track.questionKeys[0];
  if (!questionKey) return null;
  return <div className="lecture-question-notes">
    {track.mode === "section" && questions.length > 1 && <label className="lecture-note-topic"><span>Заметка к вопросу</span><select value={activeIndex} onChange={(event) => setTopicIndex(Number(event.target.value))}>{questions.map((topic, index) => <option value={index} key={`${track.id}-note-${index}`}>{index + 1}. {topic}</option>)}</select></label>}
    <QuestionNotes questionKey={questionKey} question={question} contextLabel={`${track.subject} · ${track.section}`}/>
  </div>;
}

function LectureFollowUps({ track }: { track: LectureTrack }) {
  const storageKey = "exam-lecture-followups";
  const [items, setItems] = useState<LectureFollowUp[]>(() => readStore(storageKey, []));
  const [topicIndex, setTopicIndex] = useState(0);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => { requestRef.current?.abort(); requestRef.current = null; setTopicIndex(0); setQuestion(""); setError(""); setLoading(false); }, [track.id]);
  useEffect(() => () => requestRef.current?.abort(), []);
  const topics = track.topics || [];
  const originalQuestion = track.mode === "section" ? topics[Math.min(topicIndex, Math.max(0, topics.length - 1))] || track.title : track.title;
  const currentItems = items.filter((item) => item.trackId === track.id);
  const ask = async () => {
    const followUp = question.trim();
    if (followUp.length < 3) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/lectures/follow-up", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ originalQuestion, followUp }), signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Не удалось получить ответ");
      if (controller.signal.aborted) return;
      const item: LectureFollowUp = {
        id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        trackId: track.id,
        subject: track.subject,
        section: track.section,
        originalQuestion,
        question: followUp,
        answer: body.answer,
        createdAt: new Date().toISOString()
      };
      const next = [item, ...items];
      setItems(next); localStorage.setItem(storageKey, JSON.stringify(next)); setQuestion(""); syncProgress();
    } catch (e: any) { if (e?.name !== "AbortError" && requestRef.current === controller) setError(e.message || "Уточнение сейчас недоступно"); } finally { if (requestRef.current === controller) { requestRef.current = null; setLoading(false); } }
  };
  return <details className="lecture-followups">
    <summary><span><small>Разобраться глубже</small><strong>Задать уточнение к вопросу</strong></span><b>{currentItems.length > 0 ? `${currentItems.length} сохранено` : "Открыть"}</b></summary>
    <div className="lecture-followups-body">
    {track.mode === "section" && topics.length > 0 && <label className="followup-topic">К какому вопросу<select value={topicIndex} onChange={(event) => setTopicIndex(Number(event.target.value))}>{topics.map((topic, index) => <option value={index} key={`${track.id}-${index}`}>{index + 1}. {topic}</option>)}</select></label>}
    <div className="followup-context"><span>Исходный вопрос</span><strong>{originalQuestion}</strong></div>
    <textarea value={question} disabled={loading} onChange={(event) => setQuestion(event.target.value)} placeholder="Например: чем это отличается от переопределения?" maxLength={2000}/>
    {error && <p className="inline-error" role="alert" aria-live="assertive">{error}</p>}
    <button className="followup-submit" disabled={loading || question.trim().length < 3} onClick={ask}>{loading ? "Ищу точный ответ…" : "Получить текстовый ответ"}</button>
    {loading && <p className="followup-status" role="status" aria-live="polite">Формирую текстовый ответ…</p>}
    <small className="followup-note">Ответ сохранится в аккаунте и останется доступен позже. Аудио для уточнений не создаётся.</small>
    {currentItems.length > 0 && <div className="followup-current" aria-live="polite"><h4>Уточнения к этому треку</h4>{currentItems.map((item) => <article className="followup-card" key={item.id}><small>{item.originalQuestion}</small><strong>Ты: {item.question}</strong><p>{item.answer}</p><time>{new Date(item.createdAt).toLocaleString("ru-RU")}</time></article>)}</div>}
    {items.length > 0 && <details className="saved-followups"><summary>Все сохранённые уточнения ({items.length})</summary><div>{items.map((item) => <article className="followup-card" key={`saved-${item.id}`}><small>{item.subject} · {item.section}</small><strong>{item.question}</strong><p>{item.answer}</p><time>{new Date(item.createdAt).toLocaleString("ru-RU")}</time></article>)}</div></details>}
    </div>
  </details>;
}

function Learn({ subject, onBack }: { subject: Subject; onBack: () => void }) {
  const bank = questionBanks.find((item) => item.id === subject.id)!;
  const all = bank.sections.flatMap((section, sectionIndex) => section.questions.map((text, questionIndex) => ({ id: `${sectionIndex}-${questionIndex}`, section: section.title, sectionIndex, text })));
  const storageKey = `exam-known-${subject.id}`;
  const [section, setSection] = useState("all"); const [query, setQuery] = useState(""); const [view, setView] = useState<"sections" | "cards" | "list">("sections");
  const [known, setKnown] = useState<string[]>(() => JSON.parse(localStorage.getItem(storageKey) || "[]")); const [deck, setDeck] = useState<string[]>([]); const [position, setPosition] = useState(0);
  const [answer, setAnswer] = useState(""); const [grade, setGrade] = useState<any>(null); const [reference, setReference] = useState<SavedReference | null>(null); const [loading, setLoading] = useState(false); const [referenceLoading, setReferenceLoading] = useState(false); const [error, setError] = useState("");
  const filtered = all.filter((item) => (section === "all" || String(item.sectionIndex) === section) && item.text.toLowerCase().includes(query.toLowerCase()));
  const visible = (deck.length ? deck.map((id) => all.find((item) => item.id === id)!).filter(Boolean) : filtered).filter((item) => filtered.some((candidate) => candidate.id === item.id));
  const current = visible[position % Math.max(visible.length, 1)];
  useEffect(() => { setPosition(0); setAnswer(""); setGrade(null); setReference(null); }, [section, query]);
  const saveKnown = (id: string, value: boolean) => { const next = value ? Array.from(new Set([...known, id])) : known.filter((item) => item !== id); setKnown(next); localStorage.setItem(storageKey, JSON.stringify(next)); };
  const shuffle = () => { const ids = filtered.map((item) => item.id); for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; } setDeck(ids); setPosition(0); setAnswer(""); setGrade(null); };
  const choose = (id: string) => { const index = visible.findIndex((item) => item.id === id); setPosition(index >= 0 ? index : 0); setView("cards"); setAnswer(""); setGrade(null); setReference(null); window.scrollTo(0, 0); };
  const next = () => { setPosition((p) => (p + 1) % Math.max(visible.length, 1)); setAnswer(""); setGrade(null); setReference(null); setError(""); };
  const check = async () => { if (!current) return; setLoading(true); setError(""); try { const response = await fetch("/api/grade/written", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: current.text, answer }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); setGrade(body); if (body.improvedAnswer) saveReference({ id: `${subject.id}:${current.id}`, subject: bank.title, section: current.section, question: current.text, answer: body.improvedAnswer, keyPoints: body.missing || [], savedAt: new Date().toISOString() }); } catch (e: any) { setError(e.message || "Проверка недоступна"); } finally { setLoading(false); } };
  const loadReference = async () => { if (!current) return; const id = `${subject.id}:${current.id}`; const saved = readStore<Record<string, SavedReference>>("exam-reference-answers", {})[id]; if (saved) { setReference(saved); return; } setReferenceLoading(true); setError(""); try { const response = await fetch("/api/reference-answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: current.text }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); const item = { id, subject: bank.title, section: current.section, question: current.text, answer: body.answer, keyPoints: body.keyPoints, savedAt: new Date().toISOString() }; saveReference(item); setReference(item); } catch (e: any) { setError(e.message || "Эталон недоступен"); } finally { setReferenceLoading(false); } };
  const knownInFilter = filtered.filter((item) => known.includes(item.id)).length;
  const overallKnown = all.filter((item) => known.includes(item.id)).length;
  const openSection = (value: string) => { setSection(value); setDeck([]); setQuery(""); setPosition(0); setView("cards"); };
  const sectionStats = bank.sections.map((item, i) => { const ids = all.filter((question) => question.sectionIndex === i).map((question) => question.id); return { ...item, index: i, known: ids.filter((id) => known.includes(id)).length }; });
  return <section className="learn-page"><button className="back" onClick={view === "sections" ? onBack : () => setView("sections")}>{view === "sections" ? "← Предметы" : "← Все разделы"}</button><div className="learn-head"><div><p className="eyebrow">{subject.short} · {view === "sections" ? "разделы программы" : section === "all" ? "все вопросы" : bank.sections[Number(section)]?.title}</p><h1>{bank.title}</h1></div><div className="learn-total"><b>{view === "sections" ? overallKnown : knownInFilter}</b><span>из {view === "sections" ? all.length : filtered.length}<br/>знаю</span></div></div>
    <div className="learn-progress"><i style={{ width: `${(view === "sections" ? all.length : filtered.length) ? (view === "sections" ? overallKnown / all.length : knownInFilter / filtered.length) * 100 : 0}%` }}/></div>
    {view === "sections" ? <div className="section-grid"><button className="section-all" onClick={() => openSection("all")}><span>Все вопросы</span><strong>{all.length}</strong><small>{overallKnown} изучено · общий режим</small><b>→</b></button>{sectionStats.map((item, i) => <button key={item.title} onClick={() => openSection(String(item.index))}><span>Раздел {String(i + 1).padStart(2, "0")}</span><strong>{item.title}</strong><small>{item.known} из {item.questions.length} изучено</small><i><em style={{ width: `${item.questions.length ? item.known / item.questions.length * 100 : 0}%` }}/></i><b>→</b></button>)}</div> : <><div className="learn-controls"><select value={section} onChange={(e) => { setSection(e.target.value); setDeck([]); }}><option value="all">Все разделы ({all.length})</option>{bank.sections.map((item, i) => <option value={i} key={item.title}>{item.title} ({item.questions.length})</option>)}</select><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти тему…"/><button onClick={shuffle}>⇄ Перемешать</button><button onClick={() => setView(view === "cards" ? "list" : "cards")}>{view === "cards" ? "☷ Список" : "▣ Карточки"}</button></div>
    {view === "list" ? <div className="question-list">{filtered.map((item, i) => <button key={item.id} onClick={() => choose(item.id)} className={known.includes(item.id) ? "known" : ""}><span>{i + 1}</span><div><small>{item.section}</small><strong>{item.text}</strong></div><b>{known.includes(item.id) ? "✓" : "→"}</b></button>)}</div> : current ? <div className="learn-card"><div className="card-meta"><span>{current.section}</span><b>{position + 1} / {visible.length}</b></div><h2>{current.text}</h2><div className="memory-actions"><button className={!known.includes(current.id) ? "active-repeat" : ""} onClick={() => saveKnown(current.id, false)}>↻ Повторить</button><button className={known.includes(current.id) ? "active-known" : ""} onClick={() => saveKnown(current.id, true)}>✓ Знаю</button></div><button className="reference-button" disabled={referenceLoading} onClick={loadReference}>{referenceLoading ? "Готовлю эталон…" : "★ Ответ на 21–25 баллов"}</button>{reference && <div className="reference-answer"><span>Эталон сохранён</span><p>{reference.answer}</p>{reference.keyPoints.length > 0 && <ul>{reference.keyPoints.map((point) => <li key={point}>{point}</li>)}</ul>}</div>}<details className="practice"><summary>Написать ответ и проверить</summary><textarea className="answer compact" value={answer} onChange={(e) => { setAnswer(e.target.value); setGrade(null); }} placeholder="Раскрой тему своими словами…"/>{error && <p className="inline-error">{error}</p>}<button className="primary" disabled={answer.trim().length < 20 || loading} onClick={check}>{loading ? "Проверяю…" : "Проверить по шкале 0–25"}</button>{grade && <div className="feedback"><span>{grade.level}</span><strong>{grade.score} / 25</strong><p>{grade.summary}</p>{grade.missing?.length > 0 && <ul>{grade.missing.map((x: string) => <li key={x}>{x}</li>)}</ul>}</div>}</details><button className="primary next-card" onClick={next}>Следующая тема →</button></div> : <div className="empty">По этому запросу ничего не найдено</div>}</>}
  </section>;
}

function Quiz({ subject, onBack, onComplete }: { subject: Subject; onBack: () => void; onComplete: () => void }) {
  const fallback = useMemo(() => demoQuestions.filter((item) => item.subject === subject.id).slice(0, 8), [subject.id]);
  const [questions, setQuestions] = useState<Question[]>([]); const [preparing, setPreparing] = useState(true); const [sourceLabel, setSourceLabel] = useState("новый набор");
  const [index, setIndex] = useState(0); const [choice, setChoice] = useState<number | null>(null); const [score, setScore] = useState(0); const [finished, setFinished] = useState(false);
  useEffect(() => { let active = true; const generate = async () => { const bank = questionBanks.find((item) => item.id === subject.id)!; const topics = bank.sections.flatMap((section) => section.questions).sort(() => Math.random() - .5).slice(0, 8); try { const response = await fetch("/api/quiz/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: bank.title, topics }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); const generated = body.questions.map((item: any, i: number) => ({ id: Date.now() + i, subject: subject.id, text: item.text, options: item.options, answer: item.answer, points: 1, explanation: item.explanation })); if (active) { setQuestions(generated); localStorage.setItem(`exam-quiz-${subject.id}`, JSON.stringify(generated)); } } catch { const cached = JSON.parse(localStorage.getItem(`exam-quiz-${subject.id}`) || "null"); if (active) { setQuestions(cached || fallback); setSourceLabel(cached ? "сохранённый набор" : "офлайн-набор"); } } finally { if (active) setPreparing(false); } }; generate(); return () => { active = false; }; }, [subject.id, subject.title, fallback]);
  if (preparing || questions.length === 0) return <section className="task-page loading-page"><button className="back" onClick={onBack}>← Выйти</button><div className="loader"/><p className="eyebrow">Собираю 8 случайных тем</p><h2 className="question">Готовлю новый тест без старой фиксированной восьмёрки…</h2></section>;
  const q = questions[index]; const max = questions.reduce((sum, x) => sum + x.points, 0);
  const next = () => { const earned = choice === q.answer ? q.points : 0; setScore((s) => s + earned); if (index === questions.length - 1) { setFinished(true); onComplete(); } else { setIndex(index + 1); setChoice(null); } };
  if (finished) return <section className="result"><button className="back" onClick={onBack}>← На главную</button><p className="eyebrow">Результат</p><h1>{score}<span>/{max}</span></h1><h2>{score / max >= .75 ? "Хороший темп" : "Ещё один подход — и лучше"}</h2><p>Демо-тест завершён. После OCR здесь появятся реальные задания и их баллы из PDF.</p><button className="primary" onClick={onBack}>Продолжить подготовку</button></section>;
  return <section className="task-page"><button className="back" onClick={onBack}>← Выйти</button><div className="task-meta"><span>{subject.short}</span><b>{index + 1} / {questions.length}</b><span>{q.points} балла</span></div><div className="progress"><i style={{width: `${((index + 1) / questions.length) * 100}%`}} /></div>
    <p className="eyebrow">{sourceLabel}</p><h2 className="question">{q.text}</h2><div className="options">{q.options.map((option, i) => <button className={choice === i ? "selected" : ""} onClick={() => setChoice(i)} key={option}><span>{String.fromCharCode(65 + i)}</span>{option}</button>)}</div>
    <button className="primary sticky" disabled={choice === null} onClick={next}>{index === questions.length - 1 ? "Завершить" : "Ответить"}</button>
  </section>;
}

function Written({ subject, onBack }: { subject: Subject; onBack: () => void }) {
  const [subjectId, setSubjectId] = useState(subject.id);
  const bank = questionBanks.find((item) => item.id === subjectId) || questionBanks[0];
  const activeSubject = subjects.find((item) => item.id === subjectId) || subject;
  const [sectionIndex, setSectionIndex] = useState(0);
  const pool = bank.sections[sectionIndex]?.questions.map((text, index) => ({ id: `${sectionIndex}-${index}`, subject: subjectId, section: bank.sections[sectionIndex].title, text })) || [];
  const [questionIndex, setQuestionIndex] = useState(0); const question = pool[questionIndex % Math.max(pool.length, 1)] || writtenQuestions[0];
  const draftKey = `exam-written-draft-${subjectId}-${question.id}`;
  const [answer, setAnswer] = useState(() => localStorage.getItem(draftKey) || ""); const [result, setResult] = useState<any>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const selectQuestion = (nextSubject: string, nextSection: number, nextQuestion: number) => {
    const nextBank = questionBanks.find((item) => item.id === nextSubject) || questionBanks[0];
    const safeSection = Math.min(nextSection, Math.max(nextBank.sections.length - 1, 0));
    const nextText = nextBank.sections[safeSection]?.questions[nextQuestion] || nextBank.sections[safeSection]?.questions[0] || "";
    const nextId = `${safeSection}-${nextText === nextBank.sections[safeSection]?.questions[nextQuestion] ? nextQuestion : 0}`;
    setSubjectId(nextSubject); setSectionIndex(safeSection); setQuestionIndex(nextText === nextBank.sections[safeSection]?.questions[nextQuestion] ? nextQuestion : 0);
    setAnswer(localStorage.getItem(`exam-written-draft-${nextSubject}-${nextId}`) || ""); setResult(null); setError("");
  };
  const check = async () => { setLoading(true); setError(""); setResult(null); try { const response = await fetch("/api/grade/written", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: question.text, answer }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); setResult(body); } catch (e: any) { setError(e.message || "Ошибка проверки"); } finally { setLoading(false); } };
  const next = () => selectQuestion(subjectId, sectionIndex, (questionIndex + 1) % Math.max(pool.length, 1));
  const random = () => { const randomSection = Math.floor(Math.random() * bank.sections.length); const count = bank.sections[randomSection]?.questions.length || 1; selectQuestion(subjectId, randomSection, Math.floor(Math.random() * count)); };
  const retry = () => {
    // Keep an explicit empty value so the next progress snapshot also clears
    // the old draft in the account instead of letting it return on another device.
    localStorage.setItem(draftKey, "");
    setAnswer(""); setResult(null); setError("");
    window.requestAnimationFrame(() => {
      answerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      answerRef.current?.focus({ preventScroll: true });
    });
  };
  return <section className="task-page written-page"><button className="back" onClick={onBack}>← Выйти</button><div className="task-meta"><span>{activeSubject.short}</span><b>Письменно</b><span>до 25 баллов</span></div>
    <div className="written-picker">
      <label><span>Предмет</span><select value={subjectId} onChange={(e) => selectQuestion(e.target.value, 0, 0)}>{subjects.map((item) => <option key={item.id} value={item.id}>{item.short} — {item.title}</option>)}</select></label>
      <label><span>Тема</span><select value={sectionIndex} onChange={(e) => selectQuestion(subjectId, Number(e.target.value), 0)}>{bank.sections.map((item, i) => <option key={item.title} value={i}>{i + 1}. {item.title} ({item.questions.length})</option>)}</select></label>
      <label className="question-picker"><span>Вопрос</span><select value={questionIndex} onChange={(e) => selectQuestion(subjectId, sectionIndex, Number(e.target.value))}>{pool.map((item, i) => <option key={item.id} value={i}>{i + 1}. {item.text}</option>)}</select></label>
      <button onClick={random}>⚄ Случайный</button>
    </div>
    <p className="eyebrow">{question.section || bank.sections[sectionIndex]?.title} · вопрос {questionIndex + 1}/{pool.length}</p><h2 className="question">{question.text}</h2>
    <QuestionNotes questionKey={`${subjectId}:${question.id}`} question={question.text} contextLabel={`${bank.title} · ${question.section || bank.sections[sectionIndex]?.title}`}/>
    <textarea ref={answerRef} className="answer" value={answer} onChange={(e) => {setAnswer(e.target.value); localStorage.setItem(draftKey, e.target.value); setResult(null)}} placeholder="Напиши полный развёрнутый ответ…" />
    {error && <div className="feedback error"><strong>Не удалось проверить</strong><p>{error}</p></div>}
    {result && <div className="feedback"><span>{result.level}</span><strong>{result.score} / 25 баллов</strong><p>{result.summary}</p>{result.strengths?.length > 0 && <><h4>Что хорошо</h4><ul>{result.strengths.map((x: string) => <li key={x}>{x}</li>)}</ul></>}{result.missing?.length > 0 && <><h4>Чего не хватило</h4><ul>{result.missing.map((x: string) => <li key={x}>{x}</li>)}</ul></>}<details><summary>Показать пример ответа</summary><p>{result.improvedAnswer}</p></details></div>}
    <button className="primary" disabled={answer.trim().length < 20 || loading} onClick={check}>{loading ? "Проверяю…" : "Проверить ответ"}</button>{result && <><button className="secondary" onClick={retry}>Пройти этот вопрос ещё раз</button><button className="secondary" onClick={next}>Следующий вопрос →</button></>}</section>;
}

function CodeTask({ subject, onBack }: { subject: Subject; onBack: () => void }) {
  const initial = `public class Main {\n  public static void main(String[] args) {\n    // твоё решение\n    \n  }\n}`;
  const allTasks = questionBanks.find((bank) => bank.id === subject.id)?.tasks.map((text, i) => ({ id: subject.id === "java" ? `full-${i}` : `${subject.id}-${i}`, title: `Задача ${i + 1}`, text })) || codeTasks;
  const [taskIndex, setTaskIndex] = useState(0); const task = allTasks.length ? allTasks[taskIndex % allTasks.length] : null;
  const [progress, setProgress] = useState<Record<string, TaskProgress>>(() => readStore("exam-task-progress", {}));
  const [code, setCode] = useState(() => (allTasks[0] && progress[allTasks[0].id]?.code) || localStorage.getItem("exam-code") || initial); const [message, setMessage] = useState(""); const [grade, setGrade] = useState<any>(null); const [loading, setLoading] = useState(false);
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const editor = codeRef.current;
    const start = editor?.selectionStart ?? code.length;
    const end = editor?.selectionEnd ?? start;
    setCode(`${code.slice(0, start)}${token}${code.slice(end)}`);
    window.requestAnimationFrame(() => {
      editor?.focus();
      editor?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  if (!task) return <section className="task-page code-page"><button className="back" onClick={onBack}>← Выйти</button><div className="empty"><strong>Для этого предмета задач с кодом нет</strong><p>Выбери «Интеллектуальные системы» или «Java-инженерию» на главной.</p></div></section>;
  const selectTask = (index: number) => { const selected = allTasks[index]; setTaskIndex(index); setCode(progress[selected.id]?.code || initial); setGrade(progress[selected.id] ? { score: progress[selected.id].score, level: progress[selected.id].level, summary: "Сохранённый результат", complexity: "Открой проверку снова для нового анализа.", hint: "Можно улучшить решение и перепроверить." } : null); setMessage(""); };
  const check = async () => { setLoading(true); setGrade(null); let compiler = "не запускался"; try { const compileResponse = await fetch("/api/java/compile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) }); const compileBody = await compileResponse.json(); compiler = compileBody.output || compileBody.error; setMessage(compiler); const gradeResponse = await fetch("/api/grade/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: task.text, code, compiler }) }); const body = await gradeResponse.json(); if (!gradeResponse.ok) throw new Error(body.error); setGrade(body); const item = { id: task.id, task: task.text, code, score: body.score, level: body.level, completed: body.score >= 31, updatedAt: new Date().toISOString() }; const nextProgress = { ...progress, [task.id]: item }; setProgress(nextProgress); localStorage.setItem("exam-task-progress", JSON.stringify(nextProgress)); } catch (e: any) { setMessage(e.message || "Проверка недоступна"); } finally { setLoading(false); } };
  const next = () => selectTask((taskIndex + 1) % allTasks.length);
  const completed = Object.values(progress).filter((item) => item.completed).length;
  return <section className="task-page code-page"><button className="back" onClick={onBack}>← Выйти</button><div className="task-meta"><span>{subject.short}</span><b>Выполнено {completed}/{allTasks.length}</b><span>до 50 баллов</span></div><select className="task-select" value={taskIndex} onChange={(e) => selectTask(Number(e.target.value))}>{allTasks.map((item, i) => <option value={i} key={item.id}>{progress[item.id]?.completed ? "✓" : progress[item.id] ? "•" : "○"} {item.title} {progress[item.id] ? `— ${progress[item.id].score}/50` : ""}</option>)}</select><p className="eyebrow">{task.title} · из программы</p><h2 className="question small">{task.text}</h2><div className="code-toolbar"><span>Main.java</span><b>Java 17</b></div><textarea ref={codeRef} className="code-editor" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
    <div className="key-row">{brackets.map((key) => <button key={key} onClick={() => insert(key)}>{key}</button>)}</div>{message && <div className="console">{message}</div>}
    {grade && <div className="feedback"><span>{grade.level}</span><strong>{grade.score} / 50 баллов</strong><p>{grade.summary}</p><h4>Сложность</h4><p>{grade.complexity}</p><h4>Подсказка</h4><p>{grade.hint}</p>{grade.issues?.length > 0 && <ul>{grade.issues.map((x: string) => <li key={x}>{x}</li>)}</ul>}</div>}
    <button className="primary" disabled={loading || code.trim().length < 20} onClick={check}>{loading ? "Проверяю…" : "▶ Проверить решение"}</button>{grade && <button className="secondary" onClick={next}>Следующая задача →</button>}</section>;
}

function Stats({ done, onBack, onOpenSubject }: { done: number; onBack: () => void; onOpenSubject: (subject: Subject) => void }) {
  const taskProgress = readStore<Record<string, TaskProgress>>("exam-task-progress", {}); const completedTasks = Object.values(taskProgress).filter((item) => item.completed).length; const references = Object.keys(readStore("exam-reference-answers", {})).length;
  const lectureProgress = readStore<Record<string, LectureProgress>>("exam-lecture-progress", {}); const completedLectures = Object.values(lectureProgress).filter((item) => item.completed).length; const listenedMinutes = Math.round(Object.values(lectureProgress).reduce((sum, item) => sum + item.listenedSeconds, 0) / 60);
  return <section className="task-page stats-page"><button className="back" onClick={onBack}>← На главную</button><p className="eyebrow">Прогресс</p><h1 className="stats-title">{done} <span>тестов завершено</span></h1><div className="stats-summary"><span><b>{completedTasks}</b> из 15 задач</span><span><b>{references}</b> эталонов</span><span><b>{completedLectures}</b> аудио засчитано<br/>{listenedMinutes} минут</span><span><b>{localStorage.getItem("exam-last-score") || "—"}</b> последний билет</span></div><div className="stats-subjects">{questionBanks.map((bank) => { const known = readStore<string[]>(`exam-known-${bank.id}`, []); const total = bank.sections.reduce((sum, section) => sum + section.questions.length, 0); const totalAudio = total + bank.sections.reduce((sum, section) => sum + Math.ceil(section.questions.length / 3), 0); const completedAudio = Object.values(lectureProgress).filter((item) => item.completed && (item.id.startsWith(`question-${bank.id}-`) || item.id.startsWith(`full-section-${bank.id}-`))).length; const open = () => { const selected = findSubject(bank.id); if (selected) onOpenSubject(selected); }; return <div role="button" tabIndex={0} aria-label={`Открыть темы: ${bank.title}`} key={bank.id} onClick={open} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}><h2>{bank.title}</h2><strong>{Math.round(known.length / total * 100)}%</strong><div className="learn-progress"><i style={{ width: `${known.length / total * 100}%` }}/></div><p className="audio-stat"><span>♫ Прослушано аудио</span><b>{completedAudio}/{totalAudio}</b></p>{bank.sections.map((section, sectionIndex) => { const count = section.questions.filter((_q, i) => known.includes(`${sectionIndex}-${i}`)).length; return <p key={section.title}><span>{section.title}</span><b>{count}/{section.questions.length}</b></p>})}<span className="stats-open">Открыть темы →</span></div>})}</div></section>;
}

function AnswerLibrary({ onBack }: { onBack: () => void }) {
  const [subjectId, setSubjectId] = useState("java"); const [query, setQuery] = useState(""); const [saved, setSaved] = useState<Record<string, SavedReference>>(() => readStore("exam-reference-answers", {})); const [selectedId, setSelectedId] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const answerRef = useRef<HTMLElement>(null);
  const bank = questionBanks.find((item) => item.id === subjectId)!; const items = bank.sections.flatMap((section, sectionIndex) => section.questions.map((question, questionIndex) => ({ id: `${subjectId}:${sectionIndex}-${questionIndex}`, section: section.title, question }))).filter((item) => item.question.toLowerCase().includes(query.toLowerCase())); const selected = items.find((item) => item.id === selectedId) || items[0]; const reference = selected ? saved[selected.id] : null;
  const chooseAnswer = (id: string) => {
    setSelectedId(id);
    if (window.matchMedia("(max-width: 760px)").matches) window.requestAnimationFrame(() => {
      answerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      answerRef.current?.focus({ preventScroll: true });
    });
  };
  const generate = async () => { if (!selected) return; setLoading(true); setError(""); try { const response = await fetch("/api/reference-answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: selected.question }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); const item = { id: selected.id, subject: bank.title, section: selected.section, question: selected.question, answer: body.answer, keyPoints: body.keyPoints, savedAt: new Date().toISOString() }; saveReference(item); const next = { ...saved, [item.id]: item }; setSaved(next); } catch (e: any) { setError(e.message || "Не удалось получить ответ"); } finally { setLoading(false); } };
  return <section className="answer-library"><button className="back" onClick={onBack}>← На главную</button><div className="learn-head"><div><p className="eyebrow">Библиотека</p><h1>Ответы на максимальный балл</h1></div><div className="learn-total"><b>{Object.keys(saved).length}</b><span>ответов<br/>сохранено</span></div></div><div className="library-controls"><select value={subjectId} onChange={(e) => { setSubjectId(e.target.value); setSelectedId(""); }}><option value="management">Цифровое производство</option><option value="systems">Интеллектуальные системы</option><option value="java">Java-инженерия</option></select><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти вопрос…"/></div><div className="library-layout"><aside>{items.map((item, i) => <button className={(selected?.id === item.id ? "selected " : "") + (saved[item.id] ? "saved" : "")} key={item.id} onClick={() => chooseAnswer(item.id)}><span>{saved[item.id] ? "★" : String(i + 1)}</span><div><small>{item.section}</small>{item.question}</div></button>)}</aside><article ref={answerRef} tabIndex={-1}>{selected && <><p className="eyebrow">{selected.section}</p><h2>{selected.question}</h2>{reference ? <div className="reference-full"><span>Эталон · 21–25 баллов</span><p>{reference.answer}</p><h3>Ключевые пункты</h3><ul>{reference.keyPoints.map((point) => <li key={point}>{point}</li>)}</ul></div> : <div className="reference-empty"><p>Эталон для этого вопроса ещё не создан. Он будет сохранён на устройстве после первого запроса.</p><button className="primary" disabled={loading} onClick={generate}>{loading ? "Готовлю ответ…" : "Создать эталонный ответ"}</button></div>}{error && <p className="inline-error">{error}</p>}</>}</article></div></section>;
}

function Exam({ subject, onBack }: { subject: Subject; onBack: () => void }) {
  const bank = questionBanks.find((item) => item.id === subject.id)!; const pool = bank.sections.flatMap((section, sectionIndex) => section.questions.map((text, i) => ({ id: `${sectionIndex}-${i}`, section: section.title, subject: subject.id, text })));
  const theory = useMemo(() => [...pool].sort(() => Math.random() - .5).slice(0, 2), [subject.id]);
  const taskPool = bank.tasks.length ? bank.tasks.map((text, i) => ({ id: `${subject.id}-${i}`, title: `Задача ${i + 1}`, text })) : codeTasks;
  const task = useMemo(() => taskPool[Math.floor(Math.random() * taskPool.length)], [subject.id]);
  const [seconds, setSeconds] = useState(3600); const [answers, setAnswers] = useState(["", ""]); const [code, setCode] = useState("public class Main {\n  public static void main(String[] args) {\n    // решение\n  }\n}"); const [loading, setLoading] = useState(false); const [result, setResult] = useState<any>(null); const [error, setError] = useState("");
  useEffect(() => { if (result || seconds <= 0) return; const timer = window.setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000); return () => clearInterval(timer); }, [result, seconds]);
  const submit = async () => { setLoading(true); setError(""); try { const gradeTheory = await Promise.all(theory.map(async (q, i) => { const r = await fetch("/api/grade/written", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q.text, answer: answers[i] }) }); const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; })); const r = await fetch("/api/grade/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: task.text, code }) }); const codeGrade = await r.json(); if (!r.ok) throw new Error(codeGrade.error); const total = gradeTheory[0].score + gradeTheory[1].score + codeGrade.score; setResult({ theory: gradeTheory, code: codeGrade, total }); localStorage.setItem("exam-last-score", String(total)); theory.forEach((q, i) => gradeTheory[i].improvedAnswer && saveReference({ id: `${subject.id}:${q.id}`, subject: bank.title, section: q.section, question: q.text, answer: gradeTheory[i].improvedAnswer, keyPoints: gradeTheory[i].missing || [], savedAt: new Date().toISOString() })); const progress = readStore<Record<string, TaskProgress>>("exam-task-progress", {}); progress[task.id] = { id: task.id, task: task.text, code, score: codeGrade.score, level: codeGrade.level, completed: codeGrade.score >= 31, updatedAt: new Date().toISOString() }; localStorage.setItem("exam-task-progress", JSON.stringify(progress)); } catch (e: any) { setError(e.message || "Не удалось проверить билет"); } finally { setLoading(false); } };
  if (result) return <section className="result"><button className="back" onClick={onBack}>← На главную</button><p className="eyebrow">Экзамен завершён</p><h1>{result.total}<span>/100</span></h1><h2>{result.total >= 75 ? "Уверенный результат" : result.total >= 50 ? "Есть база — усилим слабые места" : "Нужна ещё тренировка"}</h2><div className="ticket-scores"><span>Теория 1 <b>{result.theory[0].score}/25</b></span><span>Теория 2 <b>{result.theory[1].score}/25</b></span><span>Задача <b>{result.code.score}/50</b></span></div><div className="exam-result-notes"><h3>Заметки к вопросам билета</h3>{theory.map((question, index) => <QuestionNotes key={`${subject.id}:${question.id}`} questionKey={`${subject.id}:${question.id}`} question={question.text} contextLabel={`Вопрос ${index + 1} · ${bank.title} · ${question.section}`}/>)}</div><button className="primary" onClick={onBack}>На главную</button></section>;
  return <section className="task-page exam-page"><button className="back" onClick={onBack}>← Прервать</button><div className="task-meta"><span>{subject.short}</span><b>Полный билет</b><span className={seconds < 300 ? "danger" : ""}>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</span></div><p className="eyebrow">Вопрос 1 · 25 баллов</p><h2 className="question small">{theory[0].text}</h2><QuestionNotes questionKey={`${subject.id}:${theory[0].id}`} question={theory[0].text} contextLabel={`${bank.title} · ${theory[0].section}`}/><textarea className="answer compact" value={answers[0]} onChange={(e) => setAnswers([e.target.value, answers[1]])} placeholder="Ответ на первый вопрос…"/><p className="eyebrow exam-separator">Вопрос 2 · 25 баллов</p><h2 className="question small">{theory[1].text}</h2><QuestionNotes questionKey={`${subject.id}:${theory[1].id}`} question={theory[1].text} contextLabel={`${bank.title} · ${theory[1].section}`}/><textarea className="answer compact" value={answers[1]} onChange={(e) => setAnswers([answers[0], e.target.value])} placeholder="Ответ на второй вопрос…"/><p className="eyebrow exam-separator">Задача · 50 баллов</p><h2 className="question small">{task.text}</h2><textarea className="code-editor" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false}/>{error && <div className="feedback error"><p>{error}</p></div>}<button className="primary" disabled={loading || answers.some((a) => a.trim().length < 20) || code.length < 20} onClick={submit}>{loading ? "Проверяю весь билет…" : "Завершить и получить баллы"}</button></section>;
}

export default App;
