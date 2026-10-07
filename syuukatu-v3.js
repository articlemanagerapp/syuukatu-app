// 就活管理 v3
// ・データは Firebase Realtime Database の users/{uid}/v3 に保存する(旧版 v2 の users/{uid}/data には書き込まない)。
// ・初めて開いたときは旧版のデータ(users/{uid}/data)から自動で作る(migrateFromV2)。
// ・データの形:
//     tracks[]    選考区分(夏インターン・秋冬インターン・早期選考・本選考 …)
//     companies[] 企業(企業研究・志望の軸・マイページのログイン情報など、区分をまたいで共通の情報)
//     entries[]   選考(企業 × 区分。選考フロー・予定・ES・面接対策・メモ)
//     todos       今日すること / 今週すること
//     settings    APIキー・フロー型など
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, get, set } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const firebaseConfig = { apiKey: "AIzaSyB8-VCe66GK77czczFqJKIDqfTaC1jTi8g", authDomain: "shukatsu-app-ae30e.firebaseapp.com", databaseURL: "https://shukatsu-app-ae30e-default-rtdb.asia-southeast1.firebasedatabase.app", projectId: "shukatsu-app-ae30e" };
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const rtdb = getDatabase(fbApp);

/* ========================================================================
 * 定数
 * ====================================================================== */
const DATA_VERSION = 3;
const KINDS = {
  es:        { label: 'ES締切',   icon: '📄', color: '#c2410c' },
  test:      { label: '適性検査', icon: '🧮', color: '#6d28d9' },
  session:   { label: '説明会',   icon: '🎤', color: '#047857' },
  interview: { label: '面接',     icon: '🗣️', color: '#b91c1c' },
  intern:    { label: 'インターン', icon: '💼', color: '#1d4ed8' },
  other:     { label: 'その他',   icon: '📌', color: '#475569' },
};
const KIND_ORDER = ['es', 'test', 'session', 'interview', 'intern', 'other'];
const STEP_STATUS = { not_started: '未着手', current: '進行中', completed: '完了', rejected: '落選' };
const STATUS_META = {
  todo:     { label: '未着手',   cls: 'st-todo' },
  progress: { label: '選考中',   cls: 'st-progress' },
  passed:   { label: '通過',     cls: 'st-passed' },
  rejected: { label: '落選',     cls: 'st-rejected' },
  closed:   { label: '終了',     cls: 'st-closed' },
};
const STATUS_ORDER = ['progress', 'todo', 'passed', 'rejected', 'closed'];
const ES_CATEGORIES = ['ガクチカ', '自己PR', '志望動機', '研究概要', '長所・短所', '希望職種', 'その他'];
const STEP_SUGGEST = ['エントリー', '説明会', 'ES提出', '適性検査', 'GD', '1次面接', '2次面接', '最終面接', 'インターン参加', '早期選考の案内', '内定'];
const TRACK_COLORS = ['#1971c2', '#7048e8', '#2b8a3e', '#d9480f', '#c2255c', '#0c8599', '#5c940d', '#495057'];
const DEFAULT_TRACKS = [
  { id: 'aw',     name: '秋冬インターン', color: '#1971c2', archived: false },
  { id: 'early',  name: '早期選考',       color: '#7048e8', archived: false },
  { id: 'main',   name: '本選考',         color: '#2b8a3e', archived: false },
  { id: 'summer', name: '夏インターン',   color: '#d9480f', archived: true },
];
const NAV = [
  { id: 'home',      label: 'ホーム',   icon: '🏠' },
  { id: 'companies', label: '企業',     icon: '🏢' },
  { id: 'schedule',  label: '予定',     icon: '🗓️' },
  { id: 'es',        label: 'ES集',     icon: '📝' },
  { id: 'settings',  label: '設定',     icon: '⚙️' },
];
const MS_DAY = 86400000;

/* ========================================================================
 * 状態
 * ====================================================================== */
const S = {
  user: null,
  db: null,
  calendar: null,
  ui: loadUi(),
  openQ: new Set(),     // 開いている ES 設問カード
  ai: {},               // AI 添削の結果(保存しない)
  lastRouteKey: '',
};
function loadUi() {
  const d = { track: 'active', schedMode: 'list', kinds: KIND_ORDER.slice(), showDone: false, showPast: false, sort: 'next', calDate: '' };
  try { return { ...d, ...JSON.parse(localStorage.getItem('shukatsu_v3_ui') || '{}') }; } catch { return d; }
}
function saveUi() { try { localStorage.setItem('shukatsu_v3_ui', JSON.stringify(S.ui)); } catch { /* 保存できなくても動く */ } }

/* ========================================================================
 * 小さな道具
 * ====================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = p => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const toArr = v => Array.isArray(v) ? v.filter(x => x != null) : (v && typeof v === 'object' ? Object.values(v).filter(x => x != null) : []);
const pad = n => String(n).padStart(2, '0');
const clone = o => JSON.parse(JSON.stringify(o));
const fv = (form, name) => (form.elements.namedItem(name)?.value ?? '').trim();
const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : 'https://' + String(u || '').replace(/^[a-z]+:\/*/i, '');
const pid = s => (s.parentId === undefined || s.parentId === null || s.parentId === '') ? null : s.parentId;

function parseD(s) {
  if (!s) return null;
  const d = String(s).length <= 10 ? new Date(s + 'T00:00:00') : new Date(s);
  return isNaN(d) ? null : d;
}
function today0() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function dayOf(s) { const d = parseD(s); if (!d) return null; d.setHours(0, 0, 0, 0); return d; }
function daysUntil(s) { const d = dayOf(s); return d ? Math.round((d - today0()) / MS_DAY) : null; }
function isAllDay(s) { return !!s && String(s).length <= 10; }
function fmtDate(s, withTime = true) {
  const d = parseD(s); if (!d) return '';
  const w = '日月火水木金土'[d.getDay()];
  const y = d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() + '/' : '';
  let out = `${y}${d.getMonth() + 1}/${d.getDate()}(${w})`;
  if (withTime && !isAllDay(s)) out += ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return out;
}
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function isoWeek(d) {
  const date = new Date(d.getTime()); date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const week1 = new Date(date.getFullYear(), 0, 4);
  return date.getFullYear() + '-W' + Math.round(((date - week1) / MS_DAY - 3 + (week1.getDay() + 6) % 7) / 7);
}

/* ========================================================================
 * データの形をそろえる・旧版から移行する
 * ====================================================================== */
function emptyDb() {
  return {
    version: DATA_VERSION,
    tracks: clone(DEFAULT_TRACKS),
    companies: [], entries: [],
    todos: { today: [], week: [] },
    settings: { geminiApiKey: '', googleApiKey: '', googleClientId: '', flowTemplates: [], lastTodoDay: '', lastTodoWeek: '' },
  };
}
function normStep(s, i) {
  return { id: s.id || ('step_' + i + '_' + Date.now().toString(36)), name: s.name || '', status: STEP_STATUS[s.status] ? s.status : 'not_started', parentId: pid(s) };
}
function normTemplates(t) {
  // 旧版は { 名前: [ステップ…] } の形。v3 は [{ id, name, steps }]
  if (Array.isArray(t) || (t && typeof t === 'object' && Object.values(t).some(v => v && v.steps))) {
    return toArr(t).map(x => ({ id: x.id || newId('tpl'), name: x.name || '名前なし', steps: toArr(x.steps).map(normStep) }));
  }
  return Object.entries(t || {}).map(([name, steps]) => ({ id: newId('tpl'), name, steps: toArr(steps).map(normStep) }));
}
function normTodos(t) { return { today: toArr(t?.today).map(x => ({ text: x.text || '', done: !!x.done })), week: toArr(t?.week).map(x => ({ text: x.text || '', done: !!x.done })) }; }
function normalizeDb(raw) {
  const db = emptyDb();
  const tracks = toArr(raw?.tracks);
  if (tracks.length) db.tracks = tracks.map((t, i) => ({ id: t.id || newId('t'), name: t.name || '区分', color: t.color || TRACK_COLORS[i % TRACK_COLORS.length], archived: !!t.archived }));
  db.companies = toArr(raw?.companies).map(c => ({ ...c, id: c.id || newId('c'), name: c.name || '名称未設定' }));
  db.entries = toArr(raw?.entries).map(e => ({
    ...e,
    id: e.id || newId('e'),
    flow: toArr(e.flow).map(normStep),
    events: toArr(e.events).map(ev => ({ ...ev, id: ev.id || newId('ev'), kind: KINDS[ev.kind] ? ev.kind : 'other' })),
    esQuestions: toArr(e.esQuestions).map(q => ({ ...q, id: q.id || newId('q') })),
  }));
  db.todos = normTodos(raw?.todos);
  db.settings = { ...db.settings, ...(raw?.settings || {}) };
  db.settings.flowTemplates = normTemplates(raw?.settings?.flowTemplates);
  db.migratedFromV2At = raw?.migratedFromV2At || '';
  db.updatedAt = raw?.updatedAt || '';
  return db;
}

// 旧版(v2)の 1社 = 1行 のデータを、企業(共通情報)+ 選考(区分ごと)に分ける
function migrateFromV2(val, baseSettings) {
  const db = emptyDb();
  const os = val?.settings || {};
  db.settings = { ...db.settings, ...(baseSettings || {}), geminiApiKey: os.geminiApiKey || baseSettings?.geminiApiKey || '', googleApiKey: os.googleApiKey || baseSettings?.googleApiKey || '', googleClientId: os.googleClientId || baseSettings?.googleClientId || '', lastTodoDay: '', lastTodoWeek: '' };
  db.settings.flowTemplates = normTemplates(os.flowTemplates || baseSettings?.flowTemplates);
  db.todos = normTodos(val?.todos);
  toArr(val?.data).forEach((item, idx) => {
    const r = item.companyResearch || {};
    const baseId = item.id || String(Date.now() + idx);
    const company = {
      id: 'c_' + baseId, name: item.company || '名称未設定',
      industry: r.industry || '', founder: r.founder || '', rivals: r.rivals || '', strengths: r.strengths || '',
      salary: r.salary || '', vacation: r.vacation || '', bonus: r.bonus || '',
      axis: item.interviewAxis || '', website: '', memo: '',
      mypageUrl: item.mypageUrl || '', mypageId: item.mypageId || '', mypagePass: item.mypagePass || '',
      createdAt: Number(baseId) ? new Date(Number(baseId)).toISOString() : '',
    };
    const trackId = (item.internStart === '秋' || item.internStart === '冬') ? 'aw' : 'summer';
    const events = [];
    const push = (kind, title, start, extra = {}) => { if (start) events.push({ id: newId('ev'), kind, title, start, end: '', done: false, note: '', ...extra }); };
    push('es', 'ES締切', item.esDeadline);
    push('test', '適性検査', item.testDate);
    push('interview', '面接', item.interviewDate);
    push('session', '説明会', item.sessionDate, { note: item.sessionStatus || '' });
    toArr(item.internDates).forEach(d => push('intern', d.title || 'インターン', d.start, { end: d.end || '' }));
    const memo = [];
    if (item.hasSession || item.sessionStatus) memo.push(`説明会: ${item.hasSession || '-'} / 申込: ${item.sessionStatus || '-'}`);
    if (item.sessionMemo) memo.push(item.sessionMemo);
    if (item.esText) memo.push('【提出したESのメモ(旧版の手動メモ)】\n' + item.esText);
    db.companies.push(company);
    db.entries.push({
      id: 'e_' + baseId, companyId: company.id, trackId,
      flow: toArr(r.selectionFlow).map(normStep),
      events,
      esQuestions: toArr(item.esQuestions).map(q => ({ id: q.id || newId('q'), category: q.category || '', question: q.question || '', memo: q.memoAnswer || '', answer: q.finalAnswer || '', limit: '' })),
      interviewNote: item.interviewNote || '', reverseQuestions: '',
      memo: memo.join('\n\n'), location: item.location || '', closed: '',
      createdAt: company.createdAt,
    });
  });
  db.migratedFromV2At = new Date().toISOString();
  return db;
}

/* ========================================================================
 * データの読み書き
 * ====================================================================== */
const backupKey = () => 'shukatsu_v3_backup_' + (S.user ? S.user.uid : '');
let saveTimer = null;
function setSaveState(kind, msg) {
  const el = $('#save-state'); if (!el) return;
  el.className = 'save-state ' + kind;
  el.textContent = { pending: '✏️ 編集中', saving: '⏳ 保存中…', saved: '☁️ 保存済み', error: '❌ 保存できませんでした' }[kind] || '';
  el.title = msg || '';
}
function scheduleSave() { setSaveState('pending'); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700); }
async function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!S.user || !S.db) return;
  S.db.updatedAt = new Date().toISOString();
  const payload = clone(S.db);
  try { localStorage.setItem(backupKey(), JSON.stringify(payload)); } catch { /* 端末の保存は予備なので失敗してもよい */ }
  setSaveState('saving');
  try {
    await set(ref(rtdb, `users/${S.user.uid}/v3`), payload);
    setSaveState('saved');
  } catch (e) {
    console.error(e);
    setSaveState('error', e.message);
    toast('保存できませんでした。通信状態を確認してください(' + e.message + ')');
  }
}
window.addEventListener('beforeunload', e => { if (saveTimer) { saveNow(); e.preventDefault(); e.returnValue = ''; } });

async function loadUserData(user) {
  const snap = await get(ref(rtdb, `users/${user.uid}`));
  const val = snap.val() || {};
  let db, note = '';
  if (val.v3) {
    db = normalizeDb(val.v3);
  } else {
    let local = null;
    try { local = JSON.parse(localStorage.getItem('shukatsu_v3_backup_' + user.uid) || 'null'); } catch { local = null; }
    if (local && toArr(local.companies).length && confirm(`サーバーに新しい版のデータが見つかりませんでした。\nこの端末に ${local.updatedAt ? new Date(local.updatedAt).toLocaleString() : ''} の控えがあります。控えから復元しますか?\n(キャンセルすると旧版のデータから作り直します)`)) {
      db = normalizeDb(local); note = 'この端末の控えから復元しました';
    } else if (val.data) {
      db = migrateFromV2(val); note = `旧版のデータ(${db.companies.length}社)を新しい形に移しました。夏インターンの企業は「夏インターン(終了)」にまとめています`;
    } else {
      db = emptyDb();
    }
  }
  S.db = db;
  const reset = checkTodoReset();
  if (!val.v3) await saveNow(); else if (reset) scheduleSave();
  return note;
}

function checkTodoReset() {
  const st = S.db.settings; const now = new Date();
  const day = ymd(now), week = isoWeek(now); let changed = false;
  if (st.lastTodoDay !== day) { S.db.todos.today = S.db.todos.today.filter(t => !t.done); st.lastTodoDay = day; changed = true; }
  if (st.lastTodoWeek !== week) { S.db.todos.week = S.db.todos.week.filter(t => !t.done); st.lastTodoWeek = week; changed = true; }
  return changed;
}

/* ========================================================================
 * データの参照
 * ====================================================================== */
const tracks = () => S.db.tracks;
const trackById = id => S.db.tracks.find(t => t.id === id);
const companyById = id => S.db.companies.find(c => c.id === id);
const entryById = id => S.db.entries.find(e => e.id === id);
const entriesOf = cid => S.db.entries.filter(e => e.companyId === cid).sort((a, b) => trackIndex(a.trackId) - trackIndex(b.trackId));
const trackIndex = id => { const i = S.db.tracks.findIndex(t => t.id === id); return i < 0 ? 999 : i; };
function filterValid() { if (S.ui.track !== 'active' && !trackById(S.ui.track)) S.ui.track = 'active'; }
function trackVisible(trackId) {
  const t = trackById(trackId);
  if (S.ui.track === 'active') return !!t && !t.archived;
  return S.ui.track === trackId;
}
const visibleEntries = () => S.db.entries.filter(e => trackVisible(e.trackId) && companyById(e.companyId));

// 選考フローの状態: 先頭から順にたどる(落選の後に「別ルート」があればそちらを続けて見る)
function walkFlow(flow, parentId) {
  const seq = flow.filter(s => pid(s) === parentId);
  let res = { key: 'todo', step: seq[0] || null };
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    if (s.status === 'completed') {
      res = i === seq.length - 1 ? { key: 'passed', step: s } : { key: 'progress', step: seq[i + 1], next: true };
    } else if (s.status === 'current') {
      return { key: 'progress', step: s };
    } else if (s.status === 'rejected') {
      const kids = flow.filter(x => pid(x) === s.id);
      if (!kids.length) return { key: 'rejected', step: s };
      const r = walkFlow(flow, s.id);
      return r.key === 'todo' ? { key: 'progress', step: kids[0], next: true } : r;
    } else break;
  }
  return res;
}
function entryStatus(en) {
  if (en.closed) return { key: 'closed', label: en.closed, step: null };
  const flow = en.flow || [];
  if (!flow.length) return { key: 'todo', label: STATUS_META.todo.label, step: null };
  const r = walkFlow(flow, null);
  let label = STATUS_META[r.key].label;
  if (r.key === 'progress' && r.step) label = (r.next ? '次: ' : '進行中: ') + r.step.name;
  if (r.key === 'rejected' && r.step) label = `${r.step.name}で落選`;
  if (r.key === 'passed' && r.step) label = `${r.step.name} 完了`;
  return { key: r.key, label, step: r.step };
}
const isInactive = en => { const k = entryStatus(en).key; return k === 'rejected' || k === 'closed'; };
// 画面に出す順(落選の後に別ルートがあれば、そのルートを続けて並べる)
function flowPath(flow, parentId = null, branch = false) {
  const out = [];
  for (const s of flow.filter(x => pid(x) === parentId)) {
    out.push({ ...s, branch });
    if (s.status === 'rejected' && flow.some(c => pid(c) === s.id)) { out.push(...flowPath(flow, s.id, true)); break; }
  }
  return out;
}

function collectEvents(entries) {
  const out = [];
  entries.forEach(en => {
    const c = companyById(en.companyId); if (!c) return;
    (en.events || []).forEach(ev => { if (parseD(ev.start)) out.push({ ev, en, c, tr: trackById(en.trackId) }); });
  });
  return out.sort((a, b) => parseD(a.ev.start) - parseD(b.ev.start));
}
function eventEndDay(ev) { return dayOf(ev.end || ev.start); }
function upcoming(entries, { includeDone = false } = {}) {
  const t = today0();
  return collectEvents(entries).filter(x => eventEndDay(x.ev) >= t && (includeDone || !x.ev.done) && !isInactive(x.en));
}
function nextEventOf(en) { return upcoming([en])[0] || null; }

/* ========================================================================
 * HTML の部品
 * ====================================================================== */
const trackChip = t => t ? `<span class="track-chip" style="--t:${esc(t.color)}">${esc(t.name)}${t.archived ? '(終了)' : ''}</span>` : '';
const kindChip = (ev) => { const k = KINDS[ev.kind] || KINDS.other; return `<span class="kind-chip" style="--k:${k.color}">${k.icon} ${esc(ev.title || k.label)}</span>`; };
const statusBadge = st => `<span class="status ${STATUS_META[st.key].cls}">${esc(st.label)}</span>`;
function countdown(ev) {
  const d = daysUntil(ev.start);
  if (d === null) return '';
  if (d < 0) return `<span class="pill pill-soon">開催中</span>`;
  const text = d === 0 ? '今日' : d === 1 ? '明日' : `あと${d}日`;
  const cls = d <= 3 ? 'pill-urgent' : d <= 7 ? 'pill-soon' : 'pill-normal';
  return `<span class="pill ${cls}">${text}</span>`;
}
function dateRangeText(ev) {
  const s = fmtDate(ev.start);
  return ev.end && ev.end !== ev.start ? `${s} 〜 ${fmtDate(ev.end)}` : s;
}
function eventRow(x, { check = true } = {}) {
  const k = KINDS[x.ev.kind] || KINDS.other;
  return `<li class="ev-row ${x.ev.done ? 'done' : ''}">
    ${check ? `<input type="checkbox" class="form-check-input" aria-label="${esc(x.c.name)} ${esc(x.ev.title || k.label)} を済みにする" data-change="event-done" data-id="${x.en.id}" data-sub="${x.ev.id}" ${x.ev.done ? 'checked' : ''}>` : ''}
    <div class="ev-date"><span class="ev-day">${esc(dateRangeText(x.ev))}</span>${x.ev.done ? '<span class="pill pill-normal">済</span>' : countdown(x.ev)}</div>
    <a class="ev-body" href="#/company/${x.c.id}/${x.en.id}">${kindChip(x.ev)} <strong>${esc(x.c.name)}</strong> ${trackChip(x.tr)}</a>
  </li>`;
}
function stepper(flow, compact = false) {
  const path = flowPath(flow || []);
  if (!path.length) return `<span class="muted small">選考フローが未設定</span>`;
  return `<ol class="stepper ${compact ? 'compact' : ''}" aria-label="選考フロー">${path.map((s, i) => {
    const mark = s.status === 'completed' ? '✓' : s.status === 'rejected' ? '×' : i + 1;
    return `<li class="s-${s.status} ${s.branch ? 'branch' : ''}" title="${esc(s.name)}(${STEP_STATUS[s.status]})"><span class="dot" aria-hidden="true">${mark}</span><span class="lbl">${esc(s.name)}<span class="visually-hidden">: ${STEP_STATUS[s.status]}</span></span></li>`;
  }).join('')}</ol>`;
}
const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
// 入力欄とデータを結びつける属性(入力するとその場で保存される)
const bind = (scope, id, field, sub = '') => `data-scope="${scope}" data-id="${esc(id)}" ${sub ? `data-sub="${esc(sub)}"` : ''} data-field="${field}"`;

/* ========================================================================
 * 画面の切り替え(URL の # で管理するので、ブラウザの戻るが使える)
 * ====================================================================== */
function parseRoute() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'home').split('/').map(decodeURIComponent);
  return { name: parts[0] || 'home', a: parts[1] || '', b: parts[2] || '', c: parts[3] || '' };
}
const VIEWS = { home: viewHome, companies: viewCompanies, company: viewCompany, schedule: viewSchedule, es: viewEsLibrary, settings: viewSettings };

function render() {
  if (!S.db) return;
  filterValid();
  const r = parseRoute();
  if (!VIEWS[r.name]) { location.hash = '#/home'; return; }
  const navId = r.name === 'company' ? 'companies' : r.name;
  const navHtml = NAV.map(n => `<li><a href="#/${n.id}" ${n.id === navId ? 'aria-current="page"' : ''}><span class="ico" aria-hidden="true">${n.icon}</span>${n.label}</a></li>`).join('');
  $('#side-nav').innerHTML = navHtml;
  $('#bottom-nav').innerHTML = NAV.map(n => `<a href="#/${n.id}" ${n.id === navId ? 'aria-current="page"' : ''}><span class="ico" aria-hidden="true">${n.icon}</span>${n.label}</a>`).join('');
  const showTracks = ['home', 'companies', 'schedule', 'es'].includes(r.name);
  $('#track-bar').hidden = !showTracks;
  if (showTracks) $('#track-bar').innerHTML = trackBarHtml();

  if (S.calendar) { S.calendar.destroy(); S.calendar = null; }
  const out = VIEWS[r.name](r);
  $('#page-title').textContent = out.title;
  document.title = out.title + ' | 就活管理';
  const view = $('#view');
  const key = r.name + '/' + r.a + '/' + r.b + '/' + r.c;
  const keepScroll = key === S.lastRouteKey ? window.scrollY : 0;
  view.innerHTML = out.html;
  if (out.after) out.after();
  view.querySelectorAll('textarea[data-autosize]').forEach(autosize);
  if (key !== S.lastRouteKey) { window.scrollTo(0, 0); } else { window.scrollTo(0, keepScroll); }
  S.lastRouteKey = key;
}
window.addEventListener('hashchange', render);

function trackBarHtml() {
  const count = id => S.db.entries.filter(e => e.trackId === id && companyById(e.companyId)).length;
  const activeCnt = S.db.entries.filter(e => { const t = trackById(e.trackId); return t && !t.archived && companyById(e.companyId); }).length;
  const chip = (id, name, color, n, archived) => `<button type="button" class="tchip ${archived ? 'archived' : ''}" style="--t:${esc(color)}" aria-pressed="${S.ui.track === id}" data-act="set-track" data-id="${esc(id)}"><span class="dot" aria-hidden="true"></span>${esc(name)}<span class="cnt">${n}</span></button>`;
  const active = tracks().filter(t => !t.archived), archived = tracks().filter(t => t.archived);
  return chip('active', '進行中の区分すべて', '#1d4ed8', activeCnt, false)
    + active.map(t => chip(t.id, t.name, t.color, count(t.id), false)).join('')
    + (archived.length ? `<span class="sep" aria-hidden="true"></span>` + archived.map(t => chip(t.id, t.name + '(終了)', t.color, count(t.id), true)).join('') : '');
}
// 「進行中の区分」で何も無いが、終了した区分にはデータがあるときの案内
function archivedHint() {
  if (S.ui.track !== 'active') return '';
  const arch = tracks().filter(t => t.archived && S.db.entries.some(e => e.trackId === t.id && companyById(e.companyId)));
  if (!arch.length) return '';
  return `<br><span class="small">終了した区分のデータは ${arch.map(t => `<button type="button" class="btn btn-sm btn-outline-secondary" data-act="set-track" data-id="${t.id}">${esc(t.name)}(終了)</button>`).join(' ')} で見られます。</span>`;
}
const filterName = () => S.ui.track === 'active' ? '進行中の区分' : (trackById(S.ui.track)?.name || '');

/* ========================================================================
 * ホーム
 * ====================================================================== */
function viewHome() {
  const ents = visibleEntries();
  const ups = upcoming(ents);
  const in7 = ups.filter(x => daysUntil(x.ev.start) <= 7).length;
  const byStatus = {}; STATUS_ORDER.forEach(k => { byStatus[k] = []; });
  ents.forEach(en => byStatus[entryStatus(en).key].push(en));
  const companiesCnt = new Set(ents.map(e => e.companyId)).size;

  let trackTiles = '';
  if (S.ui.track === 'active') {
    trackTiles = `<div class="track-tiles">${tracks().filter(t => !t.archived).map(t => {
      const es = S.db.entries.filter(e => e.trackId === t.id && companyById(e.companyId));
      const prog = es.filter(e => entryStatus(e).key === 'progress').length;
      const pass = es.filter(e => entryStatus(e).key === 'passed').length;
      const nx = upcoming(es)[0];
      return `<button type="button" class="track-tile" style="--t:${esc(t.color)}" data-act="set-track" data-id="${t.id}">
        <div class="name">${esc(t.name)}</div>
        <div class="meta">${es.length}社 ・ 選考中 ${prog} ・ 通過 ${pass}</div>
        <div class="meta">${nx ? `次: ${esc(fmtDate(nx.ev.start, false))} ${esc(nx.c.name)}(${esc(nx.ev.title || KINDS[nx.ev.kind].label)})` : '予定なし'}</div>
      </button>`;
    }).join('')}</div>`;
  }

  const tiles = `<div class="tiles">
    <div class="tile"><div class="num">${companiesCnt}</div><div class="lbl">企業(${esc(filterName())})</div></div>
    <div class="tile"><div class="num">${byStatus.progress.length}</div><div class="lbl">選考中</div></div>
    <div class="tile"><div class="num">${byStatus.passed.length}</div><div class="lbl">通過</div></div>
    <div class="tile"><div class="num" style="color:${in7 ? 'var(--danger)' : 'inherit'}">${in7}</div><div class="lbl">7日以内の予定</div></div>
  </div>`;

  const upHtml = ups.length
    ? `<ul class="ev-list">${ups.slice(0, 8).map(x => eventRow(x)).join('')}</ul>${ups.length > 8 ? `<a class="back-link" href="#/schedule">すべての予定(${ups.length}件)を見る →</a>` : ''}`
    : `<div class="empty">これからの予定はありません。<br>企業の詳細画面の「進捗・予定」から ES締切や面接の日時を登録できます。</div>`;

  const todoBlock = (type, label) => `<div>
    <h3 class="small fw-bold mb-1">${label}</h3>
    <form class="d-flex gap-2" data-form="todo-add" data-id="${type}">
      <input type="text" class="form-control" name="text" placeholder="やることを入力" aria-label="${label}に追加する内容">
      <button class="btn btn-outline-primary" type="submit">追加</button>
    </form>
    <ul class="todo-list">${S.db.todos[type].map((t, i) => `<li class="${t.done ? 'done' : ''}">
      <input type="checkbox" class="form-check-input" id="todo-${type}-${i}" data-change="todo-toggle" data-id="${type}" data-sub="${i}" ${t.done ? 'checked' : ''}>
      <label for="todo-${type}-${i}">${esc(t.text)}</label>
      <button type="button" class="btn btn-sm btn-icon btn-outline-danger border-0" data-act="todo-del" data-id="${type}" data-sub="${i}" aria-label="「${esc(t.text)}」を削除">✕</button>
    </li>`).join('') || '<li class="muted small">なし</li>'}</ul>
    <p class="muted small mb-0">済みにした項目は${type === 'today' ? '翌日' : '翌週'}に自動で消えます</p>
  </div>`;

  const groupLabels = { progress: '選考中', todo: '未着手', passed: '通過', rejected: '落選', closed: '終了・辞退' };
  const board = STATUS_ORDER.map(k => {
    const list = byStatus[k].sort((a, b) => {
      const na = nextEventOf(a), nb = nextEventOf(b);
      return (na ? parseD(na.ev.start) : Infinity) - (nb ? parseD(nb.ev.start) : Infinity);
    });
    if (!list.length) return '';
    const open = k === 'progress' || k === 'todo' || k === 'passed';
    return `<details class="board-group" ${open ? 'open' : ''}><summary>${groupLabels[k]} <span class="status ${STATUS_META[k].cls}">${list.length}</span></summary>
      ${list.map(en => {
        const c = companyById(en.companyId), st = entryStatus(en), nx = nextEventOf(en);
        return `<a class="brow" href="#/company/${c.id}/${en.id}">
          <span class="who"><strong>${esc(c.name)}</strong><span>${trackChip(trackById(en.trackId))} ${statusBadge(st)}</span></span>
          <span class="flow">${stepper(en.flow, true)}</span>
          <span class="next">${nx ? `${esc(KINDS[nx.ev.kind].icon)} ${esc(fmtDate(nx.ev.start))}<br>${countdown(nx.ev)}` : '予定なし'}</span>
        </a>`;
      }).join('')}
    </details>`;
  }).join('');

  return {
    title: 'ホーム',
    html: `${trackTiles}${tiles}
      <div class="grid-2">
        <section class="card-x"><h2>📌 これからの予定 <span class="muted small">(${esc(filterName())})</span></h2>${upHtml}</section>
        <section class="card-x"><h2>✅ やること</h2><div class="stack">${todoBlock('today', '今日すること')}${todoBlock('week', '今週すること')}</div></section>
      </div>
      <section class="card-x mt-3"><h2>🏢 選考状況 <span class="muted small">(${esc(filterName())}・次の予定が近い順)</span></h2>
        ${board || `<div class="empty">この区分の企業はまだありません。<br>右上の「＋企業を追加」から登録しましょう。${archivedHint()}</div>`}
      </section>`,
  };
}

/* ========================================================================
 * 企業一覧
 * ====================================================================== */
function viewCompanies() {
  const q = (S.ui.search || '').trim().toLowerCase();
  let list = S.db.companies.filter(c => {
    const ents = entriesOf(c.id);
    if (S.ui.track === 'active') { if (ents.length && !ents.some(e => trackVisible(e.trackId))) return false; }
    else if (!ents.some(e => e.trackId === S.ui.track)) return false;
    if (q && !(`${c.name} ${c.industry || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const visEnts = c => entriesOf(c.id).filter(e => trackVisible(e.trackId));
  const nextOf = c => upcoming(visEnts(c))[0];
  const sorters = {
    next: (a, b) => { const na = nextOf(a), nb = nextOf(b); return (na ? parseD(na.ev.start) : Infinity) - (nb ? parseD(nb.ev.start) : Infinity) || a.name.localeCompare(b.name, 'ja'); },
    name: (a, b) => a.name.localeCompare(b.name, 'ja'),
    status: (a, b) => {
      const best = c => Math.min(...visEnts(c).map(e => STATUS_ORDER.indexOf(entryStatus(e).key)), 99);
      return best(a) - best(b) || a.name.localeCompare(b.name, 'ja');
    },
    added: (a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)),
  };
  list.sort(sorters[S.ui.sort] || sorters.next);

  const cards = list.map(c => {
    const ents = visEnts(c), nx = nextOf(c);
    const others = entriesOf(c.id).filter(e => !trackVisible(e.trackId));
    return `<article class="ccard">
      <a class="ccard-main" href="#/company/${c.id}">
        <h3>${esc(c.name)}</h3>
        ${c.industry ? `<div class="small muted">${esc(c.industry)}</div>` : ''}
        ${ents.map(en => `<div class="ccard-entry">${trackChip(trackById(en.trackId))} ${statusBadge(entryStatus(en))}</div>`).join('') || '<div class="small muted">この区分の選考はまだありません</div>'}
        ${others.length ? `<div class="small muted">ほかの区分: ${others.map(e => esc(trackById(e.trackId)?.name || '')).join('、')}</div>` : ''}
        <div class="ccard-next">${nx ? `次の予定: ${kindChip(nx.ev)} ${esc(fmtDate(nx.ev.start))} ${countdown(nx.ev)}` : '次の予定: なし'}</div>
      </a>
      <div class="ccard-actions">
        <button type="button" class="btn btn-sm btn-outline-secondary" data-act="login-info" data-id="${c.id}">🔑 ログイン情報</button>
        ${c.mypageUrl ? `<a class="btn btn-sm btn-outline-primary" href="${esc(safeUrl(c.mypageUrl))}" target="_blank" rel="noopener">マイページを開く ↗</a>` : ''}
      </div>
    </article>`;
  }).join('');

  return {
    title: '企業',
    html: `<div class="toolbar">
        <input type="search" class="form-control grow" placeholder="企業名・業界で検索" aria-label="企業を検索" value="${esc(S.ui.search || '')}" data-ui="search">
        <label class="d-flex align-items-center gap-2 small fw-bold muted">並び順
          <select class="form-select" data-change="sort" style="width:auto">
            ${opt('next', '次の予定が近い順', S.ui.sort)}${opt('status', '選考状況順', S.ui.sort)}${opt('name', '名前順', S.ui.sort)}${opt('added', '追加が新しい順', S.ui.sort)}
          </select></label>
      </div>
      <p class="muted small">${esc(filterName())}: ${list.length}社</p>
      ${list.length ? `<div class="clist">${cards}</div>` : `<div class="empty">${q ? '見つかりませんでした。' : 'この区分の企業はまだありません。<br>「＋企業を追加」から登録するか、すでに登録した企業の詳細画面で「＋選考を追加」してください。' + archivedHint()}</div>`}`,
  };
}

/* ========================================================================
 * 企業の詳細
 * ====================================================================== */
function viewCompany(r) {
  const c = companyById(r.a);
  if (!c) return { title: '企業', html: `<div class="empty">企業が見つかりません。<br><a href="#/companies">企業一覧へ</a></div>` };
  const ents = entriesOf(c.id);
  let sub = r.b;
  if (!sub) {
    const pref = ents.find(e => trackVisible(e.trackId)) || ents.find(e => !trackById(e.trackId)?.archived) || ents[0];
    sub = pref ? pref.id : 'research';
  }
  const tabs = ents.map(en => {
    const t = trackById(en.trackId), st = entryStatus(en);
    return `<a role="tab" href="#/company/${c.id}/${en.id}" aria-selected="${sub === en.id}"><span class="track-chip" style="--t:${esc(t?.color || '#64748b')}">${esc(t?.name || '区分なし')}</span><span class="status ${STATUS_META[st.key].cls}">${esc(STATUS_META[st.key].label)}</span></a>`;
  }).join('');

  let body;
  const en = entryById(sub);
  if (en && en.companyId === c.id) body = entryPanel(c, en, r.c || 'flow');
  else if (sub === 'account') body = accountPanel(c);
  else { sub = 'research'; body = researchPanel(c); }

  return {
    title: c.name,
    html: `<a class="back-link" href="#/companies">← 企業一覧</a>
      <div class="detail-head">
        <div class="ttl"><h2>${esc(c.name)}</h2>${c.industry ? `<div class="muted">${esc(c.industry)}</div>` : ''}</div>
        <button type="button" class="btn btn-outline-secondary" data-act="login-info" data-id="${c.id}">🔑 ログイン情報</button>
        <button type="button" class="btn btn-outline-danger" data-act="company-del" data-id="${c.id}">企業を削除</button>
      </div>
      <nav class="tabs" role="tablist" aria-label="${esc(c.name)} の情報">
        ${tabs}
        <button type="button" class="btn btn-sm btn-outline-primary align-self-center" data-act="entry-add" data-id="${c.id}">＋ 選考を追加</button>
        <span class="tab-gap" aria-hidden="true"></span>
        <a role="tab" href="#/company/${c.id}/research" aria-selected="${sub === 'research'}">🏢 企業研究</a>
        <a role="tab" href="#/company/${c.id}/account" aria-selected="${sub === 'account'}">🔑 マイページ</a>
      </nav>
      ${body}`,
  };
}

function entryPanel(c, en, tab) {
  const t = trackById(en.trackId), st = entryStatus(en);
  const base = `#/company/${c.id}/${en.id}`;
  const subtabs = [['flow', '🚀 進捗・予定'], ['es', `📝 ES(${en.esQuestions.length})`], ['interview', '🗣️ 面接対策']];
  if (!subtabs.some(s => s[0] === tab)) tab = 'flow';
  const head = `<div class="entry-head">
    ${trackChip(t)} ${statusBadge(st)}
    <span class="grow"></span>
    <label>区分 <select class="form-select form-select-sm" data-change="entry-move" data-id="${en.id}" style="width:auto">${tracks().map(x => opt(x.id, x.name + (x.archived ? '(終了)' : ''), en.trackId)).join('')}</select></label>
    <label>結果 <select class="form-select form-select-sm" data-change="entry-closed" data-id="${en.id}" style="width:auto">
      ${opt('', 'フローから自動', en.closed)}${opt('辞退', '辞退した', en.closed)}${opt('終了', '終了(参加済みなど)', en.closed)}${opt('見送り', '見送り', en.closed)}</select></label>
    <button type="button" class="btn btn-sm btn-outline-danger" data-act="entry-del" data-id="${en.id}">この選考を削除</button>
  </div>`;
  const nav = `<nav class="subtabs" role="tablist">${subtabs.map(([k, l]) => `<a role="tab" href="${base}/${k}" aria-selected="${tab === k}">${l}</a>`).join('')}</nav>`;
  const body = tab === 'es' ? esPanel(c, en) : tab === 'interview' ? interviewPanel(c, en) : flowPanel(c, en);
  return head + nav + body;
}

function flowPanel(c, en) {
  const rows = [];
  const draw = (parentId, depth) => {
    const sibs = en.flow.filter(s => pid(s) === parentId);
    sibs.forEach((s, i) => {
      rows.push(`<div class="flow-row ${depth ? 'branch' : ''}">
        <span class="no">${depth ? '↳' : (i + 1) + '.'}</span>
        <input type="text" class="form-control form-control-sm" value="${esc(s.name)}" aria-label="ステップ名" ${bind('step', en.id, 'name', s.id)} data-rerender>
        <select class="form-select form-select-sm sel-${s.status}" data-change="flow-status" data-id="${en.id}" data-sub="${s.id}" aria-label="${esc(s.name)} の状態">${Object.entries(STEP_STATUS).map(([k, l]) => opt(k, l, s.status)).join('')}</select>
        ${s.status === 'rejected' ? `<button type="button" class="btn btn-sm btn-outline-danger" data-act="flow-branch" data-id="${en.id}" data-sub="${s.id}" title="落選のあとに別ルート(例: 別日程・別コース)を追加">↳ 別ルート</button>` : ''}
        <button type="button" class="btn btn-sm btn-icon btn-outline-secondary" data-act="flow-move" data-dir="-1" data-id="${en.id}" data-sub="${s.id}" aria-label="${esc(s.name)} を上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn btn-sm btn-icon btn-outline-secondary" data-act="flow-move" data-dir="1" data-id="${en.id}" data-sub="${s.id}" aria-label="${esc(s.name)} を下へ" ${i === sibs.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn btn-sm btn-icon btn-outline-danger border-0" data-act="flow-del" data-id="${en.id}" data-sub="${s.id}" aria-label="${esc(s.name)} を削除">✕</button>
      </div>`);
      draw(s.id, depth + 1);
    });
  };
  draw(null, 0);
  const tpls = S.db.settings.flowTemplates;

  const evs = (en.events || []).slice().sort((a, b) => (parseD(a.start) || Infinity) - (parseD(b.start) || Infinity));
  const evRows = evs.map(ev => {
    const range = ev.kind === 'intern';
    const typ = range ? 'date' : 'datetime-local';
    const v = s => range ? String(s || '').slice(0, 10) : (s && String(s).length <= 10 ? s + 'T00:00' : (s || ''));
    return `<div class="evt-edit ${ev.done ? 'done' : ''}">
      <input type="checkbox" class="form-check-input" aria-label="済みにする" ${bind('event', en.id, 'done', ev.id)} ${ev.done ? 'checked' : ''}>
      <select class="form-select form-select-sm k" data-change="event-kind" data-id="${en.id}" data-sub="${ev.id}" aria-label="種類">${KIND_ORDER.map(k => opt(k, KINDS[k].icon + ' ' + KINDS[k].label, ev.kind)).join('')}</select>
      <input type="text" class="form-control form-control-sm t" value="${esc(ev.title)}" placeholder="名前(例: 1次面接)" aria-label="予定の名前" ${bind('event', en.id, 'title', ev.id)}>
      <div class="dates">
        <input type="${typ}" class="form-control form-control-sm" value="${esc(v(ev.start))}" aria-label="${range ? '開始日' : '日時'}" ${bind('event', en.id, 'start', ev.id)}>
        ${range ? `<span aria-hidden="true">〜</span><input type="date" class="form-control form-control-sm" value="${esc(v(ev.end))}" aria-label="終了日" ${bind('event', en.id, 'end', ev.id)}>` : ''}
      </div>
      <button type="button" class="btn btn-sm btn-icon btn-outline-danger border-0 del" data-act="event-del" data-id="${en.id}" data-sub="${ev.id}" aria-label="この予定を削除">✕</button>
    </div>`;
  }).join('');

  return `<div class="grid-2">
    <section class="card-x">
      <h2>🚀 選考フロー</h2>
      ${stepper(en.flow)}
      <div class="mt-3">${rows.join('') || '<p class="muted small">下の入力欄からステップを追加するか、「フロー型」を使ってください。</p>'}</div>
      <form class="d-flex gap-2 mt-2" data-form="flow-add" data-id="${en.id}">
        <input type="text" class="form-control" name="stepname" placeholder="ステップを追加(例: 1次面接)" list="step-suggest" aria-label="追加するステップ名">
        <button class="btn btn-outline-primary" type="submit">＋ 追加</button>
      </form>
      <datalist id="step-suggest">${STEP_SUGGEST.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
      <div class="d-flex flex-wrap gap-2 align-items-center mt-3 pt-3 border-top">
        <label class="small fw-bold muted" for="tpl-${en.id}">フロー型</label>
        <select class="form-select form-select-sm" id="tpl-${en.id}" style="width:auto;max-width:220px">${opt('', '選択してください', '')}${tpls.map(t => opt(t.id, t.name, '')).join('')}</select>
        <button type="button" class="btn btn-sm btn-outline-primary" data-act="tpl-apply" data-id="${en.id}">適用</button>
        <button type="button" class="btn btn-sm btn-outline-success ms-auto" data-act="tpl-save" data-id="${en.id}">今のフローを型として保存</button>
      </div>
    </section>
    <section class="card-x">
      <h2>🗓️ 予定 <span class="muted small">(終わったものは ✓ で済みに)</span></h2>
      ${evRows || '<p class="muted small">まだ予定はありません。下のボタンから追加してください。</p>'}
      <div class="quick-add">${KIND_ORDER.map(k => `<button type="button" class="btn btn-sm btn-outline-secondary" data-act="event-add" data-id="${en.id}" data-kind="${k}">＋ ${KINDS[k].icon} ${KINDS[k].label}</button>`).join('')}</div>
    </section>
  </div>
  <section class="card-x mt-3">
    <h2>🗒️ メモ</h2>
    <div class="field-grid">
      <div><label class="form-label" for="loc-${en.id}">場所・形式</label><input id="loc-${en.id}" type="text" class="form-control" value="${esc(en.location)}" placeholder="オンライン、東京本社 など" ${bind('entry', en.id, 'location')}></div>
      <div class="full"><label class="form-label" for="memo-${en.id}">メモ(説明会の印象・連絡事項など)</label><textarea id="memo-${en.id}" class="form-control" rows="4" data-autosize ${bind('entry', en.id, 'memo')}>${esc(en.memo)}</textarea></div>
    </div>
  </section>`;
}

function esPanel(c, en) {
  const cards = en.esQuestions.map((q, i) => {
    const len = (q.answer || '').length, lim = Number(q.limit) || 0;
    const open = S.openQ.has(q.id) || (!q.question && !q.answer);
    const ai = S.ai[q.id];
    return `<details class="q-card" data-qid="${q.id}" ${open ? 'open' : ''}>
      <summary><span class="badge text-bg-secondary">${esc(q.category || 'カテゴリなし')}</span><span class="q-sum" data-sum>${esc(q.question || `設問 ${i + 1}(未入力)`)}</span><span class="count ${lim && len > lim ? 'over' : ''}" data-count-sum>${len}${lim ? ' / ' + lim : ''}字</span></summary>
      <div class="q-body">
        <div class="field-grid">
          <div><label class="form-label">カテゴリ</label><select class="form-select" ${bind('q', en.id, 'category', q.id)} data-rerender>${opt('', 'カテゴリなし', q.category)}${ES_CATEGORIES.map(x => opt(x, x, q.category)).join('')}</select></div>
          <div><label class="form-label">文字数の上限(任意)</label><input type="number" min="0" class="form-control" value="${esc(q.limit)}" placeholder="例: 400" ${bind('q', en.id, 'limit', q.id)}></div>
          <div class="full"><label class="form-label">設問</label><textarea class="form-control" rows="2" data-autosize ${bind('q', en.id, 'question', q.id)}>${esc(q.question)}</textarea></div>
          <div class="full"><label class="form-label">💡 メモ・構成案</label><textarea class="form-control" rows="3" data-autosize ${bind('q', en.id, 'memo', q.id)}>${esc(q.memo)}</textarea></div>
          <div class="full">
            <div class="d-flex align-items-end gap-2 mb-1"><label class="form-label mb-0 flex-grow-1">✨ 清書(提出する文章)</label><span class="count ${lim && len > lim ? 'over' : ''}" data-count>${len}${lim ? ' / ' + lim : ''} 字</span></div>
            <textarea class="form-control" rows="6" data-autosize ${bind('q', en.id, 'answer', q.id)}>${esc(q.answer)}</textarea>
          </div>
        </div>
        <div class="q-tools mt-3">
          <button type="button" class="btn btn-sm btn-outline-primary" data-act="q-copy" data-id="${en.id}" data-sub="${q.id}">📑 清書をコピー</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-act="q-ref" data-id="${en.id}" data-sub="${q.id}">🔍 過去のESを参照</button>
          <button type="button" class="btn btn-sm btn-outline-info text-dark" data-act="q-ai" data-id="${en.id}" data-sub="${q.id}" ${ai === 'loading' ? 'disabled' : ''}>${ai === 'loading' ? '⏳ 添削中…' : '🤖 AIに添削してもらう'}</button>
          <span class="flex-grow-1"></span>
          <button type="button" class="btn btn-sm btn-outline-danger" data-act="q-del" data-id="${en.id}" data-sub="${q.id}">この設問を削除</button>
        </div>
        ${ai && ai !== 'loading' ? `<div class="ai-result ${ai.error ? 'err' : ''}" role="status">${ai.error ? '❌ ' + esc(ai.error) : ai.html}<div class="mt-2"><button type="button" class="btn btn-sm btn-outline-secondary" data-act="q-ai-close" data-sub="${q.id}">閉じる</button></div></div>` : ''}
      </div>
    </details>`;
  }).join('');
  return `<section class="card-x">
    <h2>📝 ES <span class="muted small">(${esc(trackById(en.trackId)?.name || '')} 用)</span><span class="spacer"></span><button type="button" class="btn btn-primary btn-sm" data-act="q-add" data-id="${en.id}">＋ 設問を追加</button></h2>
    ${cards || '<div class="empty">まだ設問がありません。「＋設問を追加」から始めましょう。<br>ほかの企業・区分で書いたESは「ES集」で見られます。</div>'}
  </section>`;
}

function interviewPanel(c, en) {
  const research = [['業界', c.industry], ['強み・特徴', c.strengths], ['ライバル', c.rivals], ['創業・創設者', c.founder], ['初任給', c.salary], ['休暇', c.vacation], ['賞与', c.bonus]];
  const esList = (list, showTrack) => list.length ? list.map(({ q, e }) => `<div class="lib-item">
      <div class="meta">${showTrack ? trackChip(trackById(e.trackId)) : ''}<span class="badge text-bg-secondary">${esc(q.category || 'カテゴリなし')}</span><span class="muted small">${(q.answer || '').length}字</span></div>
      <div class="q">Q. ${esc(q.question || '(設問なし)')}</div>
      <div class="ans-text">${esc(q.answer || '(清書なし)')}</div></div>`).join('') : '<p class="muted small">なし</p>';
  const mine = en.esQuestions.map(q => ({ q, e: en }));
  const others = entriesOf(c.id).filter(e => e.id !== en.id).flatMap(e => e.esQuestions.filter(q => q.answer).map(q => ({ q, e })));
  return `<div class="grid-2">
    <section class="card-x">
      <h2>🎯 この企業の志望の軸</h2>
      <p class="muted small mb-2">なぜこの企業か・自分の軸とどう合うか(企業ごとに共通。ほかの区分でも同じ内容が出ます)</p>
      <textarea class="form-control" rows="4" data-autosize ${bind('company', c.id, 'axis')}>${esc(c.axis)}</textarea>
      <h2 class="mt-4">💡 面接対策メモ・想定問答</h2>
      <textarea class="form-control" rows="8" data-autosize placeholder="深掘りされそうな質問と答え、話したいエピソードなど" ${bind('entry', en.id, 'interviewNote')}>${esc(en.interviewNote)}</textarea>
      <h2 class="mt-4">🙋 逆質問</h2>
      <textarea class="form-control" rows="4" data-autosize ${bind('entry', en.id, 'reverseQuestions')}>${esc(en.reverseQuestions)}</textarea>
    </section>
    <section class="card-x">
      <h2>🔍 見返す情報</h2>
      <div class="ref-box mb-3"><dl>${research.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v || '-')}</dd>`).join('')}</dl>
        <a class="small" href="#/company/${c.id}/research">企業研究を編集 →</a></div>
      <details open><summary class="fw-bold mb-2">📝 この選考で出したES(${mine.length})</summary>${esList(mine, false)}</details>
      <details class="mt-2"><summary class="fw-bold mb-2">📚 同じ企業のほかの区分のES(${others.length})</summary>${esList(others, true)}</details>
    </section>
  </div>`;
}

function researchPanel(c) {
  const f = (field, label, ph = '', rows = 0, full = false) => `<div class="${full ? 'full' : ''}"><label class="form-label" for="cr-${field}">${label}</label>${rows
    ? `<textarea id="cr-${field}" class="form-control" rows="${rows}" data-autosize placeholder="${esc(ph)}" ${bind('company', c.id, field)}>${esc(c[field])}</textarea>`
    : `<input id="cr-${field}" type="text" class="form-control" value="${esc(c[field])}" placeholder="${esc(ph)}" ${bind('company', c.id, field)} ${field === 'name' ? 'data-rerender' : ''}>`}</div>`;
  return `<section class="card-x">
    <h2>🏢 企業研究 <span class="muted small">(区分をまたいで共通の情報。入力するとすぐ保存されます)</span></h2>
    <div class="field-grid">
      ${f('name', '企業名')}${f('industry', '業界', 'IT・通信、メーカー など')}
      ${f('website', '採用ページ・企業サイトの URL', 'https://')}${f('founder', '創業年・創設者', '1947年 創設者: ○○')}
      ${f('strengths', '強み・特徴', '独自技術、シェア、社風など', 3, true)}
      ${f('rivals', '業界内のライバル', '競合他社との違い・立ち位置', 2, true)}
      ${f('axis', '志望の軸(なぜこの企業か)', '', 3, true)}
    </div>
    <h2 class="mt-4">💰 待遇・条件</h2>
    <div class="field-grid">${f('salary', '初任給', '学部卒25万円 / 院卒27万円')}${f('bonus', '賞与', '年2回 実績5か月分')}${f('vacation', '休暇', '土日祝、有給消化率80%', 0, true)}</div>
    <h2 class="mt-4">🗒️ 自由メモ</h2>
    <textarea class="form-control" rows="4" data-autosize ${bind('company', c.id, 'memo')}>${esc(c.memo)}</textarea>
  </section>`;
}

function accountPanel(c) {
  return `<section class="card-x" style="max-width:640px">
    <h2>🔑 マイページ</h2>
    <div class="stack">
      <div><label class="form-label" for="ac-url">マイページの URL</label>
        <div class="d-flex gap-2"><input id="ac-url" type="url" class="form-control" value="${esc(c.mypageUrl)}" placeholder="https://" ${bind('company', c.id, 'mypageUrl')}>
        ${c.mypageUrl ? `<a class="btn btn-outline-primary nowrap" href="${esc(safeUrl(c.mypageUrl))}" target="_blank" rel="noopener">開く ↗</a>` : ''}</div></div>
      <div><label class="form-label" for="ac-id">ログインID・会員番号</label>
        <div class="d-flex gap-2"><input id="ac-id" type="text" class="form-control" value="${esc(c.mypageId)}" autocomplete="off" ${bind('company', c.id, 'mypageId')}>
        <button type="button" class="btn btn-outline-secondary nowrap" data-act="copy-input" data-target="ac-id">コピー</button></div></div>
      <div><label class="form-label" for="ac-pass">パスワード</label>
        <div class="d-flex gap-2"><input id="ac-pass" type="password" class="form-control" value="${esc(c.mypagePass)}" autocomplete="off" ${bind('company', c.id, 'mypagePass')}>
        <button type="button" class="btn btn-outline-secondary nowrap" data-act="toggle-pass" data-target="ac-pass">表示</button>
        <button type="button" class="btn btn-outline-secondary nowrap" data-act="copy-input" data-target="ac-pass">コピー</button></div></div>
    </div>
    <p class="muted small mt-3 mb-0">⚠️ パスワードはクラウドに保存されます。ほかのサービスと同じパスワードは使わないでください。</p>
  </section>`;
}

/* ========================================================================
 * 予定(リスト・カレンダー・タイムライン)
 * ====================================================================== */
function viewSchedule() {
  const ents = visibleEntries();
  const kinds = new Set(S.ui.kinds);
  let items = collectEvents(ents).filter(x => kinds.has(x.ev.kind) && (S.ui.showDone || !x.ev.done));
  const mode = S.ui.schedMode;
  const head = `<div class="toolbar">
    <div class="seg" role="group" aria-label="表示方法">
      ${[['list', '📋 リスト'], ['calendar', '📅 カレンダー'], ['timeline', '📊 タイムライン']].map(([k, l]) => `<button type="button" aria-pressed="${mode === k}" data-act="sched-mode" data-id="${k}">${l}</button>`).join('')}
    </div>
    <div class="kind-filter" role="group" aria-label="表示する種類">${KIND_ORDER.map(k => `<button type="button" style="--k:${KINDS[k].color}" aria-pressed="${kinds.has(k)}" data-act="sched-kind" data-id="${k}">${KINDS[k].icon} ${KINDS[k].label}</button>`).join('')}</div>
    <label class="d-flex align-items-center gap-2 small fw-bold"><input type="checkbox" class="form-check-input" data-change="sched-done" ${S.ui.showDone ? 'checked' : ''}> 済みも表示</label>
    ${mode === 'list' ? `<label class="d-flex align-items-center gap-2 small fw-bold"><input type="checkbox" class="form-check-input" data-change="sched-past" ${S.ui.showPast ? 'checked' : ''}> 過去の予定も表示</label>` : ''}
  </div>`;

  if (mode === 'calendar') {
    return {
      title: '予定', html: head + '<div id="calendar"></div>',
      after: () => mountCalendar(items),
    };
  }
  if (mode === 'timeline') return { title: '予定', html: head + timelineHtml(ents, kinds) };

  if (!S.ui.showPast) { const t = today0(); items = items.filter(x => eventEndDay(x.ev) >= t && !isInactive(x.en)); }
  let html = '', lastKey = '';
  items.forEach(x => {
    const d = parseD(x.ev.start);
    const key = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    if (key !== lastKey) { if (lastKey) html += '</ul>'; html += `<h3 class="ev-group-head">${key}</h3><ul class="ev-list">`; lastKey = key; }
    html += eventRow(x);
  });
  if (lastKey) html += '</ul>';
  return { title: '予定', html: head + `<section class="card-x">${html || '<div class="empty">表示する予定はありません。</div>'}</section>` };
}

function mountCalendar(items) {
  const el = $('#calendar'); if (!el || !window.FullCalendar) { if (el) el.innerHTML = '<div class="empty">カレンダーを読み込めませんでした(通信状態を確認してください)。</div>'; return; }
  const small = window.innerWidth <= 900;
  S.calendar = new FullCalendar.Calendar(el, {
    initialView: small ? 'listMonth' : 'dayGridMonth',
    initialDate: S.ui.calDate || undefined,
    locale: 'ja', height: 'auto', dayMaxEvents: 4,
    buttonText: { today: '今日', month: '月', week: '週', list: 'リスト' },
    headerToolbar: { left: 'prev,next today', center: 'title', right: small ? 'listMonth,dayGridMonth' : 'dayGridMonth,timeGridWeek,listMonth' },
    datesSet: info => { S.ui.calDate = ymd(info.view.currentStart); saveUi(); },
    eventClick: info => { location.hash = info.event.extendedProps.href; },
    events: items.map(x => {
      const k = KINDS[x.ev.kind] || KINDS.other;
      const allDay = isAllDay(x.ev.start);
      let end;
      if (x.ev.end && allDay) { const e = dayOf(x.ev.end); e.setDate(e.getDate() + 1); end = ymd(e); }
      return {
        title: `${k.icon}${x.ev.title && x.ev.title !== k.label ? x.ev.title : k.label} ${x.c.name}`,
        start: x.ev.start, end, allDay,
        backgroundColor: k.color, borderColor: k.color,
        classNames: x.ev.done || isInactive(x.en) ? ['is-done'] : [],
        extendedProps: { href: `#/company/${x.c.id}/${x.en.id}` },
      };
    }),
  });
  S.calendar.render();
}

function timelineHtml(ents, kinds) {
  const weeks = 26, colW = 90;
  const start = today0(); start.setDate(start.getDate() - start.getDay() - 7);
  const total = weeks * 7 * MS_DAY;
  const end = new Date(start.getTime() + total);
  const rowsData = ents.map(en => ({ en, c: companyById(en.companyId), st: entryStatus(en) }))
    .sort((a, b) => STATUS_ORDER.indexOf(a.st.key) - STATUS_ORDER.indexOf(b.st.key) || a.c.name.localeCompare(b.c.name, 'ja'));
  let head = `<tr><th class="who">企業・区分</th>`;
  for (let i = 0; i < weeks; i++) { const d = new Date(start.getTime() + i * 7 * MS_DAY); head += `<th>${d.getMonth() + 1}/${d.getDate()}〜</th>`; }
  head += '</tr>';
  const todayPct = (today0() - start) / total * 100;
  const body = rowsData.map(({ en, c, st }) => {
    const lanes = []; let bars = '';
    (en.events || []).filter(ev => kinds.has(ev.kind) && (S.ui.showDone || !ev.done)).forEach(ev => {
      const s = dayOf(ev.start); if (!s) return;
      const e = eventEndDay(ev);
      if (e < start || s > end) return;
      let lane = 0; while (lanes.some(l => l.lane === lane && !(e < l.s || s > l.e))) lane++;
      lanes.push({ lane, s, e });
      const left = Math.max(0, (s - start) / total * 100);
      const width = Math.max(0.6, (Math.min(e.getTime() + MS_DAY, end.getTime()) - Math.max(s.getTime(), start.getTime())) / total * 100);
      const k = KINDS[ev.kind] || KINDS.other;
      bars += `<a class="bar ${ev.done ? 'done' : ''}" href="#/company/${c.id}/${en.id}" style="left:${left}%;width:${width}%;top:${8 + lane * 28}px;background:${k.color}" title="${esc(`${ev.title || k.label} ${dateRangeText(ev)}`)}">${esc(ev.title || k.label)}</a>`;
    });
    const h = Math.max(42, 16 + (Math.max(0, ...lanes.map(l => l.lane)) + 1) * 28);
    return `<tr><td class="who"><a href="#/company/${c.id}/${en.id}">${esc(c.name)}</a>${trackChip(trackById(en.trackId))} <span class="status ${STATUS_META[st.key].cls}">${esc(STATUS_META[st.key].label)}</span></td>
      <td colspan="${weeks}" class="grid" style="height:${h}px"><span class="today-line" style="left:${todayPct}%" aria-hidden="true"></span>${bars}</td></tr>`;
  }).join('');
  if (!rowsData.length) return '<div class="empty">表示する選考はありません。</div>';
  return `<div class="tl-wrap"><table class="tl" style="min-width:${190 + weeks * colW}px"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    <p class="muted small mt-2">赤い線が今日。先週から半年分を表示しています。</p>`;
}

/* ========================================================================
 * ES集(すべての企業・区分の ES を横断して見る)
 * ====================================================================== */
function viewEsLibrary() {
  const cat = S.ui.esCat || '', q = (S.ui.esSearch || '').trim().toLowerCase();
  const items = [];
  visibleEntries().forEach(en => {
    const c = companyById(en.companyId);
    en.esQuestions.forEach(qq => {
      if (!qq.answer && !qq.question) return;
      if (cat && (qq.category || '') !== (cat === '_none' ? '' : cat)) return;
      if (q && !`${c.name} ${qq.question} ${qq.answer}`.toLowerCase().includes(q)) return;
      items.push({ c, en, q: qq });
    });
  });
  items.sort((a, b) => ES_CATEGORIES.indexOf(a.q.category) - ES_CATEGORIES.indexOf(b.q.category) || a.c.name.localeCompare(b.c.name, 'ja'));
  return {
    title: 'ES集',
    html: `<div class="toolbar">
        <select class="form-select" style="width:auto" data-change="es-cat" aria-label="カテゴリ">${opt('', 'すべてのカテゴリ', cat)}${ES_CATEGORIES.map(x => opt(x, x, cat)).join('')}${opt('_none', 'カテゴリなし', cat)}</select>
        <input type="search" class="form-control grow" placeholder="企業名・設問・本文で検索" aria-label="ESを検索" value="${esc(S.ui.esSearch || '')}" data-ui="esSearch">
      </div>
      <p class="muted small">${esc(filterName())}の ES: ${items.length}件(区分を「夏インターン(終了)」に切り替えると夏の ES も見られます)</p>
      ${items.map(({ c, en, q: qq }) => `<article class="lib-item">
        <div class="meta"><a class="fw-bold" href="#/company/${c.id}/${en.id}/es">${esc(c.name)}</a>${trackChip(trackById(en.trackId))}<span class="badge text-bg-secondary">${esc(qq.category || 'カテゴリなし')}</span><span class="muted small">${(qq.answer || '').length}字</span>
          <span class="flex-grow-1"></span><button type="button" class="btn btn-sm btn-outline-primary" data-act="copy-text" data-text="${esc(qq.answer || '')}">📑 コピー</button></div>
        <div class="q">Q. ${esc(qq.question || '(設問なし)')}</div>
        <div class="ans-text">${esc(qq.answer || '(清書なし)')}</div>
      </article>`).join('') || '<div class="empty">該当する ES はありません。</div>'}`,
  };
}

/* ========================================================================
 * 設定
 * ====================================================================== */
function viewSettings() {
  const st = S.db.settings;
  const trackRows = tracks().map((t, i) => {
    const n = S.db.entries.filter(e => e.trackId === t.id).length;
    return `<div class="set-row">
      <input type="color" class="color-in" value="${esc(t.color)}" aria-label="${esc(t.name)} の色" ${bind('track', t.id, 'color')} data-rerender>
      <input type="text" class="form-control" style="flex:1;min-width:140px" value="${esc(t.name)}" aria-label="区分の名前" ${bind('track', t.id, 'name')} data-rerender>
      <span class="muted small nowrap">${n}件</span>
      <button type="button" class="btn btn-sm ${t.archived ? 'btn-outline-success' : 'btn-outline-secondary'}" data-act="track-archive" data-id="${t.id}">${t.archived ? '進行中に戻す' : '終了にする'}</button>
      <button type="button" class="btn btn-sm btn-icon btn-outline-secondary" data-act="track-move" data-dir="-1" data-id="${t.id}" aria-label="${esc(t.name)} を上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="btn btn-sm btn-icon btn-outline-secondary" data-act="track-move" data-dir="1" data-id="${t.id}" aria-label="${esc(t.name)} を下へ" ${i === tracks().length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="btn btn-sm btn-icon btn-outline-danger border-0" data-act="track-del" data-id="${t.id}" aria-label="${esc(t.name)} を削除">✕</button>
    </div>`;
  }).join('');
  const tplRows = st.flowTemplates.map(t => `<div class="set-row"><strong>${esc(t.name)}</strong><span class="muted small" style="flex:1">${t.steps.filter(s => !pid(s)).map(s => esc(s.name)).join(' → ')}</span>
    <button type="button" class="btn btn-sm btn-outline-danger" data-act="tpl-del" data-id="${t.id}">削除</button></div>`).join('') || '<p class="muted small">まだありません。企業の「進捗・予定」で「今のフローを型として保存」すると追加されます。</p>';
  let autoSync = false; try { autoSync = localStorage.getItem('autoCalSync') === 'true'; } catch { /* なし */ }
  return {
    title: '設定',
    html: `<div class="stack" style="max-width:860px">
      <section class="card-x"><h2>👤 アカウント</h2>
        <div class="d-flex align-items-center gap-3 flex-wrap"><span class="fw-bold">${esc(S.user?.email || '')}</span><button type="button" class="btn btn-outline-danger btn-sm" data-act="logout">ログアウト</button></div></section>

      <section class="card-x"><h2>🗂️ 選考区分</h2>
        <p class="muted small">「終了にする」と、上の切り替えでは右端の点線のボタンにまとまり、ホームや予定に出なくなります(データは残ります)。</p>
        ${trackRows}
        <form class="d-flex gap-2 mt-2" data-form="track-add"><input type="text" name="trackname" class="form-control" placeholder="新しい区分(例: 2028卒 冬インターン)" aria-label="新しい区分の名前"><button class="btn btn-outline-primary nowrap" type="submit">＋ 追加</button></form>
      </section>

      <section class="card-x"><h2>📁 フロー型</h2>${tplRows}</section>

      <section class="card-x"><h2>💾 データの控え</h2>
        <div class="d-flex flex-wrap gap-2">
          <button type="button" class="btn btn-outline-secondary" data-act="backup-dl">📥 全データを書き出す(JSON)</button>
          <label class="btn btn-outline-secondary mb-0">📤 控えから戻す<input type="file" accept=".json,.txt" hidden data-change="backup-restore"></label>
        </div>
        <p class="muted small mt-2 mb-0">旧版の「バックアップ(TXT)」も読み込めます(読み込むと今のデータは置き換わります)。</p>
        <details class="mt-3"><summary class="small fw-bold">旧版のデータから作り直す</summary>
          <p class="small mt-2">旧版(syuukatu-v2.html)で入力した内容を取り込み直します。<strong>この版で入力した内容は消えます</strong>(先に書き出しておくと安全です)。</p>
          <button type="button" class="btn btn-sm btn-outline-danger" data-act="remigrate">旧版のデータから作り直す</button></details>
      </section>

      <section class="card-x"><h2>📅 カレンダー</h2>
        <button type="button" class="btn btn-outline-secondary" data-act="ics-dl">🗓️ 予定をカレンダー用ファイル(ICS)で書き出す</button>
        <p class="muted small mt-1">いま上で選んでいる区分(${esc(filterName())})の予定を書き出します。Google カレンダーの「設定 → インポート」で読み込めます。</p>
        <details class="mt-2"><summary class="small fw-bold">Google カレンダーへの自動登録(上級者向け)</summary>
          <div class="form-check form-switch mt-2"><input class="form-check-input" type="checkbox" id="autoCalSync" data-change="auto-sync" ${autoSync ? 'checked' : ''}><label class="form-check-label fw-bold" for="autoCalSync">予定の日時を入れたら Google カレンダーにも登録する(この端末のみ)</label></div>
          <div class="field-grid mt-2">
            <div><label class="form-label" for="g-key">Google API キー</label><input id="g-key" class="form-control" value="${esc(st.googleApiKey)}" ${bind('settings', '', 'googleApiKey')}></div>
            <div><label class="form-label" for="g-cid">OAuth クライアント ID</label><input id="g-cid" class="form-control" value="${esc(st.googleClientId)}" ${bind('settings', '', 'googleClientId')}></div>
          </div></details>
      </section>

      <section class="card-x"><h2>🤖 AI 添削(Gemini)</h2>
        <label class="form-label" for="gm-key">Gemini API キー</label>
        <input id="gm-key" class="form-control" value="${esc(st.geminiApiKey)}" autocomplete="off" ${bind('settings', '', 'geminiApiKey')}>
        <details class="mt-2"><summary class="small fw-bold">キーの取り方(無料)</summary>
          <ol class="small mt-2 mb-0"><li><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio</a> を開き、Google アカウントでログイン</li><li>「Get API key」→「Create API key」</li><li>表示された文字列をコピーして上の欄に貼り付け(自動で保存されます)</li></ol></details>
      </section>

      <section class="card-x"><h2>ℹ️ 旧版について</h2>
        <p class="small mb-0">旧版は <a href="syuukatu-v2.html">syuukatu-v2.html</a> に残しています。この新しい版とはデータを別々に保存しているので、旧版で入力した内容はこちらには反映されません(反映したいときは上の「旧版のデータから作り直す」)。
        ${S.db.migratedFromV2At ? `旧版からの取り込み: ${esc(new Date(S.db.migratedFromV2At).toLocaleString())}` : ''}</p>
      </section>
    </div>`,
  };
}

/* ========================================================================
 * ダイアログ・トースト
 * ====================================================================== */
function openDialog(html, { wide = false } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dlg' + (wide ? ' wide' : '');
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
  const f = dlg.querySelector('[autofocus]'); if (f) f.focus();
  return dlg;
}
const dlgHead = title => `<div class="dlg-head"><h2>${title}</h2><button type="button" class="btn btn-icon btn-outline-secondary border-0" data-act="dlg-close" aria-label="閉じる">✕</button></div>`;

function toast(msg, undo, ms) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast-x';
  el.innerHTML = `<span class="msg">${esc(msg)}</span>${undo ? '<button type="button">元に戻す</button>' : ''}`;
  root.appendChild(el);
  const remove = () => el.remove();
  if (undo) el.querySelector('button').addEventListener('click', () => { undo(); remove(); });
  setTimeout(remove, ms || (undo ? 7000 : 3500));
}
// 削除などの前に全体を控えておき、「元に戻す」で戻せるようにする
function withUndo(msg, mutate) {
  const snap = JSON.stringify(S.db);
  mutate();
  scheduleSave(); render();
  toast(msg, () => { S.db = JSON.parse(snap); scheduleSave(); render(); });
}

function openAddCompany() {
  const def = S.ui.track !== 'active' ? S.ui.track : (tracks().find(t => !t.archived) || tracks()[0])?.id;
  const tpls = S.db.settings.flowTemplates;
  openDialog(`<form method="dialog" data-form="company-add">
    ${dlgHead('企業を追加')}
    <div class="dlg-body stack">
      <div><label class="form-label" for="nc-name">企業名(必須)</label><input id="nc-name" name="cname" class="form-control" required autofocus autocomplete="off"></div>
      <div id="nc-dup" class="small" style="color:var(--warn);font-weight:700" hidden></div>
      <div><label class="form-label" for="nc-track">選考区分</label><select id="nc-track" name="track" class="form-select">${tracks().map(t => opt(t.id, t.name + (t.archived ? '(終了)' : ''), def)).join('')}</select></div>
      <div><label class="form-label" for="nc-ind">業界(任意)</label><input id="nc-ind" name="industry" class="form-control"></div>
      <div><label class="form-label" for="nc-tpl">選考フローの型(任意)</label><select id="nc-tpl" name="tpl" class="form-select">${opt('', '使わない', '')}${tpls.map(t => opt(t.id, t.name, '')).join('')}</select></div>
    </div>
    <div class="dlg-foot"><button type="button" class="btn btn-outline-secondary" data-act="dlg-close">キャンセル</button><button type="submit" class="btn btn-primary">追加して開く</button></div>
  </form>`);
}

function openAddEntry(cid) {
  const c = companyById(cid);
  const used = new Set(entriesOf(cid).map(e => e.trackId));
  const first = tracks().find(t => !used.has(t.id) && !t.archived) || tracks()[0];
  const tpls = S.db.settings.flowTemplates;
  openDialog(`<form method="dialog" data-form="entry-add" data-id="${cid}">
    ${dlgHead(`${esc(c.name)} に選考を追加`)}
    <div class="dlg-body stack">
      <p class="small muted mb-0">例: 夏インターンに参加した企業の「早期選考」を追加。企業研究とログイン情報は引き継がれ、ES・予定・選考フローは区分ごとに分かれます。</p>
      <div><label class="form-label" for="ne-track">選考区分</label><select id="ne-track" name="track" class="form-select">${tracks().map(t => opt(t.id, t.name + (t.archived ? '(終了)' : '') + (used.has(t.id) ? '(登録済み)' : ''), first?.id)).join('')}</select></div>
      <div><label class="form-label" for="ne-tpl">選考フローの型(任意)</label><select id="ne-tpl" name="tpl" class="form-select">${opt('', '使わない', '')}${tpls.map(t => opt(t.id, t.name, '')).join('')}</select></div>
    </div>
    <div class="dlg-foot"><button type="button" class="btn btn-outline-secondary" data-act="dlg-close">キャンセル</button><button type="submit" class="btn btn-primary">追加</button></div>
  </form>`);
}

function openLoginInfo(cid) {
  const c = companyById(cid); if (!c) return;
  openDialog(`${dlgHead('🔑 ' + esc(c.name))}
    <div class="dlg-body stack">
      <div><div class="form-label">ログインID</div><div class="d-flex gap-2"><input id="li-id" class="form-control" value="${esc(c.mypageId)}" readonly><button type="button" class="btn btn-outline-secondary nowrap" data-act="copy-input" data-target="li-id">コピー</button></div></div>
      <div><div class="form-label">パスワード</div><div class="d-flex gap-2"><input id="li-pass" type="password" class="form-control" value="${esc(c.mypagePass)}" readonly><button type="button" class="btn btn-outline-secondary nowrap" data-act="toggle-pass" data-target="li-pass">表示</button><button type="button" class="btn btn-outline-secondary nowrap" data-act="copy-input" data-target="li-pass">コピー</button></div></div>
      ${c.mypageUrl ? `<a class="btn btn-primary" href="${esc(safeUrl(c.mypageUrl))}" target="_blank" rel="noopener">マイページを開く ↗</a>` : '<p class="muted small mb-0">マイページの URL が未登録です。</p>'}
    </div>
    <div class="dlg-foot"><a class="btn btn-outline-secondary" href="#/company/${c.id}/account" data-act="dlg-close-nav">編集する</a></div>`);
}

function openEsReference(eid, qid) {
  const en = entryById(eid), q = en?.esQuestions.find(x => x.id === qid); if (!q) return;
  const items = [];
  S.db.entries.forEach(e => e.esQuestions.forEach(x => { if (x.id !== qid && x.answer && (!q.category || x.category === q.category)) items.push({ e, x }); }));
  openDialog(`${dlgHead('🔍 過去のES' + (q.category ? `(${esc(q.category)})` : ''))}
    <div class="dlg-body">
      ${q.category ? '' : '<p class="small muted">設問のカテゴリを選ぶと、同じカテゴリだけに絞り込めます。</p>'}
      ${items.map(({ e, x }) => `<div class="lib-item"><div class="meta"><strong>${esc(companyById(e.companyId)?.name || '')}</strong>${trackChip(trackById(e.trackId))}<span class="badge text-bg-secondary">${esc(x.category || 'カテゴリなし')}</span><span class="muted small">${x.answer.length}字</span></div>
        <div class="q">Q. ${esc(x.question || '(設問なし)')}</div><div class="ans-text">${esc(x.answer)}</div>
        <div class="d-flex gap-2 mt-2"><button type="button" class="btn btn-sm btn-outline-primary" data-act="copy-text" data-text="${esc(x.answer)}">📑 コピー</button>
        <button type="button" class="btn btn-sm btn-outline-success" data-act="q-use" data-id="${eid}" data-sub="${qid}" data-text="${esc(x.answer)}">この文章を清書欄に入れる</button></div></div>`).join('') || '<div class="empty">見つかりませんでした。</div>'}
    </div>`, { wide: true });
}

/* ========================================================================
 * 操作(ボタン・フォーム)
 * ====================================================================== */
function flowOf(eid) { const en = entryById(eid); if (!en) return null; en.flow = en.flow || []; return en; }
function cloneSteps(steps) {
  const map = {};
  steps.forEach(s => { map[s.id] = newId('step'); });
  return steps.map(s => ({ id: map[s.id], name: s.name, status: 'not_started', parentId: pid(s) ? (map[pid(s)] || null) : null }));
}
function applyTemplate(en, tplId) {
  const tpl = S.db.settings.flowTemplates.find(t => t.id === tplId); if (!tpl) return false;
  en.flow = cloneSteps(tpl.steps);
  const first = en.flow.find(s => !pid(s)); if (first) first.status = 'current';
  return true;
}
function newEntry(cid, trackId, tplId) {
  const en = { id: newId('e'), companyId: cid, trackId, flow: [], events: [], esQuestions: [], interviewNote: '', reverseQuestions: '', memo: '', location: '', closed: '', createdAt: new Date().toISOString() };
  if (tplId) applyTemplate(en, tplId);
  S.db.entries.push(en);
  return en;
}
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  if (btn) { const o = btn.textContent; btn.textContent = '✓ コピーしました'; setTimeout(() => { btn.textContent = o; }, 1500); } else toast('コピーしました');
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const ACTIONS = {
  'register': async () => {
    $('#login-error').textContent = '';
    try { await createUserWithEmailAndPassword(auth, $('#login-email').value.trim(), $('#login-pass').value); }
    catch (e) { $('#login-error').textContent = '登録できませんでした(' + (e.code || e.message) + ')'; }
  },
  'logout': async () => { await saveNow(); signOut(auth); },
  'set-track': el => { S.ui.track = el.dataset.id; saveUi(); render(); },
  'add-company': () => openAddCompany(),
  'login-info': el => openLoginInfo(el.dataset.id),
  'dlg-close': el => el.closest('dialog')?.close(),
  'dlg-close-nav': (el, e) => { e.preventDefault(); el.closest('dialog')?.close(); location.hash = el.getAttribute('href'); },
  'todo-del': el => { const list = S.db.todos[el.dataset.id]; const i = Number(el.dataset.sub); const t = list[i]; withUndo(`「${t.text}」を削除しました`, () => list.splice(i, 1)); },
  'company-del': el => {
    const c = companyById(el.dataset.id); if (!c) return;
    if (!confirm(`「${c.name}」を削除しますか?\nすべての区分の選考・ES・予定も消えます(直後なら「元に戻す」で戻せます)。`)) return;
    withUndo(`「${c.name}」を削除しました`, () => { S.db.companies = S.db.companies.filter(x => x.id !== c.id); S.db.entries = S.db.entries.filter(e => e.companyId !== c.id); location.hash = '#/companies'; });
  },
  'entry-add': el => openAddEntry(el.dataset.id),
  'entry-del': el => {
    const en = entryById(el.dataset.id); if (!en) return;
    const name = trackById(en.trackId)?.name || '';
    if (!confirm(`この企業の「${name}」の選考(フロー・予定・ES・面接メモ)を削除しますか?`)) return;
    withUndo(`「${name}」の選考を削除しました`, () => { S.db.entries = S.db.entries.filter(e => e.id !== en.id); location.hash = `#/company/${en.companyId}`; });
  },
  'flow-branch': el => { const en = flowOf(el.dataset.id); en.flow.push({ id: newId('step'), name: '別ルート', status: 'not_started', parentId: el.dataset.sub }); scheduleSave(); render(); },
  'flow-del': el => {
    const en = flowOf(el.dataset.id); const ids = new Set([el.dataset.sub]);
    let grew = true; while (grew) { grew = false; en.flow.forEach(s => { if (pid(s) && ids.has(pid(s)) && !ids.has(s.id)) { ids.add(s.id); grew = true; } }); }
    const name = en.flow.find(s => s.id === el.dataset.sub)?.name || '';
    withUndo(`ステップ「${name}」を削除しました`, () => { en.flow = en.flow.filter(s => !ids.has(s.id)); });
  },
  'flow-move': el => {
    const en = flowOf(el.dataset.id); const s = en.flow.find(x => x.id === el.dataset.sub); if (!s) return;
    const sibs = en.flow.filter(x => pid(x) === pid(s)); const i = sibs.indexOf(s); const other = sibs[i + Number(el.dataset.dir)]; if (!other) return;
    const a = en.flow.indexOf(s), b = en.flow.indexOf(other); en.flow[a] = other; en.flow[b] = s;
    scheduleSave(); render();
  },
  'tpl-apply': el => {
    const en = flowOf(el.dataset.id); const sel = $(`#tpl-${en.id}`);
    if (!sel.value) { toast('適用する型を選んでください'); return; }
    if (en.flow.length && !confirm('今のフローは型の内容で置き換わります。よろしいですか?')) return;
    applyTemplate(en, sel.value); scheduleSave(); render(); toast('フロー型を適用しました');
  },
  'tpl-save': el => {
    const en = flowOf(el.dataset.id); if (!en.flow.length) { toast('フローが空です'); return; }
    const name = (prompt('型の名前を入力してください(例: 一般的なインターン選考)') || '').trim(); if (!name) return;
    const exists = S.db.settings.flowTemplates.find(t => t.name === name);
    const steps = en.flow.map(s => ({ id: s.id, name: s.name, status: 'not_started', parentId: pid(s) }));
    if (exists) { if (!confirm(`「${name}」はすでにあります。上書きしますか?`)) return; exists.steps = steps; }
    else S.db.settings.flowTemplates.push({ id: newId('tpl'), name, steps });
    scheduleSave(); render(); toast(`型「${name}」を保存しました`);
  },
  'tpl-del': el => { const t = S.db.settings.flowTemplates.find(x => x.id === el.dataset.id); withUndo(`型「${t?.name}」を削除しました`, () => { S.db.settings.flowTemplates = S.db.settings.flowTemplates.filter(x => x.id !== el.dataset.id); }); },
  'event-add': el => {
    const en = entryById(el.dataset.id); const k = el.dataset.kind;
    en.events.push({ id: newId('ev'), kind: k, title: KINDS[k].label, start: '', end: '', done: false, note: '' });
    scheduleSave(); render();
    const rows = document.querySelectorAll('.evt-edit'); const last = rows[rows.length - 1];
    const inp = last?.querySelector('.dates input'); if (inp) inp.focus();
  },
  'event-del': el => { const en = entryById(el.dataset.id); const ev = en.events.find(x => x.id === el.dataset.sub); withUndo(`予定「${ev?.title || ''}」を削除しました`, () => { en.events = en.events.filter(x => x.id !== el.dataset.sub); }); },
  'q-add': el => { const en = entryById(el.dataset.id); const q = { id: newId('q'), category: '', question: '', memo: '', answer: '', limit: '' }; en.esQuestions.push(q); S.openQ.add(q.id); scheduleSave(); render(); },
  'q-del': el => { const en = entryById(el.dataset.id); withUndo('設問を削除しました', () => { en.esQuestions = en.esQuestions.filter(x => x.id !== el.dataset.sub); }); },
  'q-copy': el => { const q = entryById(el.dataset.id)?.esQuestions.find(x => x.id === el.dataset.sub); if (!q?.answer) { toast('清書が空です'); return; } copyText(q.answer, el); },
  'q-ref': el => openEsReference(el.dataset.id, el.dataset.sub),
  'q-use': el => {
    const q = entryById(el.dataset.id)?.esQuestions.find(x => x.id === el.dataset.sub); if (!q) return;
    if (q.answer && !confirm('今の清書は置き換わります。よろしいですか?')) return;
    const prev = q.answer; q.answer = el.dataset.text; el.closest('dialog')?.close(); S.openQ.add(q.id); scheduleSave(); render();
    toast('清書欄に入れました', () => { q.answer = prev; scheduleSave(); render(); });
  },
  'q-ai': el => reviewWithGemini(el.dataset.id, el.dataset.sub),
  'q-ai-close': el => { delete S.ai[el.dataset.sub]; render(); },
  'copy-input': el => { const inp = document.getElementById(el.dataset.target); if (inp?.value) copyText(inp.value, el); else toast('空です'); },
  'copy-text': el => copyText(el.dataset.text || '', el),
  'toggle-pass': el => { const inp = document.getElementById(el.dataset.target); if (!inp) return; const show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; el.textContent = show ? '隠す' : '表示'; },
  'sched-mode': el => { S.ui.schedMode = el.dataset.id; saveUi(); render(); },
  'sched-kind': el => { const k = el.dataset.id; const s = new Set(S.ui.kinds); s.has(k) ? s.delete(k) : s.add(k); S.ui.kinds = KIND_ORDER.filter(x => s.has(x)); saveUi(); render(); },
  'track-archive': el => { const t = trackById(el.dataset.id); t.archived = !t.archived; if (S.ui.track === t.id && t.archived) S.ui.track = 'active'; scheduleSave(); render(); },
  'track-move': el => { const i = tracks().findIndex(t => t.id === el.dataset.id); const j = i + Number(el.dataset.dir); if (j < 0 || j >= tracks().length) return; const a = tracks(); [a[i], a[j]] = [a[j], a[i]]; scheduleSave(); render(); },
  'track-del': el => {
    const t = trackById(el.dataset.id); const n = S.db.entries.filter(e => e.trackId === t.id).length;
    if (n) { alert(`「${t.name}」には ${n} 件の選考があるので削除できません。\n使わない場合は「終了にする」を押してください。`); return; }
    if (tracks().length <= 1) return;
    withUndo(`区分「${t.name}」を削除しました`, () => { S.db.tracks = tracks().filter(x => x.id !== t.id); });
  },
  'backup-dl': () => download(`就活管理_控え_${ymd(new Date())}.json`, JSON.stringify(S.db, null, 2), 'application/json'),
  'ics-dl': () => downloadIcs(),
  'remigrate': async () => {
    if (!confirm('旧版のデータから作り直します。この版で入力・変更した内容は消えます。よろしいですか?')) return;
    const snap = await get(ref(rtdb, `users/${S.user.uid}`)); const val = snap.val() || {};
    if (!val.data) { alert('旧版のデータが見つかりませんでした。'); return; }
    const before = JSON.stringify(S.db);
    S.db = migrateFromV2(val, S.db.settings); scheduleSave(); render();
    toast(`旧版のデータ(${S.db.companies.length}社)から作り直しました`, () => { S.db = JSON.parse(before); scheduleSave(); render(); });
  },
};

const CHANGES = {
  'event-done': el => {
    const en = entryById(el.dataset.id); const ev = en?.events.find(x => x.id === el.dataset.sub); if (!ev) return;
    ev.done = el.checked; scheduleSave(); render();
    if (ev.done) toast(`「${ev.title || KINDS[ev.kind].label}」を済みにしました`, () => { ev.done = false; scheduleSave(); render(); });
  },
  'todo-toggle': el => { const t = S.db.todos[el.dataset.id][Number(el.dataset.sub)]; if (t) { t.done = el.checked; scheduleSave(); render(); } },
  'sort': el => { S.ui.sort = el.value; saveUi(); render(); },
  'es-cat': el => { S.ui.esCat = el.value; saveUi(); render(); },
  'entry-move': el => { const en = entryById(el.dataset.id); en.trackId = el.value; scheduleSave(); render(); toast(`区分を「${trackById(el.value)?.name}」に変更しました`); },
  'entry-closed': el => { entryById(el.dataset.id).closed = el.value; scheduleSave(); render(); },
  'flow-status': el => { const en = flowOf(el.dataset.id); const s = en.flow.find(x => x.id === el.dataset.sub); if (s) { s.status = el.value; scheduleSave(); render(); } },
  'event-kind': el => {
    const en = entryById(el.dataset.id); const ev = en.events.find(x => x.id === el.dataset.sub); if (!ev) return;
    const oldLabel = KINDS[ev.kind]?.label; ev.kind = el.value;
    if (!ev.title || ev.title === oldLabel) ev.title = KINDS[ev.kind].label;
    if (ev.kind === 'intern') { ev.start = String(ev.start || '').slice(0, 10); ev.end = String(ev.end || '').slice(0, 10); }
    else { ev.end = ''; if (ev.start && String(ev.start).length <= 10) ev.start += 'T10:00'; }
    scheduleSave(); render();
  },
  'sched-done': el => { S.ui.showDone = el.checked; saveUi(); render(); },
  'sched-past': el => { S.ui.showPast = el.checked; saveUi(); render(); },
  'auto-sync': el => { try { localStorage.setItem('autoCalSync', el.checked); } catch { /* なし */ } if (el.checked) loadGoogleScripts(); },
  'backup-restore': el => {
    const file = el.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result);
        let db;
        if (json && json.version >= 3 && json.companies) db = normalizeDb(json);
        else if (json && (json.data || Array.isArray(json))) db = migrateFromV2(Array.isArray(json) ? { data: json } : json, S.db.settings);
        else { alert('このファイルは読み込めません。'); return; }
        if (!confirm(`${db.companies.length}社のデータを読み込みます。今のデータは置き換わります。よろしいですか?`)) return;
        const before = JSON.stringify(S.db);
        S.db = db; scheduleSave(); render();
        toast('控えから戻しました', () => { S.db = JSON.parse(before); scheduleSave(); render(); });
      } catch (e) { alert('読み込みに失敗しました: ' + e.message); }
      el.value = '';
    };
    reader.readAsText(file);
  },
};

const FORMS = {
  'todo-add': (form) => { const text = fv(form, 'text'); if (!text) return; S.db.todos[form.dataset.id].push({ text, done: false }); scheduleSave(); render(); $(`[data-form="todo-add"][data-id="${form.dataset.id}"] input`)?.focus(); },
  'flow-add': (form) => {
    const name = fv(form, 'stepname'); if (!name) return;
    const en = flowOf(form.dataset.id);
    en.flow.push({ id: newId('step'), name, status: en.flow.length ? 'not_started' : 'current', parentId: null });
    scheduleSave(); render(); $(`[data-form="flow-add"] input`)?.focus();
  },
  'track-add': (form) => { const name = fv(form, 'trackname'); if (!name) return; S.db.tracks.push({ id: newId('t'), name, color: TRACK_COLORS[S.db.tracks.length % TRACK_COLORS.length], archived: false }); scheduleSave(); render(); },
  'company-add': (form) => {
    const name = fv(form, 'cname'); if (!name) { form.elements.namedItem('cname').focus(); return false; }
    const dup = S.db.companies.find(c => c.name.replace(/\s/g, '') === name.replace(/\s/g, ''));
    if (dup && !form.dataset.dupOk) {
      const box = form.querySelector('#nc-dup');
      box.hidden = false;
      box.innerHTML = `「${esc(dup.name)}」はすでに登録されています。同じ企業なら、<a href="#/company/${dup.id}" data-act="dlg-close-nav">その企業を開いて「＋選考を追加」</a>すると情報を引き継げます。別の企業として追加する場合は、もう一度「追加して開く」を押してください。`;
      form.dataset.dupOk = '1';
      return false;
    }
    const c = { id: newId('c'), name, industry: fv(form, 'industry'), founder: '', rivals: '', strengths: '', salary: '', vacation: '', bonus: '', axis: '', website: '', memo: '', mypageUrl: '', mypageId: '', mypagePass: '', createdAt: new Date().toISOString() };
    S.db.companies.push(c);
    const en = newEntry(c.id, fv(form, 'track'), fv(form, 'tpl'));
    scheduleSave();
    location.hash = `#/company/${c.id}/${en.id}`;
    render();
  },
  'entry-add': (form) => { const en = newEntry(form.dataset.id, fv(form, 'track'), fv(form, 'tpl')); scheduleSave(); location.hash = `#/company/${form.dataset.id}/${en.id}`; render(); },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = ACTIONS[el.dataset.act]; if (!fn) return;
  if (el.tagName === 'BUTTON') e.preventDefault();
  fn(el, e);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.change && CHANGES[el.dataset.change]) { CHANGES[el.dataset.change](el); return; }
  if (el.dataset.field) onFieldChange(el);
});
document.addEventListener('submit', e => {
  const form = e.target;
  if (form.id === 'login-form') { e.preventDefault(); doLogin(); return; }
  const fn = FORMS[form.dataset.form]; if (!fn) return;
  e.preventDefault();
  const r = fn(form);
  if (r !== false) form.closest('dialog')?.close();
});
document.addEventListener('toggle', e => {
  const d = e.target; if (!d.classList || !d.classList.contains('q-card')) return;
  if (d.open) { S.openQ.add(d.dataset.qid); d.querySelectorAll('textarea[data-autosize]').forEach(autosize); } else S.openQ.delete(d.dataset.qid);
}, true);

// 入力欄 → データへ(入力のたびに保存。画面全体は描き直さないので入力中の文字は消えない)
function bindTarget(el) {
  const { scope, id, sub } = el.dataset;
  if (scope === 'company') return companyById(id);
  if (scope === 'entry') return entryById(id);
  if (scope === 'q') return entryById(id)?.esQuestions.find(q => q.id === sub);
  if (scope === 'event') return entryById(id)?.events.find(x => x.id === sub);
  if (scope === 'step') return entryById(id)?.flow.find(x => x.id === sub);
  if (scope === 'track') return trackById(id);
  if (scope === 'settings') return S.db.settings;
  return null;
}
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.ui) { S.ui[el.dataset.ui] = el.value; saveUi(); rerenderKeepingFocus(el); return; }
  if (!el.dataset.field) return;
  const obj = bindTarget(el); if (!obj) return;
  obj[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
  scheduleSave();
  if (el.tagName === 'TEXTAREA' && el.hasAttribute('data-autosize')) autosize(el);
  if (el.dataset.scope === 'q') {
    const card = el.closest('.q-card');
    if (card && (el.dataset.field === 'answer' || el.dataset.field === 'limit')) {
      const len = (obj.answer || '').length, lim = Number(obj.limit) || 0;
      card.querySelectorAll('[data-count],[data-count-sum]').forEach(x => { x.textContent = `${len}${lim ? ' / ' + lim : ''}${x.hasAttribute('data-count') ? ' ' : ''}字`; x.classList.toggle('over', !!lim && len > lim); });
    }
    if (card && el.dataset.field === 'question') card.querySelector('[data-sum]').textContent = obj.question || '(未入力)';
  }
});
function onFieldChange(el) {
  const obj = bindTarget(el); if (!obj) return;
  if (el.dataset.scope === 'event' && el.dataset.field === 'start') maybeSyncEvent(el.dataset.id, obj);
  if (el.dataset.scope === 'event' && el.dataset.field === 'done') render();
  if (el.dataset.scope === 'settings' && (el.dataset.field === 'googleApiKey' || el.dataset.field === 'googleClientId')) initGoogle();
  if (el.hasAttribute('data-rerender')) render();
}
function rerenderKeepingFocus(el) {
  const sel = el.dataset.ui ? `[data-ui="${el.dataset.ui}"]` : null;
  const pos = el.selectionStart;
  render();
  if (sel) { const n = $(sel); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch { /* なし */ } } }
}
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight + 2, 60) + 'px'; }

/* ========================================================================
 * AI 添削(Gemini)
 * ====================================================================== */
async function reviewWithGemini(eid, qid) {
  const q = entryById(eid)?.esQuestions.find(x => x.id === qid); if (!q) return;
  const key = S.db.settings.geminiApiKey;
  if (!key) { alert('設定の「AI 添削(Gemini)」に API キーを登録してください(無料で取得できます)。'); location.hash = '#/settings'; return; }
  if (!q.question.trim() || !q.answer.trim()) { toast('設問と清書の両方を入力してください'); return; }
  S.ai[qid] = 'loading'; S.openQ.add(qid); render();
  const prompt = `あなたはプロの就活キャリアアドバイザーです。以下のエントリーシート(ES)の設問と回答を読み、面接官に響く内容になるよう添削・アドバイスしてください。

【設問】
${q.question}
${q.limit ? `\n【文字数の上限】${q.limit}字\n` : ''}
【現在の回答】(${q.answer.length}字)
${q.answer}

【出力形式】
1. **👍 良い点**
2. **💡 改善点・深掘りすべき点**(具体的にどう直すか)
3. **✨ 修正案(例文)**(文字数は元の回答${q.limit ? 'と上限' : ''}を目安に)`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `通信エラー(${res.status})`);
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    if (!text) throw new Error('AI から回答がありませんでした');
    S.ai[qid] = { html: esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>') };
  } catch (e) {
    S.ai[qid] = { error: e.message };
  }
  render();
}

/* ========================================================================
 * カレンダー(ICS 書き出し・Google カレンダー自動登録)
 * ====================================================================== */
function downloadIcs() {
  const items = collectEvents(visibleEntries());
  if (!items.length) { toast('書き出す予定がありません'); return; }
  const icsEsc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const utc = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  const dOnly = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Syuukatu App v3//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  items.forEach(({ ev, en, c }) => {
    const k = KINDS[ev.kind] || KINDS.other;
    const s = parseD(ev.start);
    lines.push('BEGIN:VEVENT', `UID:${ev.id}@syuukatu.app`, `DTSTAMP:${utc(new Date())}`);
    if (isAllDay(ev.start)) {
      const e = dayOf(ev.end || ev.start); e.setDate(e.getDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${dOnly(s)}`, `DTEND;VALUE=DATE:${dOnly(e)}`);
    } else {
      lines.push(`DTSTART:${utc(s)}`, `DTEND:${utc(new Date(s.getTime() + (ev.kind === 'es' ? 30 : 60) * 60000))}`);
    }
    lines.push(`SUMMARY:${icsEsc(`[${ev.title || k.label}] ${c.name}(${trackById(en.trackId)?.name || ''})`)}`);
    if (en.location) lines.push(`LOCATION:${icsEsc(en.location)}`);
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  download(`就活予定_${ymd(new Date())}.ics`, lines.join('\r\n'), 'text/calendar;charset=utf-8');
}

let gapiReady = false, gisReady = false, tokenClient = null, googleRequested = false;
function loadGoogleScripts() {
  if (googleRequested) return; googleRequested = true;
  const s1 = document.createElement('script'); s1.src = 'https://apis.google.com/js/api.js'; s1.async = true;
  s1.onload = () => window.gapi.load('client', () => { gapiReady = true; initGoogle(); });
  const s2 = document.createElement('script'); s2.src = 'https://accounts.google.com/gsi/client'; s2.async = true;
  s2.onload = () => { gisReady = true; initGoogle(); };
  document.head.append(s1, s2);
}
async function initGoogle() {
  const st = S.db?.settings;
  if (!gapiReady || !gisReady || !st?.googleApiKey || !st?.googleClientId) return;
  try {
    await window.gapi.client.init({ apiKey: st.googleApiKey, discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'] });
    tokenClient = window.google.accounts.oauth2.initTokenClient({ client_id: st.googleClientId, scope: 'https://www.googleapis.com/auth/calendar.events', callback: '' });
  } catch (e) { console.error(e); }
}
function autoSyncOn() { try { return localStorage.getItem('autoCalSync') === 'true'; } catch { return false; } }
function maybeSyncEvent(eid, ev) {
  if (!autoSyncOn() || !ev.start || ev.syncedStart === ev.start) return;
  const en = entryById(eid), c = companyById(en.companyId);
  if (!tokenClient) { toast('Google カレンダー連携の準備ができていません(設定のキーを確認してください)'); return; }
  const k = KINDS[ev.kind] || KINDS.other;
  tokenClient.callback = async resp => {
    if (resp.error !== undefined) { toast('Google の認証に失敗しました'); return; }
    let start, end;
    if (isAllDay(ev.start)) { const e = dayOf(ev.end || ev.start); e.setDate(e.getDate() + 1); start = { date: String(ev.start).slice(0, 10) }; end = { date: ymd(e) }; }
    else { const s = parseD(ev.start); start = { dateTime: s.toISOString() }; end = { dateTime: new Date(s.getTime() + 3600000).toISOString() }; }
    try {
      await window.gapi.client.calendar.events.insert({ calendarId: 'primary', resource: { summary: `[${ev.title || k.label}] ${c.name}`, start, end, location: en.location || '' } });
      ev.syncedStart = ev.start; scheduleSave(); toast('Google カレンダーに登録しました');
    } catch (e) { toast('Google カレンダーに登録できませんでした'); }
  };
  tokenClient.requestAccessToken({ prompt: window.gapi.client.getToken() === null ? 'consent' : '' });
}

/* ========================================================================
 * ログイン・起動
 * ====================================================================== */
async function doLogin() {
  $('#login-error').textContent = '';
  try { await signInWithEmailAndPassword(auth, $('#login-email').value.trim(), $('#login-pass').value); }
  catch (e) { $('#login-error').textContent = 'ログインできませんでした。メールアドレスとパスワードを確認してください。'; }
}

onAuthStateChanged(auth, async user => {
  S.user = user;
  if (!user) {
    S.db = null;
    $('#app').hidden = true; $('#login').hidden = false;
    return;
  }
  $('#login').hidden = true; $('#app').hidden = false;
  $('#side-email').textContent = user.email || '';
  $('#view').innerHTML = '<div class="loading">データを読み込み中…</div>';
  try {
    const note = await loadUserData(user);
    setSaveState('saved');
    render();
    if (note) toast(note, null, 9000);
    if (autoSyncOn()) loadGoogleScripts();
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="empty">データを読み込めませんでした。<br>${esc(e.message)}<br><button type="button" class="btn btn-primary mt-3" onclick="location.reload()">再読み込み</button></div>`;
  }
});

// テスト用(画面からは使わない)
window.__shukatsu = { S, migrateFromV2, normalizeDb, entryStatus, render };
