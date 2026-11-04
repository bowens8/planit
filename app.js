import { firebaseConfig } from './firebase-config.js';

/* ============================================================
   helpers
   ============================================================ */
const $ = (s, el = document) => el.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const diffDays = (a, b) => { const A = parse(a), B = parse(b); return Math.round((Date.UTC(B.getFullYear(), B.getMonth(), B.getDate()) - Date.UTC(A.getFullYear(), A.getMonth(), A.getDate())) / 864e5); };
const dim = d => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
const weekStart = s => addDays(s, -parse(s).getDay());
const todayStr = () => ymd(new Date());
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const fmtT = m => { const h = Math.floor(m / 60) % 24, mi = m % 60, ap = h < 12 ? 'AM' : 'PM', h12 = h % 12 || 12; return mi ? `${h12}:${pad(mi)} ${ap}` : `${h12} ${ap}`; };
const fmtRange = (s, e) => { const a = fmtT(s), b = fmtT(e); const apA = a.slice(-2), apB = b.slice(-2); return apA === apB ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = o => JSON.parse(JSON.stringify(o));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW1 = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const H = 56; // px per hour (keep in sync with --hour)
const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const TYPE_LABEL = { event: 'Event', study: 'Study', habit: 'Habit', test: 'Test', block: 'Block', assignment: 'Assignment', vacation: 'Away' };
const TYPE_COLOR = { event: '#3b82f6', study: '#8b5cf6', habit: '#2fb67c', test: '#ef4444', block: '#94a3b8', assignment: '#f59e0b' };
const PALETTE = ['#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b', '#2fb67c', '#14b8a6', '#94a3b8'];
const G_EVENT_COLORS = { 1: '#a4bdfc', 2: '#7ae7bf', 3: '#dbadff', 4: '#ff887c', 5: '#fbd75b', 6: '#ffb878', 7: '#46d6db', 8: '#e1e1e1', 9: '#5484ed', 10: '#51b749', 11: '#dc2127' };
const classById = id => (S.settings.classes || []).find(c => c.id === id);
const classColor = id => classById(id)?.color || '';
const colorOf = it => it.color || classColor(it.classId) || TYPE_COLOR[it.type] || TYPE_COLOR.event;
const cpill = it => { const c = classById(it.classId); return c ? `<span class="cpill" style="--c:${c.color}">${esc(c.name)}</span> ` : ''; };
const gColor = e => S.settings.calColors?.[e.cal] || e.gcolor || '#f59e0b';

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ============================================================
   state
   ============================================================ */
const S = {
  mode: 'local',           // 'local' | 'cloud'
  booting: false,
  user: null,
  items: [],
  logs: {},                // { 'YYYY-MM-DD': { done:{id:true}, skipped:{id:true}, mins:{id:n} } }
  settings: { dayStart: 6, dayEnd: 23, calendars: ['primary'], calColors: {}, classes: [], vacations: [] },
  view: 'day',
  date: todayStr(),
  gcal: {},                // { 'YYYY-MM-DD': [events] }
  gcalLoaded: {},          // range key -> timestamp
  gcalStatus: 'off',       // off | ok | expired | error
  calList: [],
  sheet: null,
  sw: { id: null, running: false, t0: 0, acc: 0 },
  scrollToNow: true,
  planClass: '',
  calView: 'day',
  vmenuOpen: false,
};

/* ============================================================
   recurrence / streak logic
   ============================================================ */
function occursOn(it, d) {
  if (it.active === false) return false;
  const r = it.rec || { type: 'none' };
  if (r.type === 'none') return it.date === d;
  if (d < it.date) return false;
  const dt = parse(d), st = parse(it.date);
  switch (r.type) {
    case 'weekdays': return (r.days || []).includes(dt.getDay());
    case 'interval': {
      const n = Math.max(1, +r.every || 1);
      if (r.unit === 'day') return diffDays(it.date, d) % n === 0;
      if (r.unit === 'week') return diffDays(it.date, d) % (7 * n) === 0;
      const m = (dt.getFullYear() - st.getFullYear()) * 12 + dt.getMonth() - st.getMonth();
      return m % n === 0 && dt.getDate() === Math.min(st.getDate(), dim(dt));
    }
    case 'monthly': return dt.getDate() === Math.min(+r.dom || st.getDate(), dim(dt));
    case 'perweek': return true;
  }
  return false;
}
const logOf = d => S.logs[d] || { done: {}, skipped: {}, mins: {} };
const isDone = (id, d) => !!logOf(d).done?.[id];
const isSkipped = (id, d) => !!logOf(d).skipped?.[id];
function weekDoneCount(it, anyDay) {
  const ws = weekStart(anyDay); let n = 0;
  for (let i = 0; i < 7; i++) if (isDone(it.id, addDays(ws, i))) n++;
  return n;
}
function streakOf(it, today) {
  const r = it.rec || { type: 'none' };
  if (r.type === 'none') return { n: 0, unit: 'd' };
  if (r.type === 'perweek') {
    let n = 0, ws = weekStart(today);
    for (let i = 0; i < 80; i++) {
      if (addDays(ws, 6) < it.date) break;
      if (weekDoneCount(it, ws) >= (+r.times || 1)) n++; else if (i > 0) break;
      ws = addDays(ws, -7);
    }
    return { n, unit: 'w' };
  }
  let n = 0, d = today;
  for (let i = 0; i < 800 && d >= it.date; i++, d = addDays(d, -1)) {
    if (!occursOn(it, d)) continue;
    if (isSkipped(it.id, d) || isPaused(it, d)) continue;
    if (isDone(it.id, d)) n++; else if (d !== today) break;
  }
  return { n, unit: 'd' };
}
const checkable = it => it.type === 'habit' || it.type === 'study' || it.type === 'assignment';
const itemsOn = d => S.items.filter(it => occursOn(it, d));
const shown = d => itemsOn(d).filter(i => i.type !== 'block');
function vacationFor(ds) {
  const hit = (S.settings.vacations || []).filter(v => v.start <= ds && ds <= v.end);
  if (!hit.length) return null;
  const absent = { study: false, habits: false };
  hit.forEach(v => { if (v.absent?.study) absent.study = true; if (v.absent?.habits) absent.habits = true; });
  return { names: hit.map(v => v.name || 'Away'), absent };
}
const isPaused = (it, d) => { if (it.type !== 'study' && it.type !== 'habit') return false; const v = vacationFor(d); return !!v && (it.type === 'study' ? v.absent.study : v.absent.habits); };
const off = (it, d) => isSkipped(it.id, d) || isPaused(it, d);
const doneFor = (it, d) => (it.type === 'assignment' ? !!it.done : isDone(it.id, d));
function awayBanner(d) {
  const v = vacationFor(d); if (!v) return '';
  const p = [v.absent.study && 'Study', v.absent.habits && 'Habits'].filter(Boolean).join(' & ');
  return `<div class="banner away"><span>✈ ${esc(v.names.join(', '))} · ${p} paused</span></div>`;
}
const awayLine = (d, ln) => { const v = vacationFor(d); return v ? ln('#94a3b8', 'Away', v.names.join(', ')) : ''; };
// A "goal" is a habit, or a study block tied to a test.
const isGoal = it => it.type === 'habit' || (it.type === 'study' && !!it.testId);
function goalStatus(d) {
  const expired = i => { if (i.type !== 'study' || !i.testId) return false; const t = S.items.find(x => x.id === i.testId); return !t || t.date < d; };  // study goals end with their test
  const g = itemsOn(d).filter(i => isGoal(i) && !expired(i) && i.rec?.type !== 'perweek' && !isSkipped(i.id, d) && !isPaused(i, d));
  return { total: g.length, done: g.filter(i => isDone(i.id, d)).length };
}
const goalLabel = it => (it.type === 'study' && !/study/i.test(it.title) ? `${it.title} study` : it.title);
function goalList(d) {
  const expired = i => { if (i.type !== 'study' || !i.testId) return false; const t = S.items.find(x => x.id === i.testId); return !t || t.date < d; };
  return itemsOn(d).filter(i => isGoal(i) && !expired(i) && (i.rec?.type !== 'perweek' || isDone(i.id, d)))
    .map(i => ({ it: i, done: isDone(i.id, d), off: isSkipped(i.id, d) || isPaused(i, d) }));
}
function dayStreaks() {
  const t = todayStr(); let start = S.items.reduce((m, i) => (i.date < m ? i.date : m), t);
  const floor = addDays(t, -800); if (start < floor) start = floor;
  let run = 0, best = 0;
  for (let d = start; d <= t; d = addDays(d, 1)) {
    const g = goalStatus(d);
    if (!g.total) continue;                      // no goals that day: neutral
    if (g.done === g.total) { run++; best = Math.max(best, run); } else if (d !== t) run = 0;
  }
  return { cur: run, best };
}

function recSummary(it) {
  const r = it.rec || { type: 'none' };
  switch (r.type) {
    case 'weekdays': return (r.days || []).length === 7 ? 'Every day' : (r.days || []).map(i => DOW[i].slice(0, 3)).join(' ');
    case 'interval': return `Every ${r.every > 1 ? r.every + ' ' : ''}${r.unit}${r.every > 1 ? 's' : ''}`;
    case 'monthly': return `Monthly, day ${r.dom}`;
    case 'perweek': return `${r.times}× a week`;
  }
  return '';
}

/* ============================================================
   persistence: Local (preview) and Cloud (Firebase)
   ============================================================ */
const Local = {
  load() {
    try {
      const d = JSON.parse(localStorage.getItem('planit') || '{}');
      S.items = d.items || []; S.logs = d.logs || {};
      Object.assign(S.settings, d.settings || {});
    } catch { /* ignore */ }
  },
  persist() { localStorage.setItem('planit', JSON.stringify({ items: S.items, logs: S.logs, settings: S.settings })); },
};

const Cloud = {
  unsubs: [],
  async init() {
    S.booting = true; render();
    const B = 'https://www.gstatic.com/firebasejs/10.14.1/';
    const [app, auth, fs] = await Promise.all([import(B + 'firebase-app.js'), import(B + 'firebase-auth.js'), import(B + 'firebase-firestore.js')]);
    this.A = auth; this.F = fs;
    const fapp = app.initializeApp(firebaseConfig);
    this.auth = auth.getAuth(fapp);
    this.db = fs.initializeFirestore(fapp, { localCache: fs.persistentLocalCache() });
    try { const r = await auth.getRedirectResult(this.auth); if (r) this.captureToken(r); } catch (e) { console.warn(e); }
    auth.onAuthStateChanged(this.auth, u => {
      S.booting = false; S.user = u;
      if (u) this.sync(); else { this.stop(); render(); }
    });
  },
  provider() { const p = new this.A.GoogleAuthProvider(); p.addScope(CAL_SCOPE); return p; },
  captureToken(r) {
    const c = this.A.GoogleAuthProvider.credentialFromResult(r);
    if (c?.accessToken) {
      localStorage.setItem('planit.gtok', JSON.stringify({ t: c.accessToken, exp: Date.now() + 3300e3 }));
      S.gcalStatus = 'ok'; S.gcalLoaded = {};
    }
  },
  async signIn() {
    try {
      const r = await this.A.signInWithPopup(this.auth, this.provider());
      this.captureToken(r);
      if (S.user) ensureGcal(true);
    } catch (e) {
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')
        return this.A.signInWithRedirect(this.auth, this.provider());
      if (!['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(e.code)) toast(e.message || 'Sign-in failed');
    }
  },
  async signOut() { localStorage.removeItem('planit.gtok'); S.gcal = {}; S.gcalLoaded = {}; await this.A.signOut(this.auth); },
  stop() { this.unsubs.forEach(u => u()); this.unsubs = []; },
  sync() {
    this.stop();
    const { F: fs, db } = this, uid_ = S.user.uid;
    this.unsubs.push(fs.onSnapshot(fs.collection(db, 'users', uid_, 'items'), snap => { S.items = snap.docs.map(d => d.data()); render(); }));
    this.unsubs.push(fs.onSnapshot(fs.collection(db, 'users', uid_, 'logs'), snap => { S.logs = {}; snap.docs.forEach(d => { S.logs[d.id] = d.data(); }); render(); }));
    this.unsubs.push(fs.onSnapshot(fs.doc(db, 'users', uid_, 'meta', 'settings'), snap => { if (snap.exists()) { Object.assign(S.settings, snap.data()); } render(); }));
    ensureGcal();
  },
  saveItem(it) { const { F: fs, db } = this; fs.setDoc(fs.doc(db, 'users', S.user.uid, 'items', it.id), clean(it)).catch(e => toast(e.message)); },
  delItem(id) { const { F: fs, db } = this; fs.deleteDoc(fs.doc(db, 'users', S.user.uid, 'items', id)).catch(e => toast(e.message)); },
  saveLog(d, lg) { const { F: fs, db } = this; fs.setDoc(fs.doc(db, 'users', S.user.uid, 'logs', d), clean(lg)).catch(e => toast(e.message)); },
  saveSettings() { const { F: fs, db } = this; fs.setDoc(fs.doc(db, 'users', S.user.uid, 'meta', 'settings'), clean(S.settings)).catch(e => toast(e.message)); },
};

const DB = {
  saveItem(it) {
    const i = S.items.findIndex(x => x.id === it.id);
    if (i < 0) S.items.push(it); else S.items[i] = it;
    S.mode === 'cloud' ? Cloud.saveItem(it) : Local.persist();
  },
  delItem(id) {
    S.items = S.items.filter(x => x.id !== id);
    S.mode === 'cloud' ? Cloud.delItem(id) : Local.persist();
  },
  saveLog(d, lg) {
    S.logs[d] = lg;
    S.mode === 'cloud' ? Cloud.saveLog(d, lg) : Local.persist();
  },
  saveSettings() { S.mode === 'cloud' ? Cloud.saveSettings() : Local.persist(); },
};

function toggleDone(id, d) {
  const lg = clean(logOf(d)); lg.done ||= {}; lg.skipped ||= {}; lg.mins ||= {};
  if (lg.done[id]) delete lg.done[id]; else { lg.done[id] = true; delete lg.skipped[id]; }
  DB.saveLog(d, lg);
}
function toggleSkip(id, d) {
  const lg = clean(logOf(d)); lg.done ||= {}; lg.skipped ||= {}; lg.mins ||= {};
  if (lg.skipped[id]) delete lg.skipped[id]; else { lg.skipped[id] = true; delete lg.done[id]; }
  DB.saveLog(d, lg);
}

/* ============================================================
   Google Calendar (read-only)
   ============================================================ */
function gToken() {
  try { const o = JSON.parse(localStorage.getItem('planit.gtok') || 'null'); if (o && o.exp > Date.now()) return o.t; } catch { /* ignore */ }
  return null;
}
function visibleRange() {
  if (S.view === 'month') {
    const first = S.date.slice(0, 8) + '01';
    const from = weekStart(first); return [from, addDays(from, 42)];
  }
  const from = weekStart(S.date); return [from, addDays(from, 7)];
}
async function gfetch(url, tok) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) { const e = new Error('gcal ' + r.status); e.status = r.status; throw e; }
  return r.json();
}
function addGEvent(ev, cal, base) {
  if (ev.status === 'cancelled') return;
  if (ev.attendees?.some(a => a.self && a.responseStatus === 'declined')) return;
  const title = ev.summary || '(No title)';
  const push = (d, o) => { (S.gcal[d] ||= []).push({ title, link: ev.htmlLink, loc: ev.location || '', cal, gcolor: G_EVENT_COLORS[ev.colorId] || base, ...o }); };
  if (ev.start?.date) {
    for (let d = ev.start.date, i = 0; d < ev.end.date && i < 60; d = addDays(d, 1), i++) push(d, { id: ev.id + d, allDay: true });
  } else if (ev.start?.dateTime) {
    const s = new Date(ev.start.dateTime), e = new Date(ev.end.dateTime), d = ymd(s);
    const sm = s.getHours() * 60 + s.getMinutes();
    let em = ymd(e) === d ? e.getHours() * 60 + e.getMinutes() : 1440;
    if (em <= sm) em = sm + 30;
    push(d, { id: ev.id + d, allDay: false, s: sm, e: em });
  }
}
async function ensureGcal(force) {
  if (S.mode !== 'cloud' || !S.user) return;
  const tok = gToken();
  if (!tok) { S.gcalStatus = 'expired'; render(); return; }
  const [from, to] = visibleRange(), key = from + '|' + to;
  if (!force && S.gcalLoaded[key] && Date.now() - S.gcalLoaded[key] < 3e5) return;
  S.gcalLoaded[key] = Date.now();
  try {
    const cals = S.settings.calendars?.length ? S.settings.calendars : ['primary'];
    const qs = `timeMin=${encodeURIComponent(parse(from).toISOString())}&timeMax=${encodeURIComponent(parse(to).toISOString())}&singleEvents=true&orderBy=startTime&maxResults=250`;
    if (!S.calList.length) { try { S.calList = (await gfetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', tok)).items || []; } catch { /* colors fall back */ } }
    const calBg = c => (S.calList.find(x => (c === 'primary' ? x.primary : x.id === c)) || {}).backgroundColor || '';
    const results = await Promise.all(cals.map(c => gfetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c)}/events?${qs}`, tok).then(j => (j.items || []).map(ev => ({ ev, cal: c, base: calBg(c) })))));
    for (let d = from; d < to; d = addDays(d, 1)) S.gcal[d] = [];
    results.flat().forEach(r => addGEvent(r.ev, r.cal, r.base));
    S.gcalStatus = 'ok';
  } catch (e) {
    delete S.gcalLoaded[key];
    if (e.status === 401 || e.status === 403) { localStorage.removeItem('planit.gtok'); S.gcalStatus = 'expired'; }
    else S.gcalStatus = 'error';
  }
  render();
}
async function loadCalList() {
  const tok = gToken(); if (!tok) return;
  try { const j = await gfetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', tok); S.calList = j.items || []; renderSheet(); } catch { /* ignore */ }
}

/* ============================================================
   rendering: shell
   ============================================================ */
function render() {
  const app = $('#app');
  if (S.booting) { app.innerHTML = '<div class="login"><img src="icon.svg" alt=""></div>'; return; }
  if (S.mode === 'cloud' && !S.user) {
    app.innerHTML = `<div class="login"><img src="icon.svg" alt=""><h1>PlanIt</h1>
      <p>Your day, your habits, and your Google Calendar in one calm place.</p>
      <button class="btn primary" data-act="signin">Continue with Google</button>
      <p style="font-size:13px">PlanIt asks for read-only access to your calendar. It never changes it.</p></div>`;
    return;
  }
  const prev = $('#main'); const keep = prev ? prev.scrollTop : 0;
  const body = S.view === 'day' ? dayHTML() : S.view === 'week' ? weekHTML() : S.view === 'progress' ? progressHTML() : S.view === 'plan' ? planHTML() : monthHTML();
  app.innerHTML = headerHTML() + `<main id="main">${body}</main><button class="fab" data-act="add" aria-label="Add">+</button>`;
  const main = $('#main');
  if (S.view === 'day' && S.scrollToNow) {
    S.scrollToNow = false;
    const tl = $('.tl', main);
    if (tl) {
      const rs = +tl.dataset.rs;
      if (S.date === todayStr()) { const n = new Date(); main.scrollTop = Math.max(0, ((n.getHours() * 60 + n.getMinutes()) / 60 - rs - 1.2) * H); }
      else { const first = tl.querySelector('.blk'); main.scrollTop = first ? Math.max(0, first.offsetTop - 60) : Math.max(0, (8 - rs) * H); }
    }
  } else main.scrollTop = keep;
}

function headerHTML() {
  const t = todayStr(), d = parse(S.date);
  let h1, sub;
  if (S.view === 'day') { h1 = S.date === t ? 'Today' : DOW[d.getDay()]; sub = `${S.date === t ? DOW[d.getDay()] + ', ' : ''}${MONTHS[d.getMonth()]} ${d.getDate()}`; }
  else if (S.view === 'week') {
    const a = parse(weekStart(S.date)), b = parse(addDays(weekStart(S.date), 6));
    h1 = weekStart(S.date) === weekStart(t) ? 'This week' : 'Week';
    sub = a.getMonth() === b.getMonth() ? `${MONTHS[a.getMonth()]} ${a.getDate()} – ${b.getDate()}` : `${MONTHS[a.getMonth()].slice(0, 3)} ${a.getDate()} – ${MONTHS[b.getMonth()].slice(0, 3)} ${b.getDate()}`;
  } else if (S.view === 'progress') { h1 = 'Progress'; sub = 'Tests and study'; }
  else if (S.view === 'plan') { h1 = 'Plan'; sub = 'Assignments, time away, classes'; }
  else { h1 = MONTHS[d.getMonth()]; sub = String(d.getFullYear()); }
  const prog = S.view === 'progress' || S.view === 'plan';
  const isCal = ['day', 'week', 'month'].includes(S.view), calLabel = isCal ? S.view : S.calView;
  const atToday = prog || (S.view === 'day' ? S.date === t : S.view === 'week' ? weekStart(S.date) === weekStart(t) : S.date.slice(0, 7) === t.slice(0, 7));
  const initial = esc((S.user?.displayName || S.user?.email || 'B').trim()[0]?.toUpperCase() || 'B');
  return `<header class="top">
    <div><h1>${h1}</h1><p>${sub}</p></div>
    <div class="top-actions">
      ${atToday ? '' : '<button class="pill" data-act="today">Today</button>'}
      ${prog ? '' : '<button class="ico" data-act="nav" data-n="-1" aria-label="Previous">‹</button><button class="ico" data-act="nav" data-n="1" aria-label="Next">›</button>'}
      <button class="avatar" data-act="settings" aria-label="Settings">${initial}</button>
    </div></header>
    <div class="seg">
      <div class="vmenu"><button class="${isCal ? 'on' : ''}" data-act="vmenu" aria-haspopup="true" aria-expanded="${S.vmenuOpen}">${calLabel[0].toUpperCase() + calLabel.slice(1)} <span class="chev">▾</span></button>
        ${S.vmenuOpen ? `<div class="vpop" role="menu">${['day', 'week', 'month'].map(v => `<button class="${calLabel === v && isCal ? 'cur' : ''}" data-act="view" data-v="${v}" role="menuitem">${v[0].toUpperCase() + v.slice(1)}<i>${calLabel === v && isCal ? '✓' : ''}</i></button>`).join('')}</div>` : ''}</div>
      ${['plan', 'progress'].map(v => `<button class="${S.view === v ? 'on' : ''}" data-act="view" data-v="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}
    </div>`;
}

/* ============================================================
   rendering: day view
   ============================================================ */
function stripHTML() {
  const ws = weekStart(S.date), t = todayStr();
  return '<div class="strip">' + Array.from({ length: 7 }, (_, i) => {
    const d = addDays(ws, i);
    const has = shown(d).length || (S.gcal[d] || []).length;
    return `<button class="${d === S.date ? 'sel' : ''} ${d === t ? 'tdy' : ''} ${has ? 'has' : ''}" data-act="goto" data-d="${d}">
      <small>${DOW1[i]}</small><b>${parse(d).getDate()}</b><span class="dot"></span></button>`;
  }).join('') + '</div>';
}

function bannerHTML() {
  if (S.mode !== 'cloud') return '';
  if (S.gcalStatus === 'expired') return '<div class="banner"><span>Google Calendar needs a quick reconnect.</span><button data-act="reconnect">Reconnect</button></div>';
  if (S.gcalStatus === 'error') return '<div class="banner"><span>Couldn’t load Google Calendar.</span><button data-act="retry">Retry</button></div>';
  return '';
}

function habitBadge(it, d) {
  const r = it.rec || { type: 'none' };
  if (r.type === 'perweek') return `<span class="badge">${Math.min(weekDoneCount(it, d), r.times)}/${r.times} wk</span>`;
  const s = streakOf(it, todayStr());
  return s.n >= 2 ? `<span class="badge fire">🔥 ${s.n}${s.unit}</span>` : '';
}

function cd(d) { const n = diffDays(todayStr(), d); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 1 ? `in ${n}d` : `${-n}d ago`; }
const shortDate = d => { const x = parse(d); return `${MONTHS[x.getMonth()].slice(0, 3)} ${x.getDate()}`; };
function extraOf(it) {
  const a = [];
  if (it.type === 'study' && it.testId) { const t = S.items.find(x => x.id === it.testId); if (t) a.push(`${t.title} ${cd(t.date)}`); }
  if (it.type === 'test' && it.score != null && it.score !== '') a.push(`${it.score}/${it.max || 100}`);
  if (it.type === 'assignment') { const c = classById(it.classId); if (c) a.push(c.name); if (it.start) a.push('due ' + fmtT(toMin(it.start))); }
  if (it.note) a.push(it.note);
  return a.join(' · ');
}

function assignBadge(it) {
  if (it.done) return '';
  const n = diffDays(todayStr(), it.date);
  if (n < 0) return `<span class="badge late">${-n}d late</span>`;
  if (n === 0) return `<span class="badge">Due ${it.start ? fmtT(toMin(it.start)) : 'today'}</span>`;
  return `<span class="badge">${n === 1 ? 'tomorrow' : 'in ' + n + 'd'}</span>`;
}
function anytimeRow(it, d) {
  const sk = off(it, d), done = doneFor(it, d), r = it.rec || {};
  const met = r.type === 'perweek' && !done && weekDoneCount(it, d) >= r.times;
  const c = colorOf(it);
  const sub = extraOf(it) || (r.type && r.type !== 'none' ? recSummary(it) : '');
  const late = it.type === 'assignment' && !it.done && it.date < todayStr();
  const badge = it.type === 'assignment' ? assignBadge(it) : checkable(it) ? habitBadge(it, d) : it.type === 'test' ? `<span class="badge">${cd(it.date)}</span>` : '';
  return `<div class="row ${sk ? 'skipped' : ''} ${met ? 'met' : ''}" data-act="open" data-id="${it.id}">
    ${checkable(it) ? `<button class="chk ${done ? 'on' : ''}" style="--c:${late ? 'var(--danger)' : c}" data-act="toggle" data-id="${it.id}" aria-label="Toggle done"></button>` : `<span class="chk" style="--c:${c};border-style:dashed"></span>`}
    <div class="t"><b>${esc(it.title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>${badge}</div>`;
}

function dayHTML() {
  const d = S.date, items = shown(d), gc = S.gcal[d] || [];
  const overdue = d === todayStr() ? S.items.filter(i => i.type === 'assignment' && !i.done && i.date < d) : [];
  const anytime = [...overdue, ...items.filter(i => i.type === 'assignment' || i.anytime || !i.start)];
  const allDay = gc.filter(e => e.allDay);
  const blocks = [
    ...items.filter(i => i.type !== 'assignment' && !(i.anytime || !i.start)).map(i => {
      const s = toMin(i.start); const e = i.end ? toMin(i.end) : s + (i.type === 'habit' ? 30 : 60);
      return { k: 'app', id: i.id, type: i.type, title: i.title, s, e: Math.max(e, s + 15), it: i };
    }),
    ...gc.filter(e => !e.allDay).map(e => ({ k: 'g', id: e.id, type: 'g', title: e.title, s: e.s, e: e.e, color: gColor(e) })),
  ];
  // dimmed background blocks (sleep etc.), incl. the morning half of overnight ones
  const bg = [];
  S.items.forEach(it => {
    if (it.type !== 'block' || !it.start || !it.end) return;
    const s = toMin(it.start), e = toMin(it.end);
    if (occursOn(it, d)) bg.push({ it, s, e: e > s ? e : 1440 });
    if (e <= s && occursOn(it, addDays(d, -1))) bg.push({ it, s: 0, e });
  });
  let rs = S.settings.dayStart, re = S.settings.dayEnd;
  blocks.forEach(b => { rs = Math.min(rs, Math.floor(b.s / 60)); re = Math.max(re, Math.ceil(b.e / 60)); });
  bg.forEach(b => { if (b.s > 0) re = Math.max(re, Math.min(24, Math.ceil(b.e / 60))); });  // show the evening half of overnight blocks
  re = Math.min(24, re);
  layout(blocks);
  const hours = Array.from({ length: re - rs + 1 }, (_, i) => rs + i);
  const lines = hours.map(h => `<div class="hr" style="top:${(h - rs) * H}px"><span>${h === 24 ? '' : fmtT(h * 60)}</span></div>`).join('');
  const bgHTML = bg.map(b => {
    const s = Math.max(b.s, rs * 60), e = Math.min(b.e, re * 60); if (e <= s) return '';
    return `<div class="blk block" style="--c:${colorOf(b.it)};top:${(s - rs * 60) / 60 * H}px;height:${(e - s) / 60 * H}px;left:0;right:0" data-act="open" data-id="${b.it.id}"><div class="bt"><b>${esc(b.it.title)}</b><span>${fmtRange(toMin(b.it.start), toMin(b.it.end))}</span></div></div>`;
  }).join('');
  const blk = blocks.map(b => {
    const top = (b.s - rs * 60) / 60 * H, ht = Math.max((b.e - b.s) / 60 * H - 2, 26);
    const left = (b.col / b.cols) * 100, w = 100 / b.cols;
    const sm = ht < 40 ? ' sm' : '';
    const style = `--c:${b.k === 'g' ? b.color : colorOf(b.it)};top:${top}px;height:${ht}px;left:calc(${left}% + 1px);width:calc(${w}% - 4px)`;
    if (b.k === 'g') return `<div class="blk g${sm}" style="${style}" data-act="gopen" data-id="${esc(b.id)}"><div class="bt"><b>${esc(b.title)}</b><span>${fmtRange(b.s, b.e)}</span></div></div>`;
    const done = isDone(b.id, d), sk = off(b.it, d), ex = extraOf(b.it);
    return `<div class="blk${sm} ${b.type} ${done ? 'done' : ''} ${sk ? 'skipped' : ''}" style="${style}" data-act="open" data-id="${b.id}">
      ${checkable(b.it) ? `<button class="chk ${done ? 'on' : ''}" data-act="toggle" data-id="${b.id}" aria-label="Toggle done"></button>` : ''}
      <div class="bt"><b>${esc(b.title)}</b><span>${fmtRange(b.s, b.e)}${ex ? ' · ' + esc(ex) : ''}</span></div></div>`;
  }).join('');
  let now = '';
  if (d === todayStr()) { const n = new Date(), m = n.getHours() * 60 + n.getMinutes(); if (m >= rs * 60 && m <= re * 60) now = `<div class="now" style="top:${(m - rs * 60) / 60 * H}px"></div>`; }

  const topSec = (allDay.length || anytime.length) ? `
    <div class="card" style="margin-top:4px">
      ${allDay.map(e => `<div class="row allday" data-act="gopen" data-id="${esc(e.id)}"><div class="bar" style="background:${gColor(e)}"></div><div class="t"><b>${esc(e.title)}</b><span>All day</span></div></div>`).join('')}
      ${anytime.map(i => anytimeRow(i, d)).join('')}
    </div>` : '';
  return `${stripHTML()}${bannerHTML()}${awayBanner(d)}${topSec}
    <div class="tl" data-rs="${rs}" style="height:${(re - rs) * H + 8}px">${lines}<div class="lane" data-rs="${rs}">${bgHTML}${blk}</div>${now}</div>`;
}

function layout(blocks) {
  blocks.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const cols = [];
    cluster.forEach(b => { let c = cols.findIndex(end => end <= b.s); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = b.e; b.col = c; });
    cluster.forEach(b => { b.cols = cols.length; }); cluster = [];
  };
  blocks.forEach(b => { if (cluster.length && b.s >= clusterEnd) { flush(); clusterEnd = -1; } cluster.push(b); clusterEnd = Math.max(clusterEnd, b.e); });
  flush();
}

/* ============================================================
   rendering: week + month
   ============================================================ */
function weekHTML() {
  const ws = weekStart(S.date), t = todayStr();
  const ln = (c, label, text) => `<div class="ln"><i style="background:${c}"></i><em>${label}</em>${esc(text)}</div>`;
  return bannerHTML() + Array.from({ length: 7 }, (_, i) => {
    const d = addDays(ws, i), items = shown(d), gc = S.gcal[d] || [];
    const lines = [
      ...gc.filter(e => e.allDay).map(e => ({ s: -2, html: ln(gColor(e), 'All day', e.title) })),
      ...items.filter(i => i.type !== 'habit').map(i => {
        const any = i.anytime || !i.start;
        return { s: any ? -1 : toMin(i.start), html: ln(colorOf(i), any ? (i.type === 'test' ? 'Test' : i.type === 'assignment' ? 'Due' : 'Any time') : fmtT(toMin(i.start)), i.title) };
      }),
      ...gc.filter(e => !e.allDay).map(e => ({ s: e.s, html: ln(gColor(e), fmtT(e.s), e.title) })),
    ].sort((a, b) => a.s - b.s).map(l => l.html);
    const gs = goalStatus(d);
    const gl = gs.total ? `<div class="ln"><i style="background:var(--habit)"></i><em>Goals</em>${gs.done}/${gs.total}${gs.done === gs.total ? ' ✓' : ''}</div>` : '';
    const d_ = parse(d);
    return `<button class="wk-row ${d === t ? 'today' : ''}" data-act="goto" data-d="${d}" data-open-day="1">
      <div class="wk-day"><small>${DOW[d_.getDay()].slice(0, 3)}</small><b>${d_.getDate()}</b></div>
      <div class="wk-list">${lines.join('') + gl + awayLine(d, ln) || '<span class="muted">Nothing planned</span>'}</div></button>`;
  }).join('');
}

function monthHTML() {
  const first = S.date.slice(0, 8) + '01', from = weekStart(first), tdy = todayStr(), mon = S.date.slice(0, 7);
  const st = dayStreaks();
  let mDone = 0, mDays = 0, cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(from, i), inMonth = d.slice(0, 7) === mon;
    if (i >= 35 && !inMonth) break;
    const items = shown(d), gc = S.gcal[d] || [], gs = goalStatus(d);
    const all = gs.total > 0 && gs.done === gs.total;
    if (inMonth && d <= tdy && gs.total) { mDays++; if (all) mDone++; }
    const dots = [
      gc.length ? gColor(gc[0]) : '',
      items.some(x => x.type === 'event') ? TYPE_COLOR.event : '',
      items.some(x => x.type === 'study') ? TYPE_COLOR.study : '',
      items.some(x => x.type === 'test') ? TYPE_COLOR.test : '',
      items.some(x => x.type === 'assignment') ? TYPE_COLOR.assignment : '',
    ].filter(Boolean).map(c => `<i style="background:${c}"></i>`).join('');
    const gl = goalList(d), shownG = gl.slice(0, 3);
    const chipsH = shownG.map(g => `<span class="mchip ${g.done ? 'done' : ''} ${g.off ? 'off' : ''}">${esc(goalLabel(g.it))}</span>`).join('') + (gl.length > 3 ? `<span class="mmore">+${gl.length - 3}</span>` : '');
    cells += `<button class="mcell ${inMonth ? '' : 'out'} ${d === tdy ? 'today' : ''} ${d === S.date ? 'sel' : ''} ${all ? 'full' : ''} ${vacationFor(d) ? 'away' : ''}" data-act="goto" data-d="${d}" data-open-day="1">
      <b>${parse(d).getDate()}</b><span class="mchips">${chipsH}</span><span class="mdots">${dots}</span>${vacationFor(d) ? '<em class="plane">✈</em>' : ''}</button>`;
  }
  return `${bannerHTML()}
    <div class="card streakcard"><div><b>🔥 ${st.cur}</b><span>day streak</span></div><div><b>${st.best}</b><span>best</span></div><div><b>${mDone}/${mDays}</b><span>goal days</span></div></div>
    <div class="mgrid">${DOW1.map(x => `<div class="mdow">${x}</div>`).join('')}${cells}</div>
    <p class="hint" style="margin-top:12px"><span class="mchip done" style="display:inline-block;padding:1px 7px">done</span> <span class="mchip" style="display:inline-block;padding:1px 7px">goal</span> &nbsp;<span style="color:var(--event)">●</span> events &nbsp;<span style="color:var(--study)">●</span> study &nbsp;<span style="color:var(--test,#ef4444)">●</span> test</p>`;
}

function testStats(t) {
  const studies = S.items.filter(i => i.type === 'study' && i.testId === t.id);
  let done = 0, planned = 0, mins = 0; const days = new Set();
  if (studies.length) {
    let start = studies.reduce((m, i) => (i.date < m ? i.date : m), t.date);
    const floor = addDays(t.date, -500); if (start < floor) start = floor;
    for (let d = start; d <= t.date; d = addDays(d, 1)) {
      const lg = logOf(d);
      studies.forEach(i => {
        if (!occursOn(i, d)) return;
        const dur = i.start && i.end ? Math.max(0, toMin(i.end) - toMin(i.start)) : 0;
        const logged = lg.mins?.[i.id] || 0;
        if (!lg.skipped?.[i.id] && !isPaused(i, d) && i.rec?.type !== 'perweek') planned++;
        if (lg.done?.[i.id]) { done++; mins += logged || dur; days.add(d); }
        else if (logged) { mins += logged; days.add(d); }
      });
    }
  }
  return { done, planned, mins, days: days.size };
}
const fmtHrs = m => (m < 60 ? `${m} min` : `${(m / 60).toFixed(1).replace(/\.0$/, '')} h`);

function studyByClass() {
  const tdy = todayStr(), studies = S.items.filter(i => i.type === 'study'), tot = {}, wk = {};
  if (!studies.length) return { tot, wk };
  let start = studies.reduce((m, i) => (i.date < m ? i.date : m), tdy);
  const floor = addDays(tdy, -800); if (start < floor) start = floor;
  for (let d = start; d <= tdy; d = addDays(d, 1)) {
    const lg = logOf(d);
    studies.forEach(i => {
      if (!occursOn(i, d)) return;
      const dur = i.start && i.end ? Math.max(0, toMin(i.end) - toMin(i.start)) : 0, logged = lg.mins?.[i.id] || 0;
      const m = lg.done?.[i.id] ? (logged || dur) : logged; if (!m) return;
      const k = i.classId || ''; tot[k] = (tot[k] || 0) + m; if (d >= addDays(tdy, -6)) wk[k] = (wk[k] || 0) + m;
    });
  }
  return { tot, wk };
}
function classStudyHTML() {
  const { tot, wk } = studyByClass(), ids = Object.keys(tot); if (!ids.length) return '';
  const mx = Math.max(1, ...ids.map(k => tot[k]));
  return `<div class="sec-title">Study time by class</div><div class="card" style="padding:12px 14px 2px">${ids.sort((a, b) => tot[b] - tot[a]).map(k => {
    const c = classById(k), col = c?.color || '#94a3b8';
    return `<div class="crow"><div class="ctop"><b>${esc(c?.name || 'No class')}</b><span>${fmtHrs(tot[k])} · ${fmtHrs(wk[k] || 0)} this week</span></div><div class="pbar" style="margin:6px 0 12px"><i style="width:${tot[k] / mx * 100}%;background:${col}"></i></div></div>`;
  }).join('')}</div>`;
}
function progressHTML() {
  const tdy = todayStr(), tests = S.items.filter(i => i.type === 'test');
  const up = tests.filter(x => x.date >= tdy).sort((a, b) => (a.date < b.date ? -1 : 1));
  const past = tests.filter(x => x.date < tdy).sort((a, b) => (a.date < b.date ? 1 : -1));
  const scored = tests.filter(x => x.score != null && x.score !== '');
  const pct = x => Math.round(x.score / (x.max || 100) * 100);
  const avg = scored.length ? Math.round(scored.reduce((a, x) => a + pct(x), 0) / scored.length) : null;
  const totalMins = tests.reduce((a, x) => a + testStats(x).mins, 0);
  const stats = x => { const st = testStats(x); return `<div class="pstats"><div><b>${st.done}${st.planned ? `/${st.planned}` : ''}</b><span>sessions</span></div><div><b>${fmtHrs(st.mins)}</b><span>studied</span></div><div><b>${st.days}</b><span>days</span></div></div>`; };
  const upCard = x => {
    const st = testStats(x), w = st.planned ? Math.min(100, Math.round(st.done / st.planned * 100)) : 0;
    return `<div class="pcard" data-act="open" data-id="${x.id}">
      <div class="ph"><div><b>${esc(x.title)}</b><span>${cpill(x)}${shortDate(x.date)}${x.note ? ' · ' + esc(x.note) : ''}</span></div><div class="pbig" style="color:${colorOf(x)}">${cd(x.date).replace('in ', '')}</div></div>
      <div class="pbar"><i style="width:${w}%;background:${colorOf(x)}"></i></div>${stats(x)}</div>`;
  };
  const pastCard = x => {
    const has = x.score != null && x.score !== '';
    return `<div class="pcard" data-act="open" data-id="${x.id}">
      <div class="ph"><div><b>${esc(x.title)}</b><span>${cpill(x)}${shortDate(x.date)}${has ? ` · ${x.score}/${x.max || 100}` : ''}</span></div>
      <div class="pbig" ${has ? '' : 'style="color:var(--accent);font-size:15px"'}>${has ? pct(x) + '%' : 'Add score'}</div></div>${stats(x)}</div>`;
  };
  if (!tests.length) return `${bannerHTML()}<p class="hint" style="margin-top:20px">No tests yet. Tap + → Test to add one, then tie study blocks to it with “For test”. This tab will show sessions, hours and days studied next to each score.</p>`;
  return `${bannerHTML()}
    <div class="card streakcard"><div><b>${tests.length}</b><span>tests</span></div><div><b>${avg != null ? avg + '%' : '–'}</b><span>avg score</span></div><div><b>${fmtHrs(totalMins)}</b><span>studied</span></div></div>
    ${up.length ? `<div class="sec-title">Upcoming</div>${up.map(upCard).join('')}` : ''}
    ${past.length ? `<div class="sec-title">Past</div>${past.map(pastCard).join('')}` : ''}
    ${classStudyHTML()}`;
}

function dueText(i) { const x = parse(i.date); return `${DOW[x.getDay()].slice(0, 3)}, ${shortDate(i.date)}${i.start ? ' · ' + fmtT(toMin(i.start)) : ''}`; }
function assignRow(i) {
  const late = !i.done && i.date < todayStr(), c = colorOf(i);
  return `<div class="arow ${late ? 'late' : ''} ${i.done ? 'isdone' : ''}" data-act="open" data-id="${i.id}">
    <button class="chk ${i.done ? 'on' : ''}" style="--c:${late ? 'var(--danger)' : c}" data-act="toggle" data-id="${i.id}" aria-label="Toggle done"></button>
    <div class="amain"><b>${esc(i.title)}</b><div class="ameta">${cpill(i)}<span>${dueText(i)}</span></div>${i.note ? `<div class="anote">${esc(i.note)}</div>` : ''}</div>
    ${assignBadge(i)}</div>`;
}
function planHTML() {
  const tdy = todayStr(), cls = S.settings.classes || [], f = S.planClass || '';
  const mine = S.items.filter(i => i.type === 'assignment' && (!f || i.classId === f));
  const key = i => i.date + (i.start || '99:99');
  const open = mine.filter(i => !i.done).sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const done = mine.filter(i => i.done).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 20);
  const tmr = addDays(tdy, 1), wkEnd = addDays(tdy, 6 - parse(tdy).getDay()), laterFrom = wkEnd > tmr ? wkEnd : tmr;
  const groups = [
    ['Overdue', open.filter(i => i.date < tdy), 'late'], ['Today', open.filter(i => i.date === tdy)], ['Tomorrow', open.filter(i => i.date === tmr)],
    ['This week', open.filter(i => i.date > tmr && i.date <= wkEnd)], ['Later', open.filter(i => i.date > laterFrom)],
  ].filter(g => g[1].length);
  const chips = cls.length ? `<div class="fchips"><button class="fchip ${!f ? 'on' : ''}" data-act="planclass" data-id="">All</button>${cls.map(c => `<button class="fchip ${f === c.id ? 'on' : ''}" style="--c:${c.color}" data-act="planclass" data-id="${c.id}">${esc(c.name)}</button>`).join('')}</div>` : '';
  const vs = (S.settings.vacations || []).slice().sort((a, b) => (a.start < b.start ? -1 : 1));
  const vRow = v => {
    const n = diffDays(v.start, v.end) + 1, now = v.start <= tdy && tdy <= v.end, past = v.end < tdy;
    const rng = v.start === v.end ? shortDate(v.start) : `${shortDate(v.start)} – ${shortDate(v.end)}`;
    const p = [v.absent?.study && 'Study', v.absent?.habits && 'Habits'].filter(Boolean).join(' · ');
    return `<div class="arow vrow ${past ? 'isdone' : ''}" data-act="editvac" data-id="${v.id}"><span class="vi">✈</span>
      <div class="amain"><b>${esc(v.name)}</b><div class="ameta"><span>${rng} · ${n} day${n === 1 ? '' : 's'}</span></div><div class="ameta"><span>Paused: ${p || 'nothing'}</span></div></div>${now ? '<span class="badge">Now</span>' : ''}</div>`;
  };
  return `${bannerHTML()}
    <div class="qa"><button data-act="qadd" data-t="assignment"><b>＋</b>Assignment</button><button data-act="qadd" data-t="test"><b>＋</b>Test</button><button data-act="qadd" data-t="vacation"><b>＋</b>Time away</button></div>
    <div class="sec-title">Assignments</div>${chips}
    ${groups.length ? groups.map(([name, list, cls_]) => `<div class="gh ${cls_ || ''}">${name} <em>${list.length}</em></div><div class="card">${list.map(assignRow).join('')}</div>`).join('') : `<p class="hint">${mine.length ? 'Nothing left to do. Nice.' : 'No assignments yet. Tap Assignment above to add one.'}</p>`}
    ${done.length ? `<details class="doneblk"><summary>Completed · ${done.length}</summary><div class="card">${done.map(assignRow).join('')}</div></details>` : ''}
    <div class="sec-title">Time away</div>
    ${vs.length ? `<div class="card">${vs.map(vRow).join('')}</div>` : '<p class="hint">Plan breaks and trips here. Choose which goals pause while you’re away.</p>'}
    <div class="sec-title">Classes</div>
    <div class="card" style="padding:4px 14px">${cls.map(c => `<div class="crow2"><input type="color" class="cc" data-f="classcolor" data-id="${c.id}" value="${c.color}"><input class="cin" value="${esc(c.name)}" data-f="classname" data-id="${c.id}" aria-label="Class name"><button class="icon-x" data-act="delclass" data-id="${c.id}" aria-label="Delete class">×</button></div>`).join('')}
      <div class="crow2"><span class="plus">＋</span><input class="cin" id="newClass" placeholder="Add a class, e.g. BIOC 301" autocomplete="off"><button class="btn-sm" data-act="addclass">Add</button></div></div>
    <p class="hint">Classes color-code tests, study blocks and assignments.</p>`;
}

/* ============================================================
   sheets (add/edit item, settings, google event)
   ============================================================ */
function newDraft(o = {}) {
  const type = o.type || 'event';
  return {
    id: o.id || uid(), type, title: o.title || '', note: o.note || '', date: o.date || S.date,
    start: o.start ?? '', end: o.end ?? '', anytime: o.anytime ?? (type === 'habit' && !o.start),
    rec: o.rec || (type === 'habit' ? { type: 'weekdays', days: [0, 1, 2, 3, 4, 5, 6], every: 1, unit: 'day', dom: 1, times: 3 } : { type: 'none', days: [], every: 1, unit: 'day', dom: 1, times: 3 }),
    active: o.active ?? true, color: null, testId: '', score: '', max: 100, classId: '',
    vstart: '', vend: '', absent: { study: true, habits: true },
  };
}
function openAdd(start) {
  const d = newDraft({ start: start != null ? fromMin(start) : '', end: start != null ? fromMin(Math.min(start + 60, 1439)) : '', anytime: start == null ? undefined : false });
  if (start == null) d.anytime = false, d.start = '18:00', d.end = '19:00';
  S.sheet = { kind: 'item', draft: d, editing: false, slotPicked: start != null }; renderSheet();
}
function openEdit(id) {
  const it = S.items.find(x => x.id === id); if (!it) return;
  const d = clean(it); d.rec = { type: 'none', days: [], every: 1, unit: 'day', dom: parse(it.date).getDate(), times: 3, ...(it.rec || {}) };
  d.color = it.color || null; d.testId = it.testId || ''; d.score = it.score ?? ''; d.max = it.max || 100; d.classId = it.classId || '';
  if (!d.start) { d.start = d.type === 'block' ? '23:00' : '09:00'; d.end = d.type === 'block' ? '07:00' : '10:00'; }
  S.sheet = { kind: 'item', draft: d, editing: true }; renderSheet();
}
function openVacation(id) {
  const v = (S.settings.vacations || []).find(x => x.id === id); if (!v) return;
  const d = newDraft({ type: 'vacation', id: v.id }); d.type = 'vacation'; d.title = v.name; d.vstart = v.start; d.vend = v.end; d.absent = { study: !!v.absent?.study, habits: !!v.absent?.habits };
  S.sheet = { kind: 'item', draft: d, editing: true }; renderSheet();
}
function applyTypeDefaults(D, prev, slotPicked) {
  const r = D.rec, recurringDefault = D.type === 'habit' || D.type === 'block';
  if (recurringDefault && r.type === 'none') { r.type = 'weekdays'; r.days = [0, 1, 2, 3, 4, 5, 6]; }
  if (!recurringDefault && r.type === 'weekdays' && (r.days || []).length === 7) r.type = 'none';
  if (D.type === 'test' || D.type === 'assignment') r.type = 'none';
  if (!slotPicked) {
    D.anytime = D.type === 'habit' || D.type === 'test' || D.type === 'assignment';
    if (D.type === 'block') { D.anytime = false; D.start = '23:00'; D.end = '07:00'; }
    else if (!D.anytime && (!D.start || D.start === '23:00')) { D.start = '18:00'; D.end = '19:00'; }
  }
  if (D.type === 'assignment' && !D.start) D.start = '23:59';
  if (D.type === 'vacation') { D.vstart ||= D.date; D.vend ||= D.vstart; }
}
function openAddType(type) {
  openAdd(null); const D = S.sheet.draft, prev = D.type; D.type = type;
  if (S.view === 'plan') D.date = todayStr();
  applyTypeDefaults(D, prev, false); renderSheet();
}
function closeSheet() { S.sheet = null; renderSheet(); render(); }

function onOff(on, f) { return `<button class="sw ${on ? 'on' : ''}" data-act="sw" data-f="${f}" aria-pressed="${on}"></button>`; }

function vacationSheetHTML(D, editing, typeBar) {
  const ab = D.absent || {}, chip = (k, l) => `<button class="cb ${ab[k] ? 'on' : ''}" data-act="vabs" data-k="${k}">${l}</button>`;
  const n = D.vstart && D.vend && D.vend >= D.vstart ? diffDays(D.vstart, D.vend) + 1 : 0;
  return `<div class="scrim" data-act="close"></div><div class="sheet"><div class="grab"></div>
    <div class="sh-head"><button class="link" data-act="close">Cancel</button><b>${editing ? 'Edit time away' : 'New'}</b><button class="link r save" data-act="save">Save</button></div>
    <div class="sh-body">${editing ? '' : typeBar}
      <div class="f"><input type="text" data-f="title" placeholder="Label (e.g. Winter break)" value="${esc(D.title)}" autocomplete="off"></div>
      <div class="f"><div class="fr"><label>First day</label><input type="date" data-f="vstart" value="${D.vstart}"></div>
        <div class="fr"><label>Last day</label><input type="date" data-f="vend" value="${D.vend}"></div></div>
      ${n ? `<p class="hint">${n} day${n === 1 ? '' : 's'} away</p>` : ''}
      <div class="f"><div class="fr stack"><label>Goals paused while away</label><div class="cbs">${chip('study', 'Study')}${chip('habits', 'Habits')}</div></div></div>
      <p class="hint">Paused goals show dimmed and don’t count for or against your streak. Assignments and tests still show.</p>
      ${editing ? '<button class="btn danger" data-act="delete">Delete</button>' : ''}
    </div></div>`;
}

function itemSheetHTML() {
  const { draft: D, editing } = S.sheet, r = D.rec, d = S.date;
  const typeBar = `<div class="types">${['event', 'study', 'habit', 'assignment', 'test', 'block', 'vacation'].map(t => `<button class="${D.type === t ? 'on' : ''}" data-act="type" data-v="${t}">${TYPE_LABEL[t]}</button>`).join('')}</div>`;
  if (D.type === 'vacation') return vacationSheetHTML(D, editing, typeBar);
  const ph = { study: 'Title (e.g. Biochem)', habit: 'Habit (e.g. Workout)', test: 'Test (e.g. Midterm 1)', block: 'Sleep', event: 'Title (e.g. Dinner)', assignment: 'Assignment (e.g. Problem set 4)' }[D.type];
  const notePh = { study: 'What I’ll cover (e.g. Ch. 5, problems 1–10)', test: 'Topics covered', block: 'Notes', event: 'Notes', assignment: 'Details' }[D.type];
  const recOpts = [['none', 'Never'], ['weekdays', 'Specific weekdays'], ['interval', 'Every N days/weeks/months'], ['monthly', 'Monthly on a day'], ['perweek', 'X times a week']];
  let recSub = '';
  if (r.type === 'weekdays') recSub = `<div class="fr stack"><div class="dows">${DOW1.map((x, i) => `<button class="${(r.days || []).includes(i) ? 'on' : ''}" data-act="dow" data-v="${i}">${x}</button>`).join('')}</div></div>`;
  if (r.type === 'interval') recSub = `<div class="fr"><label>Every</label><span><input type="number" min="1" data-f="rec.every" value="${r.every}"> <select data-f="rec.unit">${['day', 'week', 'month'].map(u => `<option value="${u}" ${r.unit === u ? 'selected' : ''}>${u}${r.every > 1 ? 's' : ''}</option>`).join('')}</select></span></div>`;
  if (r.type === 'monthly') recSub = `<div class="fr"><label>Day of month</label><input type="number" min="1" max="31" data-f="rec.dom" value="${r.dom}"></div>`;
  if (r.type === 'perweek') recSub = `<div class="fr"><label>Times per week</label><input type="number" min="1" max="7" data-f="rec.times" value="${r.times}"></div>`;

  const logged = logOf(d).mins?.[D.id] || 0;
  const occursToday = editing && occursOn(S.items.find(x => x.id === D.id) || D, d);
  const sw = S.sw, swOn = sw.id === D.id;
  const stopwatch = (editing && D.type === 'study') ? `
    <div class="f"><div class="stopwatch"><span class="time" id="sw-time">${swText(swOn ? swElapsed() : 0)}</span>
      <button data-act="sw-toggle">${swOn && sw.running ? 'Pause' : swOn && sw.acc ? 'Resume' : 'Start'}</button>
      <button data-act="sw-reset">Reset</button></div>
      <div class="fr"><span class="muted">${logged ? `Logged today: ${logged} min` : 'Optional stopwatch. Nothing is logged unless you add it.'}</span>
      <button data-act="sw-log" style="color:var(--accent);font-weight:650">Add to today</button></div></div>` : '';

  const cls = S.settings.classes || [];
  const classCard = ['study', 'test', 'assignment'].includes(D.type) ? `<div class="f"><div class="fr"><label>Class</label><select data-f="classId"><option value="">None</option>${cls.map(c => `<option value="${c.id}" ${D.classId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div>${cls.length ? '' : '<p class="hint">Add your classes in the Plan tab to color-code and group work.</p>'}` : '';
  const tests = S.items.filter(i => i.type === 'test').sort((a, b) => (a.date < b.date ? -1 : 1));
  const testPick = D.type === 'study' ? `<div class="f"><div class="fr"><label>For test</label><select data-f="testId"><option value="">None</option>${tests.map(t => `<option value="${t.id}" ${D.testId === t.id ? 'selected' : ''}>${esc(t.title)} · ${shortDate(t.date)}</option>`).join('')}</select></div></div>
    <p class="hint">${tests.length ? 'Study blocks tied to a test count toward your daily goals and streak.' : 'Add a Test first, then tie study blocks to it.'}</p>` : '';
  const scoreCard = D.type === 'test' ? `<div class="f"><div class="fr"><label>Score</label><span><input type="number" step="any" data-raw="1" data-f="score" placeholder="—" value="${D.score}"> <span class="muted">/</span> <input type="number" step="any" data-raw="1" data-f="max" value="${D.max}"></span></div></div>
    <p class="hint">Add your score after the test. It shows in the Progress tab.</p>` : '';
  const isA = D.type === 'assignment';
  const showTimes = D.type === 'block' || !D.anytime;
  const cur = D.color || '';
  const defCol = classColor(D.classId) || TYPE_COLOR[D.type];
  const colorCard = `<div class="f"><div class="fr stack"><label>Color</label><div class="swatches">
      <button class="swc auto ${!cur ? 'on' : ''}" style="--c:${defCol}" data-act="color" data-v="" aria-label="Default color"></button>
      ${PALETTE.map(c => `<button class="swc ${cur === c ? 'on' : ''}" style="--c:${c}" data-act="color" data-v="${c}" aria-label="${c}"></button>`).join('')}</div></div></div>`;
  const noRepeat = D.type === 'test' || isA;

  return `<div class="scrim" data-act="close"></div><div class="sheet"><div class="grab"></div>
    <div class="sh-head"><button class="link" data-act="close">Cancel</button><b>${editing ? 'Edit' : 'New'}</b><button class="link r save" data-act="save">Save</button></div>
    <div class="sh-body">
      ${typeBar}
      <div class="f"><input type="text" data-f="title" placeholder="${ph}" value="${esc(D.title)}" autocomplete="off">
        ${D.type !== 'habit' ? `<textarea data-f="note" placeholder="${notePh}">${esc(D.note)}</textarea>` : ''}</div>
      ${D.type === 'block' ? '<p class="hint">Dimmed background time, like sleep or work. If the end is earlier than the start, it runs overnight.</p>' : ''}
      ${classCard}${stopwatch}${testPick}${scoreCard}
      <div class="f">
        <div class="fr"><label>${isA ? 'Due' : (r.type === 'none' || D.type === 'test' ? 'Date' : 'Starts')}</label><input type="date" data-f="date" value="${D.date}"></div>
        ${D.type === 'block' ? '' : `<div class="fr"><label>${isA ? 'Due time' : 'Specific time'}</label>${onOff(!D.anytime, 'timed')}</div>`}
        ${showTimes ? `<div class="fr"><label>${isA ? 'Time' : 'Start'}</label><input type="time" data-f="start" value="${D.start}"></div>
        ${isA ? '' : `<div class="fr"><label>End</label><input type="time" data-f="end" value="${D.end}"></div>`}` : ''}
        ${noRepeat ? '' : `<div class="fr"><label>Repeat</label><select data-f="rec.type">${recOpts.map(([v, l]) => `<option value="${v}" ${r.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${recSub}
        ${r.type !== 'none' ? `<div class="fr"><label>Active</label>${onOff(D.active, 'active')}</div>` : ''}`}
      </div>
      ${colorCard}
      ${editing && checkable(D) && !isA && occursToday ? `<button class="btn" data-act="skip">${isSkipped(D.id, d) ? 'Unskip today' : 'Skip today (keeps streak)'}</button>` : ''}
      ${r.type !== 'none' && editing && !noRepeat ? '<p class="hint">Edits apply to the whole series.</p>' : ''}
      ${editing ? '<button class="btn danger" data-act="delete">Delete</button>' : ''}
    </div></div>`;
}

function settingsSheetHTML() {
  const cloud = S.mode === 'cloud';
  const hours = (sel, from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i).map(h => `<option value="${h}" ${h === sel ? 'selected' : ''}>${fmtT(h * 60)}</option>`).join('');
  const sel = S.settings.calendars?.length ? S.settings.calendars : ['primary'];
  const cal = cloud ? `<div class="sec-title">Google Calendar</div><div class="f">
      <div class="fr"><span>${gToken() ? 'Connected' : 'Needs reconnect'}</span><button data-act="reconnect" style="color:var(--accent);font-weight:650">${gToken() ? 'Refresh' : 'Reconnect'}</button></div>
      ${S.calList.length ? S.calList.map(c => { const key = c.primary ? 'primary' : c.id; return `<div class="fr"><label>${esc(c.summaryOverride || c.summary)}</label><span class="calctl"><input type="color" class="cc" data-f="calcolor" data-id="${esc(key)}" value="${esc(S.settings.calColors?.[key] || c.backgroundColor || '#f59e0b')}"><button class="sw ${sel.includes(c.id) || (c.primary && sel.includes('primary')) ? 'on' : ''}" data-act="cal" data-id="${esc(key)}"></button></span></div>`; }).join('') + (Object.keys(S.settings.calColors || {}).length ? '<div class="fr"><span class="muted">Custom colors in use</span><button data-act="calreset" style="color:var(--accent);font-weight:650">Use Google’s colors</button></div>' : '') : '<div class="fr"><span class="muted">Choose which calendars to show…</span><button data-act="loadcals" style="color:var(--accent);font-weight:650">Load</button></div>'}
    </div>` : `<div class="sec-title">Preview mode</div><p class="hint">Data stays on this device. Google sign-in and Calendar sync turn on once Firebase is configured.</p>`;
  const rec = S.items.filter(i => i.rec && i.rec.type !== 'none');
  return `<div class="scrim" data-act="close"></div><div class="sheet"><div class="grab"></div>
    <div class="sh-head"><span class="link"></span><b>Settings</b><button class="link r save" data-act="close">Done</button></div>
    <div class="sh-body">
      ${cloud ? `<div class="f"><div class="fr"><span>${esc(S.user?.displayName || S.user?.email || '')}<br><small class="muted">${esc(S.user?.email || '')}</small></span><button data-act="signout" style="color:var(--danger);font-weight:650">Sign out</button></div></div>` : ''}
      ${cal}
      <div class="sec-title">Timeline</div><div class="f">
        <div class="fr"><label>Starts</label><select data-f="set.dayStart">${hours(S.settings.dayStart, 0, 12)}</select></div>
        <div class="fr"><label>Ends</label><select data-f="set.dayEnd">${hours(S.settings.dayEnd, 14, 24)}</select></div></div>
      <div class="sec-title">Habits & repeating</div>
      ${rec.length ? `<div class="f">${rec.map(i => `<div class="fr"><label data-act="edit-from-settings" data-id="${i.id}" style="flex:1;padding:12px 0">${esc(i.title)}<br><small class="muted">${TYPE_LABEL[i.type]} · ${esc(recSummary(i))}</small></label><button class="sw ${i.active !== false ? 'on' : ''}" data-act="pause" data-id="${i.id}"></button></div>`).join('')}</div>` : '<p class="hint">Nothing repeating yet.</p>'}
    </div></div>`;
}

function gSheetHTML() {
  const e = S.sheet.ev;
  return `<div class="scrim" data-act="close"></div><div class="sheet"><div class="grab"></div>
    <div class="sh-head"><span class="link"></span><b>Google Calendar</b><button class="link r save" data-act="close">Done</button></div>
    <div class="sh-body"><div class="f"><div class="fr stack"><b style="font-size:18px">${esc(e.title)}</b><br><span class="muted">${e.allDay ? 'All day' : fmtRange(e.s, e.e)}</span>${e.loc ? `<br><span class="muted">${esc(e.loc)}</span>` : ''}</div></div>
    ${e.link ? `<a class="btn" style="text-decoration:none;color:var(--accent)" href="${esc(e.link)}" target="_blank" rel="noopener">Open in Google Calendar</a>` : ''}</div></div>`;
}

function renderSheet() {
  const root = $('#sheet-root');
  if (!S.sheet) { root.innerHTML = ''; return; }
  const scroll = $('.sh-body', root)?.scrollTop || 0;
  const hadSheet = !!$('.sheet', root);
  root.innerHTML = S.sheet.kind === 'item' ? itemSheetHTML() : S.sheet.kind === 'settings' ? settingsSheetHTML() : gSheetHTML();
  if (hadSheet) { const sh = $('.sheet', root), sc = $('.scrim', root); sh.style.animation = 'none'; sh.style.transform = 'none'; sc.style.animation = 'none'; sc.style.opacity = 1; }
  const b = $('.sh-body', root); if (b) b.scrollTop = scroll;
}

/* stopwatch */
const swElapsed = () => S.sw.acc + (S.sw.running ? Date.now() - S.sw.t0 : 0);
const swText = ms => { const s = Math.floor(ms / 1000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
setInterval(() => { const el = $('#sw-time'); if (el && S.sw.running) el.textContent = swText(swElapsed()); }, 500);

/* ============================================================
   events
   ============================================================ */
function setPath(obj, path, val) { const k = path.split('.'); let o = obj; while (k.length > 1) o = o[k.shift()]; o[k[0]] = val; }

function saveDraft() {
  const D = S.sheet.draft;
  if (D.type === 'vacation') {
    if (!D.vstart) { toast('Pick the first day'); return false; }
    const end = D.vend || D.vstart;
    if (end < D.vstart) { toast('The last day can’t be before the first day'); return false; }
    if (!D.absent.study && !D.absent.habits) { toast('Choose at least one goal to pause'); return false; }
    const v = { id: D.id, name: D.title.trim() || 'Time away', start: D.vstart, end, absent: { study: !!D.absent.study, habits: !!D.absent.habits } };
    S.settings.vacations = [...(S.settings.vacations || []).filter(x => x.id !== v.id), v]; DB.saveSettings(); return true;
  }
  const cn = classById(D.classId)?.name;
  if (D.type === 'block' && !D.title.trim()) D.title = 'Sleep';
  if (!D.title.trim() && cn && D.type === 'study') D.title = cn;
  if (!D.title.trim() && cn && D.type === 'test') D.title = `${cn} exam`;
  if (!D.title.trim()) { toast(D.type === 'assignment' ? 'Name the assignment' : 'Add a title'); return false; }
  const anytime = D.type === 'block' ? false : D.anytime;
  if (!anytime && D.start && D.end && D.type !== 'block' && D.type !== 'assignment' && toMin(D.end) <= toMin(D.start)) { toast('End must be after start'); return false; }
  const prev = S.items.find(x => x.id === D.id);
  const it = {
    id: D.id, type: D.type, title: D.title.trim(), note: (D.note || '').trim(), date: D.date,
    start: anytime ? '' : D.start, end: (anytime || D.type === 'assignment') ? '' : D.end, anytime, rec: D.rec, active: D.active,
    color: D.color || '', testId: D.type === 'study' ? (D.testId || '') : '',
    classId: ['study', 'test', 'assignment'].includes(D.type) ? (D.classId || '') : '',
    score: D.type === 'test' && D.score !== '' && D.score != null ? Number(D.score) : null,
    max: D.type === 'test' ? (Number(D.max) || 100) : null,
  };
  if (D.type === 'assignment') it.done = !!prev?.done;
  if (it.type === 'test' || it.type === 'assignment') { it.rec = { type: 'none', days: [], every: 1, unit: 'day', dom: 1, times: 3 }; it.active = true; }
  if (it.rec.type === 'none') it.active = true;
  if (it.rec.type === 'weekdays' && !(it.rec.days || []).length) { toast('Pick at least one weekday'); return false; }
  DB.saveItem(it); return true;
}

document.addEventListener('click', e => {
  if (S.vmenuOpen && !e.target.closest('.vmenu')) { S.vmenuOpen = false; render(); return; }  // tap outside just closes the menu
  const t = e.target.closest('[data-act]');
  if (t) {
    const act = t.dataset.act, id = t.dataset.id;
    if (act !== 'toggle' && t.closest('[data-act="toggle"]')) return;
    switch (act) {
      case 'signin': Cloud.signIn(); break;
      case 'signout': Cloud.signOut().then(() => { S.sheet = null; renderSheet(); render(); }); break;
      case 'vmenu': S.vmenuOpen = !S.vmenuOpen; render(); break;
      case 'view': S.view = t.dataset.v; S.vmenuOpen = false; if (['day', 'week', 'month'].includes(S.view)) S.calView = S.view; S.scrollToNow = true; render(); ensureGcal(); break;
      case 'today': S.date = todayStr(); S.scrollToNow = true; render(); ensureGcal(); break;
      case 'nav': {
        const n = +t.dataset.n;
        if (S.view === 'day') S.date = addDays(S.date, n);
        else if (S.view === 'week') S.date = addDays(S.date, 7 * n);
        else { const d = parse(S.date.slice(0, 8) + '01'); d.setMonth(d.getMonth() + n); S.date = ymd(d); }
        S.scrollToNow = true; render(); ensureGcal(); break;
      }
      case 'goto':
        S.date = t.dataset.d; if (t.dataset.openDay) S.view = 'day';
        S.scrollToNow = true; render(); ensureGcal(); break;
      case 'toggle': {
        e.stopPropagation(); const it = S.items.find(x => x.id === id);
        if (it?.type === 'assignment') DB.saveItem({ ...it, done: !it.done }); else toggleDone(id, S.date);
        render(); break;
      }
      case 'add': openAdd(null); break;
      case 'open': openEdit(id); break;
      case 'gopen': { const ev = (S.gcal[S.date] || []).find(x => x.id === id); if (ev) { S.sheet = { kind: 'g', ev }; renderSheet(); } break; }
      case 'close': if (S.sheet?.kind === 'item' && S.sw.running && S.sw.id === S.sheet.draft.id) { /* keep running */ } S.sheet = null; renderSheet(); render(); break;
      case 'save': if (saveDraft()) closeSheet(); break;
      case 'delete': if (confirm('Delete this item?')) {
        const D = S.sheet.draft;
        if (D.type === 'vacation') { S.settings.vacations = (S.settings.vacations || []).filter(x => x.id !== D.id); DB.saveSettings(); closeSheet(); break; }
        if (D.type === 'test') S.items.filter(x => x.testId === D.id).forEach(x => DB.saveItem({ ...x, testId: '' }));
        DB.delItem(D.id); closeSheet();
      } break;
      case 'color': S.sheet.draft.color = t.dataset.v || null; renderSheet(); break;
      case 'calreset': S.settings.calColors = {}; DB.saveSettings(); renderSheet(); render(); break;
      case 'skip': toggleSkip(S.sheet.draft.id, S.date); renderSheet(); render(); break;
      case 'type': {
        const D = S.sheet.draft, prev = D.type; D.type = t.dataset.v;
        if (!S.sheet.editing && prev !== D.type) applyTypeDefaults(D, prev, !!S.sheet.slotPicked);
        renderSheet(); break;
      }
      case 'vabs': { const D = S.sheet.draft; D.absent[t.dataset.k] = !D.absent[t.dataset.k]; renderSheet(); break; }
      case 'qadd': openAddType(t.dataset.t); break;
      case 'editvac': openVacation(id); break;
      case 'planclass': S.planClass = id || ''; render(); break;
      case 'addclass': {
        const inp = $('#newClass'), name = (inp?.value || '').trim(); if (!name) { toast('Name the class first'); break; }
        const cls = S.settings.classes || [];
        S.settings.classes = [...cls, { id: uid(), name, color: PALETTE[cls.length % PALETTE.length] }]; DB.saveSettings(); render(); break;
      }
      case 'delclass': {
        const c = classById(id); if (!c || !confirm(`Delete ${c.name}? Its items stay, just uncolored.`)) break;
        S.items.filter(x => x.classId === id).forEach(x => DB.saveItem({ ...x, classId: '' }));
        S.settings.classes = S.settings.classes.filter(x => x.id !== id); if (S.planClass === id) S.planClass = ''; DB.saveSettings(); render(); break;
      }
      case 'sw': {
        const D = S.sheet.draft, f = t.dataset.f;
        if (f === 'timed') { D.anytime = !D.anytime; if (!D.anytime && !D.start) D.start = '09:00', D.end = '10:00'; }
        if (f === 'active') D.active = !D.active;
        renderSheet(); break;
      }
      case 'dow': {
        const days = S.sheet.draft.rec.days ||= [], v = +t.dataset.v, i = days.indexOf(v);
        i < 0 ? days.push(v) : days.splice(i, 1); renderSheet(); break;
      }
      case 'settings': S.sheet = { kind: 'settings' }; renderSheet(); if (S.mode === 'cloud' && gToken() && !S.calList.length) loadCalList(); break;
      case 'reconnect': Cloud.signIn().then(() => { if (S.sheet?.kind === 'settings') { loadCalList(); } }); break;
      case 'retry': S.gcalLoaded = {}; ensureGcal(true); break;
      case 'loadcals': loadCalList(); break;
      case 'cal': {
        let cals = (S.settings.calendars?.length ? S.settings.calendars : ['primary']).slice();
        const i = cals.indexOf(id); i < 0 ? cals.push(id) : cals.splice(i, 1);
        if (!cals.length) { toast('Keep at least one calendar'); break; }
        S.settings.calendars = cals; DB.saveSettings(); S.gcalLoaded = {}; renderSheet(); ensureGcal(true); break;
      }
      case 'pause': { const it = S.items.find(x => x.id === id); if (it) { DB.saveItem({ ...it, active: it.active === false }); renderSheet(); } break; }
      case 'edit-from-settings': openEdit(id); break;
      case 'sw-toggle': {
        const D = S.sheet.draft, sw = S.sw;
        if (sw.id !== D.id) { sw.id = D.id; sw.acc = 0; sw.running = false; }
        if (sw.running) { sw.acc += Date.now() - sw.t0; sw.running = false; } else { sw.t0 = Date.now(); sw.running = true; }
        renderSheet(); break;
      }
      case 'sw-reset': S.sw = { id: null, running: false, t0: 0, acc: 0 }; renderSheet(); break;
      case 'sw-log': {
        const D = S.sheet.draft; if (S.sw.id !== D.id) { toast('Start the stopwatch first'); break; }
        const mins = Math.round(swElapsed() / 60000); if (mins < 1) { toast('Under a minute, nothing added'); break; }
        const lg = clean(logOf(S.date)); lg.done ||= {}; lg.skipped ||= {}; lg.mins ||= {}; lg.mins[D.id] = (lg.mins[D.id] || 0) + mins;
        DB.saveLog(S.date, lg); S.sw = { id: null, running: false, t0: 0, acc: 0 }; toast(`Added ${mins} min`); renderSheet(); break;
      }
    }
    return;
  }
  const lane = e.target.closest('.lane');
  if (lane) {
    const rect = lane.getBoundingClientRect(), rs = +lane.dataset.rs;
    const mins = rs * 60 + Math.floor(((e.clientY - rect.top) / H * 60) / 30) * 30;
    openAdd(Math.max(0, Math.min(mins, 1380)));
  }
});

document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'newClass') { e.preventDefault(); document.querySelector('[data-act=addclass]')?.click(); } });
document.addEventListener('input', onField);
document.addEventListener('change', onField);
function onField(e) {
  const el = e.target.closest('[data-f]'); if (!el || el.tagName === 'BUTTON') return;
  const f = el.dataset.f;
  if (f === 'classname' || f === 'classcolor') {
    const c = classById(el.dataset.id); if (!c) return;
    if (f === 'classname') { if (e.type !== 'change') return; c.name = el.value.trim() || c.name; } else c.color = el.value;
    DB.saveSettings(); if (e.type === 'change') render(); return;
  }
  if (f === 'calcolor') {
    S.settings.calColors = { ...(S.settings.calColors || {}), [el.dataset.id]: el.value };
    DB.saveSettings(); if (e.type === 'change') { renderSheet(); render(); } return;
  }
  if (f.startsWith('set.')) {
    S.settings[f.slice(4)] = +el.value;
    if (S.settings.dayEnd <= S.settings.dayStart) S.settings.dayEnd = Math.min(24, S.settings.dayStart + 1);
    DB.saveSettings(); if (e.type === 'change') { renderSheet(); render(); } return;
  }
  const D = S.sheet?.draft; if (!D) return;
  let val = el.value; if (el.type === 'number' && el.dataset.raw === undefined) val = Math.max(+el.min || 1, Math.min(+el.max || 99, parseInt(val, 10) || 1));
  setPath(D, f, val);
  if (f === 'testId' && val) { const t = S.items.find(x => x.id === val); if (t?.classId && !D.classId) D.classId = t.classId; }
  if (f === 'vstart' && D.vend < val) D.vend = val;
  if (e.type === 'change' && (f === 'classId' || f === 'testId' || f === 'vstart')) renderSheet();
  if (e.type === 'change' && (f === 'rec.type' || f === 'rec.every')) {
    if (f === 'rec.type' && val === 'monthly') D.rec.dom = parse(D.date).getDate();
    if (f === 'rec.type' && val === 'weekdays' && !(D.rec.days || []).length) D.rec.days = [parse(D.date).getDay()];
    renderSheet();
  }
}

// swipe left/right on the day view to change day
let sx = 0, sy = 0;
document.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
document.addEventListener('touchend', e => {
  if (S.sheet || S.view !== 'day' || !e.target.closest('main')) return;
  const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) { S.date = addDays(S.date, dx < 0 ? 1 : -1); S.scrollToNow = true; render(); ensureGcal(); }
}, { passive: true });

document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); ensureGcal(); } });
setInterval(() => { if (!S.sheet && !document.hidden && S.view === 'day' && S.date === todayStr()) { const m = $('#main'), sc = m?.scrollTop; render(); if (m && $('#main')) $('#main').scrollTop = sc; } }, 60000);

/* ============================================================
   boot
   ============================================================ */
const forceLocal = new URLSearchParams(location.search).has('local');
if (firebaseConfig?.apiKey && !forceLocal) { S.mode = 'cloud'; Cloud.init().catch(e => { S.booting = false; render(); toast('Firebase failed to load: ' + e.message); }); }
else { S.mode = 'local'; Local.load(); render(); }
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
