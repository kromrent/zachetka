import { useEffect, useMemo, useRef, useState } from "react";
import { codeTasks, demoQuestions, subjects, writtenQuestions, type Question, type Subject } from "./data";
import questionBankData from "./question-bank.json";

type Bank = { id: string; title: string; sections: { title: string; questions: string[] }[]; tasks: string[] };
const questionBanks = questionBankData as Bank[];
type SavedReference = { id: string; subject: string; section: string; question: string; answer: string; keyPoints: string[]; savedAt: string };
type TaskProgress = { id: string; task: string; code: string; score: number; level: string; completed: boolean; updatedAt: string };
type AccountUser = { id: number; username: string | null; displayName: string; telegram: boolean };
const readStore = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) || "") as T; } catch { return fallback; } };
const saveReference = (item: SavedReference) => { const current = readStore<Record<string, SavedReference>>("exam-reference-answers", {}); current[item.id] = item; localStorage.setItem("exam-reference-answers", JSON.stringify(current)); };
const progressSnapshot = () => Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => Boolean(key?.startsWith("exam-"))).map((key) => [key, localStorage.getItem(key)]));
const syncProgress = () => fetch("/api/progress", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(progressSnapshot()) }).catch(() => null);
type Screen = "home" | "learn" | "quiz" | "written" | "code" | "exam" | "answers" | "stats" | "account" | "lectures";
const brackets = ["{", "}", "(", ")", "[", "]", ";", "=", "=>"];

function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [subject, setSubject] = useState(subjects[2]);
  const [done, setDone] = useState(() => Number(localStorage.getItem("exam-done") || 0));
  const [user, setUser] = useState<AccountUser | null>(null);
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
    if (!sessionStorage.getItem(marker)) fetch("/api/progress").then((r) => r.json()).then(async (remote) => {
      sessionStorage.setItem(marker, "1");
      if (remote.data && Object.keys(remote.data).length) { Object.entries(remote.data).forEach(([key, value]) => typeof value === "string" && localStorage.setItem(key, value)); window.location.reload(); }
      else await syncProgress();
    }).catch(() => null);
    const timer = window.setInterval(syncProgress, 5000);
    return () => { clearInterval(timer); syncProgress(); };
  }, [user]);

  const navigate = (next: Screen, selected?: Subject) => {
    if (selected) setSubject(selected);
    setScreen(next);
    window.scrollTo(0, 0);
  };

  return <main className="shell">
    <header className="topbar">
      <button className="brand" onClick={() => navigate("home")} aria-label="На главную"><span>З</span> зачётка</button>
      <div className="top-actions"><button className={`account-pill ${user ? "online" : ""}`} onClick={() => navigate("account")}>{user ? user.displayName : "Войти"}</button><button className="avatar" onClick={() => navigate("stats")}>{done}</button></div>
    </header>
    {screen === "home" && <Home done={done} navigate={navigate} />}
    {screen === "learn" && <Learn subject={subject} onBack={() => navigate("home")} />}
    {screen === "quiz" && <Quiz subject={subject} onBack={() => navigate("home")} onComplete={() => { const n = done + 1; setDone(n); localStorage.setItem("exam-done", String(n)); }} />}
    {screen === "written" && <Written subject={subject} onBack={() => navigate("home")} />}
    {screen === "code" && <CodeTask onBack={() => navigate("home")} />}
    {screen === "exam" && <Exam subject={subject} onBack={() => navigate("home")} />}
    {screen === "answers" && <AnswerLibrary onBack={() => navigate("home")} />}
    {screen === "stats" && <Stats done={done} onBack={() => navigate("home")} />}
    {screen === "account" && <Account user={user} setUser={setUser} onBack={() => navigate("home")} />}
    {screen === "lectures" && <Lectures onBack={() => navigate("home")} />}
  </main>;
}

function Account({ user, setUser, onBack }: { user: AccountUser | null; setUser: (user: AccountUser | null) => void; onBack: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login"); const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const submit = async () => { setLoading(true); setError(""); try { const response = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); setUser(body.user); } catch (e: any) { setError(e.message || "Не удалось войти"); } finally { setLoading(false); } };
  const logout = async () => { await syncProgress(); await fetch("/api/auth/logout", { method: "POST" }); setUser(null); };
  return <section className="account-page"><button className="back" onClick={onBack}>← На главную</button><p className="eyebrow">Синхронизация</p><h1>{user ? "Аккаунт подключён" : "Продолжай с любого устройства"}</h1>{user ? <div className="account-card"><span className="sync-dot">●</span><div><strong>{user.displayName}</strong><p>{user.telegram ? "Вход через Telegram" : `Логин: ${user.username}`}<br/>Прогресс автоматически сохраняется каждые несколько секунд.</p></div><button className="secondary" onClick={logout}>Выйти</button></div> : <div className="auth-box"><div className="auth-tabs"><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Войти</button><button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Создать аккаунт</button></div><label>Логин<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></label><label>Пароль<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <p className="inline-error">{error}</p>}<button className="primary" disabled={loading || username.length < 3 || password.length < 8} onClick={submit}>{loading ? "Подключаю…" : mode === "login" ? "Войти и загрузить прогресс" : "Создать и синхронизировать"}</button><p className="auth-note">Внутри Telegram вход произойдёт автоматически. Пароль там вводить не потребуется.</p></div>}</section>;
}

function Home({ done, navigate }: { done: number; navigate: (s: Screen, subject?: Subject) => void }) {
  return <>
    <section className="hero">
      <div><p className="eyebrow">Твоя подготовка</p><h1>Спокойно.<br/><em>Ты сдашь.</em></h1></div>
      <div className="hero-score"><strong>{done}</strong><span>подходов<br/>завершено</span></div>
    </section>
    <section><div className="section-title"><h2>Предметы</h2><span>3 курса · 23 страницы</span></div>
      <div className="subjects">{subjects.map((item, i) => { const bank = questionBanks.find((x) => x.id === item.id); const count = bank?.sections.reduce((sum, section) => sum + section.questions.length, 0) || 0; return <button className={`subject ${item.color}`} key={item.id} onClick={() => navigate("learn", item)}>
        <span className="subject-index">0{i + 1}</span><span className="subject-code">{item.short}</span><strong>{item.title}</strong><small>{count} вопросов · {bank?.tasks.length || 0} задач</small><span className="arrow">↗</span>
      </button>})}</div>
    </section>
    <section><div className="section-title"><h2>Режим</h2><span>выбери формат</span></div>
      <div className="modes">
        <button onClick={() => navigate("learn", subjects[2])}><i>00</i><span><strong>Все темы</strong><small>198 вопросов · карточки</small></span><b>→</b></button>
        <button onClick={() => navigate("quiz", subjects[2])}><i>01</i><span><strong>Быстрый тест</strong><small>8 вопросов · один ответ</small></span><b>→</b></button>
        <button onClick={() => navigate("written", subjects[2])}><i>02</i><span><strong>Письменный ответ</strong><small>Проверка по критериям</small></span><b>→</b></button>
        <button onClick={() => navigate("code", subjects[2])}><i>03</i><span><strong>Написать код</strong><small>Java · редактор на телефоне</small></span><b>→</b></button>
        <button onClick={() => navigate("exam", subjects[2])}><i>04</i><span><strong>Полный билет</strong><small>60 минут · 100 баллов</small></span><b>→</b></button>
        <button onClick={() => navigate("answers")}><i>05</i><span><strong>Эталонные ответы</strong><small>Ответы на 21–25 баллов</small></span><b>→</b></button>
        <button onClick={() => navigate("lectures")}><i>06</i><span><strong>Лекции</strong><small>Слушать ответы по темам в фоне</small></span><b>♫</b></button>
      </div>
    </section>
    <section className="exam-format"><p className="eyebrow">Как на экзамене · 60 минут</p><div><span><b>25</b> теория №1</span><span><b>25</b> теория №2</span><span><b>50</b> задача</span><strong>100 баллов</strong></div></section>
    <p className="import-note"><span>●</span> Импорт: 23 страницы распознаны локально</p>
  </>;
}

type LectureTrack = { id: string; subject: string; section: string; sectionKey: string; title: string; mode: "question" | "section"; topics?: string[]; part?: number; partCount?: number };
function Lectures({ onBack }: { onBack: () => void }) {
  const [lectureMode, setLectureMode] = useState<"questions" | "sections">("questions");
  const [subjectId, setSubjectId] = useState("all"); const [sectionId, setSectionId] = useState("all");
  const [index, setIndex] = useState(() => Number(localStorage.getItem("exam-lecture-index") || 0));
  const [audioUrl, setAudioUrl] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [speed, setSpeed] = useState(1);
  const audioRef = useRef<HTMLAudioElement>(null); const urlRef = useRef("");
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
        mode: "question" as const
      }))));
  }, [lectureMode, subjectId, sectionId]);
  const sectionCount = new Set(tracks.map((track) => track.sectionKey)).size;
  const currentIndex = tracks.length ? index % tracks.length : 0; const current = tracks[currentIndex];
  useEffect(() => { setIndex(0); setAudioUrl(""); setError(""); if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = ""; } }, [lectureMode, subjectId, sectionId]);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  const requestBody = (track: LectureTrack) => ({ title: track.mode === "section" ? track.section : track.title, mode: track.mode, topics: track.topics });
  const cacheLocation = (track: LectureTrack) => {
    const version = track.mode === "section" ? "v4" : "v3";
    return { cacheName: `zachetka-lectures-${version}`, cacheKey: `/lecture-cache-${version}/${track.id}.mp3` };
  };
  const prefetch = async (track: LectureTrack | undefined) => {
    if (!track || !("caches" in window)) return;
    const { cacheName, cacheKey } = cacheLocation(track); const cache = await caches.open(cacheName); if (await cache.match(cacheKey)) return;
    const response = await fetch("/api/lectures/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody(track)) });
    if (response.ok) await cache.put(cacheKey, response);
  };
  const load = async (nextIndex = currentIndex, autoplay = true) => {
    const track = tracks[nextIndex]; if (!track) return; setLoading(true); setError("");
    try {
      const { cacheName, cacheKey } = cacheLocation(track); const cache = "caches" in window ? await caches.open(cacheName) : null;
      let audioResponse = cache ? await cache.match(cacheKey) : undefined;
      if (!audioResponse) { const response = await fetch("/api/lectures/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody(track)) }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || "Аудио недоступно"); } audioResponse = response; if (cache) await cache.put(cacheKey, response.clone()); }
      const blob = await audioResponse.blob(); if (urlRef.current) URL.revokeObjectURL(urlRef.current); const url = URL.createObjectURL(blob); urlRef.current = url; setIndex(nextIndex); setAudioUrl(url); localStorage.setItem("exam-lecture-index", String(nextIndex));
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.section, album: track.subject });
      if (autoplay) window.setTimeout(() => audioRef.current?.play().catch(() => null), 50);
    } catch (e: any) { setError(e.message || "Не удалось загрузить лекцию"); } finally { setLoading(false); }
  };
  const move = (delta: number) => { if (!tracks.length) return; load((currentIndex + delta + tracks.length) % tracks.length); };
  useEffect(() => { if (!("mediaSession" in navigator)) return; navigator.mediaSession.setActionHandler("nexttrack", () => move(1)); navigator.mediaSession.setActionHandler("previoustrack", () => move(-1)); return () => { navigator.mediaSession.setActionHandler("nexttrack", null); navigator.mediaSession.setActionHandler("previoustrack", null); }; });
  return <section className="lectures-page">
    <button className="back" onClick={onBack}>← На главную</button>
    <div className="lecture-head"><div><p className="eyebrow">Фоновое обучение</p><h1>Лекции</h1><p>Слушай отдельные вопросы подряд или одну цельную лекцию по всему разделу.</p></div><span>♫</span></div>
    <div className="lecture-mode-tabs">
      <button className={lectureMode === "questions" ? "active" : ""} onClick={() => setLectureMode("questions")}><strong>Все вопросы</strong><small>каждый вопрос — отдельный трек</small></button>
      <button className={lectureMode === "sections" ? "active" : ""} onClick={() => setLectureMode("sections")}><strong>По разделам</strong><small>полноценная связная лекция</small></button>
    </div>
    <div className="lecture-filters">
      <label>Предмет<select value={subjectId} onChange={(e) => { setSubjectId(e.target.value); setSectionId("all"); }}><option value="all">Все предметы</option>{questionBanks.map((bank) => <option value={bank.id} key={bank.id}>{bank.title}</option>)}</select></label>
      <label>Раздел<select value={sectionId} disabled={subjectId === "all"} onChange={(e) => setSectionId(e.target.value)}><option value="all">Все разделы</option>{sections.map((section, i) => <option value={i} key={section.title}>{section.title}</option>)}</select></label>
    </div>
    {current && <div className="lecture-player">
      <div className="lecture-number">{currentIndex + 1} / {tracks.length}</div><small>{current.subject} · {current.section}</small><h2>{current.title}</h2>
      {current.mode === "section" && <p className="lecture-coverage">Часть {current.part} из {current.partCount} · {current.topics?.length || 0} полных ответа · части включаются автоматически</p>}
      {!audioUrl ? <button className="lecture-start" disabled={loading} onClick={() => load(currentIndex)}>{loading ? "Готовлю лекцию…" : "▶ Начать слушать"}</button> : <><audio ref={audioRef} src={audioUrl} controls playsInline onPlay={() => prefetch(tracks[(currentIndex + 1) % tracks.length]).catch(() => null)} onEnded={() => move(1)} onLoadedMetadata={() => { if (audioRef.current) audioRef.current.playbackRate = speed; }} /><div className="lecture-controls"><button onClick={() => move(-1)}>← Предыдущая</button><label>Скорость<select value={speed} onChange={(e) => { const value = Number(e.target.value); setSpeed(value); if (audioRef.current) audioRef.current.playbackRate = value; }}><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><button onClick={() => move(1)}>Следующая →</button></div></>}
      {loading && audioUrl && <p className="lecture-loading">Готовлю следующий трек…</p>}{error && <p className="inline-error">{error}</p>}
    </div>}
    <div className="lecture-queue"><div className="section-title"><h2>{lectureMode === "questions" ? "Все вопросы" : "Полные лекции по разделам"}</h2><span>{lectureMode === "questions" ? `${tracks.length} вопросов` : `${sectionCount} разделов · ${tracks.length} частей`}</span></div><div className="lecture-queue-list">{tracks.map((track, trackIndex) => <button className={trackIndex === currentIndex ? "active" : ""} key={track.id} onClick={() => load(trackIndex)}><span>{trackIndex + 1}</span><div><small>{track.subject} · {track.section}</small><strong>{track.title}</strong>{track.mode === "section" && <em>{track.topics?.length || 0} вопроса: сначала формулировка, затем полный ответ</em>}</div></button>)}</div></div>
  </section>;
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
  return <section className="task-page written-page"><button className="back" onClick={onBack}>← Выйти</button><div className="task-meta"><span>{activeSubject.short}</span><b>Письменно</b><span>до 25 баллов</span></div>
    <div className="written-picker">
      <label><span>Предмет</span><select value={subjectId} onChange={(e) => selectQuestion(e.target.value, 0, 0)}>{subjects.map((item) => <option key={item.id} value={item.id}>{item.short} — {item.title}</option>)}</select></label>
      <label><span>Тема</span><select value={sectionIndex} onChange={(e) => selectQuestion(subjectId, Number(e.target.value), 0)}>{bank.sections.map((item, i) => <option key={item.title} value={i}>{i + 1}. {item.title} ({item.questions.length})</option>)}</select></label>
      <label className="question-picker"><span>Вопрос</span><select value={questionIndex} onChange={(e) => selectQuestion(subjectId, sectionIndex, Number(e.target.value))}>{pool.map((item, i) => <option key={item.id} value={i}>{i + 1}. {item.text}</option>)}</select></label>
      <button onClick={random}>⚄ Случайный</button>
    </div>
    <p className="eyebrow">{question.section || bank.sections[sectionIndex]?.title} · вопрос {questionIndex + 1}/{pool.length}</p><h2 className="question">{question.text}</h2><textarea className="answer" value={answer} onChange={(e) => {setAnswer(e.target.value); localStorage.setItem(draftKey, e.target.value); setResult(null)}} placeholder="Напиши полный развёрнутый ответ…" />
    {error && <div className="feedback error"><strong>Не удалось проверить</strong><p>{error}</p></div>}
    {result && <div className="feedback"><span>{result.level}</span><strong>{result.score} / 25 баллов</strong><p>{result.summary}</p>{result.strengths?.length > 0 && <><h4>Что хорошо</h4><ul>{result.strengths.map((x: string) => <li key={x}>{x}</li>)}</ul></>}{result.missing?.length > 0 && <><h4>Чего не хватило</h4><ul>{result.missing.map((x: string) => <li key={x}>{x}</li>)}</ul></>}<details><summary>Показать пример ответа</summary><p>{result.improvedAnswer}</p></details></div>}
    <button className="primary" disabled={answer.trim().length < 20 || loading} onClick={check}>{loading ? "Проверяю…" : "Проверить ответ"}</button>{result && <button className="secondary" onClick={next}>Следующий вопрос →</button>}</section>;
}

function CodeTask({ onBack }: { onBack: () => void }) {
  const initial = `public class Main {\n  public static void main(String[] args) {\n    // твоё решение\n    \n  }\n}`;
  const allTasks = questionBanks.find((bank) => bank.id === "java")?.tasks.map((text, i) => ({ id: `full-${i}`, title: `Задача ${i + 1}`, text })) || codeTasks;
  const [taskIndex, setTaskIndex] = useState(0); const task = allTasks[taskIndex % allTasks.length];
  const [progress, setProgress] = useState<Record<string, TaskProgress>>(() => readStore("exam-task-progress", {}));
  const [code, setCode] = useState(() => progress[allTasks[0].id]?.code || localStorage.getItem("exam-code") || initial); const [message, setMessage] = useState(""); const [grade, setGrade] = useState<any>(null); const [loading, setLoading] = useState(false);
  const insert = (token: string) => setCode((value) => value + token);
  const selectTask = (index: number) => { const selected = allTasks[index]; setTaskIndex(index); setCode(progress[selected.id]?.code || initial); setGrade(progress[selected.id] ? { score: progress[selected.id].score, level: progress[selected.id].level, summary: "Сохранённый результат", complexity: "Открой проверку снова для нового анализа.", hint: "Можно улучшить решение и перепроверить." } : null); setMessage(""); };
  const check = async () => { setLoading(true); setGrade(null); let compiler = "не запускался"; try { const compileResponse = await fetch("/api/java/compile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) }); const compileBody = await compileResponse.json(); compiler = compileBody.output || compileBody.error; setMessage(compiler); const gradeResponse = await fetch("/api/grade/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: task.text, code, compiler }) }); const body = await gradeResponse.json(); if (!gradeResponse.ok) throw new Error(body.error); setGrade(body); const item = { id: task.id, task: task.text, code, score: body.score, level: body.level, completed: body.score >= 31, updatedAt: new Date().toISOString() }; const nextProgress = { ...progress, [task.id]: item }; setProgress(nextProgress); localStorage.setItem("exam-task-progress", JSON.stringify(nextProgress)); } catch (e: any) { setMessage(e.message || "Проверка недоступна"); } finally { setLoading(false); } };
  const next = () => selectTask((taskIndex + 1) % allTasks.length);
  const completed = Object.values(progress).filter((item) => item.completed).length;
  return <section className="task-page code-page"><button className="back" onClick={onBack}>← Выйти</button><div className="task-meta"><span>JAVA</span><b>Выполнено {completed}/{allTasks.length}</b><span>до 50 баллов</span></div><select className="task-select" value={taskIndex} onChange={(e) => selectTask(Number(e.target.value))}>{allTasks.map((item, i) => <option value={i} key={item.id}>{progress[item.id]?.completed ? "✓" : progress[item.id] ? "•" : "○"} {item.title} {progress[item.id] ? `— ${progress[item.id].score}/50` : ""}</option>)}</select><p className="eyebrow">{task.title} · из программы</p><h2 className="question small">{task.text}</h2><div className="code-toolbar"><span>Main.java</span><b>Java 17</b></div><textarea className="code-editor" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
    <div className="key-row">{brackets.map((key) => <button key={key} onClick={() => insert(key)}>{key}</button>)}</div>{message && <div className="console">{message}</div>}
    {grade && <div className="feedback"><span>{grade.level}</span><strong>{grade.score} / 50 баллов</strong><p>{grade.summary}</p><h4>Сложность</h4><p>{grade.complexity}</p><h4>Подсказка</h4><p>{grade.hint}</p>{grade.issues?.length > 0 && <ul>{grade.issues.map((x: string) => <li key={x}>{x}</li>)}</ul>}</div>}
    <button className="primary" disabled={loading || code.trim().length < 20} onClick={check}>{loading ? "Проверяю…" : "▶ Проверить решение"}</button>{grade && <button className="secondary" onClick={next}>Следующая задача →</button>}</section>;
}

function Stats({ done, onBack }: { done: number; onBack: () => void }) {
  const taskProgress = readStore<Record<string, TaskProgress>>("exam-task-progress", {}); const completedTasks = Object.values(taskProgress).filter((item) => item.completed).length; const references = Object.keys(readStore("exam-reference-answers", {})).length;
  return <section className="task-page stats-page"><button className="back" onClick={onBack}>← На главную</button><p className="eyebrow">Прогресс</p><h1 className="stats-title">{done} <span>тестов завершено</span></h1><div className="stats-summary"><span><b>{completedTasks}</b> из 15 задач</span><span><b>{references}</b> эталонов</span><span><b>{localStorage.getItem("exam-last-score") || "—"}</b> последний билет</span></div><div className="stats-subjects">{questionBanks.map((bank) => { const known = readStore<string[]>(`exam-known-${bank.id}`, []); const total = bank.sections.reduce((sum, section) => sum + section.questions.length, 0); return <div key={bank.id}><h2>{bank.title}</h2><strong>{Math.round(known.length / total * 100)}%</strong><div className="learn-progress"><i style={{ width: `${known.length / total * 100}%` }}/></div>{bank.sections.map((section, sectionIndex) => { const count = section.questions.filter((_q, i) => known.includes(`${sectionIndex}-${i}`)).length; return <p key={section.title}><span>{section.title}</span><b>{count}/{section.questions.length}</b></p>})}</div>})}</div></section>;
}

function AnswerLibrary({ onBack }: { onBack: () => void }) {
  const [subjectId, setSubjectId] = useState("java"); const [query, setQuery] = useState(""); const [saved, setSaved] = useState<Record<string, SavedReference>>(() => readStore("exam-reference-answers", {})); const [selectedId, setSelectedId] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const bank = questionBanks.find((item) => item.id === subjectId)!; const items = bank.sections.flatMap((section, sectionIndex) => section.questions.map((question, questionIndex) => ({ id: `${subjectId}:${sectionIndex}-${questionIndex}`, section: section.title, question }))).filter((item) => item.question.toLowerCase().includes(query.toLowerCase())); const selected = items.find((item) => item.id === selectedId) || items[0]; const reference = selected ? saved[selected.id] : null;
  const generate = async () => { if (!selected) return; setLoading(true); setError(""); try { const response = await fetch("/api/reference-answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: selected.question }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); const item = { id: selected.id, subject: bank.title, section: selected.section, question: selected.question, answer: body.answer, keyPoints: body.keyPoints, savedAt: new Date().toISOString() }; saveReference(item); const next = { ...saved, [item.id]: item }; setSaved(next); } catch (e: any) { setError(e.message || "Не удалось получить ответ"); } finally { setLoading(false); } };
  return <section className="answer-library"><button className="back" onClick={onBack}>← На главную</button><div className="learn-head"><div><p className="eyebrow">Библиотека</p><h1>Ответы на максимальный балл</h1></div><div className="learn-total"><b>{Object.keys(saved).length}</b><span>ответов<br/>сохранено</span></div></div><div className="library-controls"><select value={subjectId} onChange={(e) => { setSubjectId(e.target.value); setSelectedId(""); }}><option value="management">Цифровое производство</option><option value="systems">Интеллектуальные системы</option><option value="java">Java-инженерия</option></select><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти вопрос…"/></div><div className="library-layout"><aside>{items.map((item, i) => <button className={(selected?.id === item.id ? "selected " : "") + (saved[item.id] ? "saved" : "")} key={item.id} onClick={() => setSelectedId(item.id)}><span>{saved[item.id] ? "★" : String(i + 1)}</span><div><small>{item.section}</small>{item.question}</div></button>)}</aside><article>{selected && <><p className="eyebrow">{selected.section}</p><h2>{selected.question}</h2>{reference ? <div className="reference-full"><span>Эталон · 21–25 баллов</span><p>{reference.answer}</p><h3>Ключевые пункты</h3><ul>{reference.keyPoints.map((point) => <li key={point}>{point}</li>)}</ul></div> : <div className="reference-empty"><p>Эталон для этого вопроса ещё не создан. Он будет сохранён на устройстве после первого запроса.</p><button className="primary" disabled={loading} onClick={generate}>{loading ? "Готовлю ответ…" : "Создать эталонный ответ"}</button></div>}{error && <p className="inline-error">{error}</p>}</>}</article></div></section>;
}

function Exam({ subject, onBack }: { subject: Subject; onBack: () => void }) {
  const bank = questionBanks.find((item) => item.id === subject.id)!; const pool = bank.sections.flatMap((section, sectionIndex) => section.questions.map((text, i) => ({ id: `${sectionIndex}-${i}`, section: section.title, subject: subject.id, text })));
  const theory = useMemo(() => [...pool].sort(() => Math.random() - .5).slice(0, 2), [subject.id]);
  const taskPool = bank.tasks.length ? bank.tasks.map((text, i) => ({ id: `${subject.id}-${i}`, title: `Задача ${i + 1}`, text })) : codeTasks;
  const task = useMemo(() => taskPool[Math.floor(Math.random() * taskPool.length)], [subject.id]);
  const [seconds, setSeconds] = useState(3600); const [answers, setAnswers] = useState(["", ""]); const [code, setCode] = useState("public class Main {\n  public static void main(String[] args) {\n    // решение\n  }\n}"); const [loading, setLoading] = useState(false); const [result, setResult] = useState<any>(null); const [error, setError] = useState("");
  useEffect(() => { if (result || seconds <= 0) return; const timer = window.setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000); return () => clearInterval(timer); }, [result, seconds]);
  const submit = async () => { setLoading(true); setError(""); try { const gradeTheory = await Promise.all(theory.map(async (q, i) => { const r = await fetch("/api/grade/written", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q.text, answer: answers[i] }) }); const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; })); const r = await fetch("/api/grade/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: task.text, code }) }); const codeGrade = await r.json(); if (!r.ok) throw new Error(codeGrade.error); const total = gradeTheory[0].score + gradeTheory[1].score + codeGrade.score; setResult({ theory: gradeTheory, code: codeGrade, total }); localStorage.setItem("exam-last-score", String(total)); theory.forEach((q, i) => gradeTheory[i].improvedAnswer && saveReference({ id: `${subject.id}:${q.id}`, subject: bank.title, section: q.section, question: q.text, answer: gradeTheory[i].improvedAnswer, keyPoints: gradeTheory[i].missing || [], savedAt: new Date().toISOString() })); const progress = readStore<Record<string, TaskProgress>>("exam-task-progress", {}); progress[task.id] = { id: task.id, task: task.text, code, score: codeGrade.score, level: codeGrade.level, completed: codeGrade.score >= 31, updatedAt: new Date().toISOString() }; localStorage.setItem("exam-task-progress", JSON.stringify(progress)); } catch (e: any) { setError(e.message || "Не удалось проверить билет"); } finally { setLoading(false); } };
  if (result) return <section className="result"><button className="back" onClick={onBack}>← На главную</button><p className="eyebrow">Экзамен завершён</p><h1>{result.total}<span>/100</span></h1><h2>{result.total >= 75 ? "Уверенный результат" : result.total >= 50 ? "Есть база — усилим слабые места" : "Нужна ещё тренировка"}</h2><div className="ticket-scores"><span>Теория 1 <b>{result.theory[0].score}/25</b></span><span>Теория 2 <b>{result.theory[1].score}/25</b></span><span>Задача <b>{result.code.score}/50</b></span></div><button className="primary" onClick={onBack}>На главную</button></section>;
  return <section className="task-page exam-page"><button className="back" onClick={onBack}>← Прервать</button><div className="task-meta"><span>{subject.short}</span><b>Полный билет</b><span className={seconds < 300 ? "danger" : ""}>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</span></div><p className="eyebrow">Вопрос 1 · 25 баллов</p><h2 className="question small">{theory[0].text}</h2><textarea className="answer compact" value={answers[0]} onChange={(e) => setAnswers([e.target.value, answers[1]])} placeholder="Ответ на первый вопрос…"/><p className="eyebrow exam-separator">Вопрос 2 · 25 баллов</p><h2 className="question small">{theory[1].text}</h2><textarea className="answer compact" value={answers[1]} onChange={(e) => setAnswers([answers[0], e.target.value])} placeholder="Ответ на второй вопрос…"/><p className="eyebrow exam-separator">Задача · 50 баллов</p><h2 className="question small">{task.text}</h2><textarea className="code-editor" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false}/>{error && <div className="feedback error"><p>{error}</p></div>}<button className="primary" disabled={loading || answers.some((a) => a.trim().length < 20) || code.length < 20} onClick={submit}>{loading ? "Проверяю весь билет…" : "Завершить и получить баллы"}</button></section>;
}

export default App;
