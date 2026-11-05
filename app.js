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
const LOGO = '<svg class="logo" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" fill="#5b6cff"/><rect x="116" y="132" width="280" height="262" rx="44" fill="#fff"/><rect x="116" y="132" width="280" height="76" rx="44" fill="#e8ebff"/><rect x="116" y="170" width="280" height="38" fill="#e8ebff"/><rect x="172" y="104" width="30" height="64" rx="15" fill="#fff"/><rect x="310" y="104" width="30" height="64" rx="15" fill="#fff"/><path d="M184 303l49 49 97-102" fill="none" stroke="#5b6cff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
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
  openNotes: {},
  noClickUntil: 0,
  lastVTap: 0,
  trayOpen: true,
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
const noteOf = (it, d) => {                       // per-day note for one item: { t: title shown on the card, b: longer text }
  let n = logOf(d).notes?.[it.id]; if (n == null || n === '') n = it.doneNote;
  if (!n) return null;
  if (typeof n === 'string') return { t: n.split('\n')[0].slice(0, 40), b: (n.includes('\n') || n.length > 40) ? n : '' };
  return (n.t || n.b) ? { t: n.t || '', b: n.b || '' } : null;
};
const noteLabel = n => (n ? (n.t || n.b.split('\n')[0].slice(0, 40)) : '');
const placeable = it => it.type === 'habit' || it.type === 'study';
const placedAt = (it, d) => (placeable(it) && (it.anytime || !it.start)) ? (logOf(d).at?.[it.id] || '') : '';
const blankLog = lg => { lg.done ||= {}; lg.skipped ||= {}; lg.mins ||= {}; return lg; };
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
      try { sessionStorage.removeItem('planit.redir'); } catch { /* ignore */ }
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
  async reauth() {   // silent-ish reconnect: Google skips the chooser for an already-granted account
    const p = this.provider(); p.setCustomParameters({ login_hint: S.user?.email || '' });
    return this.A.signInWithRedirect(this.auth, p);
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
function autoReconnect() {
  if (S.mode !== 'cloud' || !S.user || gToken() || S.sheet || DR.on) return;
  try {
    const last = +sessionStorage.getItem('planit.redir') || 0;
    if (Date.now() - last < 120e3) return;          // one attempt per couple of minutes, never a loop
    sessionStorage.setItem('planit.redir', String(Date.now()));
  } catch { /* ignore */ }
  Cloud.reauth().catch(() => { /* the banner stays as the manual fallback */ });
}
async function ensureGcal(force) {
  if (S.mode !== 'cloud' || !S.user) return;
  const tok = gToken();
  if (!tok) { S.gcalStatus = 'expired'; render(); autoReconnect(); return; }
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
    if (e.status === 401 || e.status === 403) { localStorage.removeItem('planit.gtok'); S.gcalStatus = 'expired'; autoReconnect(); }
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
  if (S.booting) { app.innerHTML = `<div class="login">${LOGO}</div>`; return; }
  if (S.mode === 'cloud' && !S.user) {
    app.innerHTML = `<div class="login">${LOGO}<h1>PlanIt</h1>
      <p>Your day, your habits, and your Google Calendar in one calm place.</p>
      <button class="btn primary" data-act="signin">Continue with Google</button>
      <p style="font-size:13px">PlanIt asks for read-only access to your calendar. It never changes it.</p></div>`;
    return;
  }
  const prev = $('#main'); const keep = prev ? prev.scrollTop : 0;
  const ae = document.activeElement, dnFocus = ae && ae.classList && ae.classList.contains('dnta') ? { s: ae.selectionStart, e: ae.selectionEnd } : null;
  const body = S.view === 'day' ? dayHTML() : S.view === 'week' ? weekHTML() : S.view === 'progress' ? progressHTML() : S.view === 'plan' ? planHTML() : monthHTML();
  app.innerHTML = headerHTML() + `<main id="main">${body}</main><button class="fab" data-act="add" aria-label="Add">+</button>`;
  const main = $('#main'), viewChanged = S.lastRenderView !== S.view; S.lastRenderView = S.view;
  if (S.view === 'day' && S.scrollToNow) {
    S.scrollToNow = false;
    const tl = $('.tl', main);
    if (tl) {
      const rs = +tl.dataset.rs;
      if ($('.row[data-drag]', main)) main.scrollTop = 0;   // unscheduled habits/assignments waiting at the top: keep them in view
      else if (S.date === todayStr()) { const n = new Date(); main.scrollTop = Math.max(0, ((n.getHours() * 60 + n.getMinutes()) / 60 - rs - 1.2) * H); }
      else { const first = tl.querySelector('.blk'); main.scrollTop = first ? Math.max(0, first.offsetTop - 60) : Math.max(0, (8 - rs) * H); }
    }
  } else main.scrollTop = viewChanged ? 0 : keep;
  if (dnFocus) { const t = $('.dnta'); if (t) { t.focus(); try { t.setSelectionRange(dnFocus.s, dnFocus.e); } catch { /* ignore */ } } }
  document.querySelectorAll('.dnta').forEach(t => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; });
}

function headerHTML() {
  const t = todayStr(), d = parse(S.date);
  let h1, sub;
  if (S.view === 'day') { h1 = S.date === t ? 'Today' : DOW[d.getDay()]; sub = `${S.date === t ? DOW[d.getDay()] + ', ' : ''}${MONTHS[d.getMonth()]} ${d.getDate()}`; }
  else if (S.view === 'week') {
    const a = parse(weekStart(S.date)), b = parse(addDays(weekStart(S.date), 6));
    h1 = weekStart(S.date) === weekStart(t) ? 'This week' : 'Week';
    sub = a.getMonth() === b.getMonth() ? `${MONTHS[a.getMonth()]} ${a.getDate()} – ${b.getDate()}` : `${MONTHS[a.getMonth()].slice(0, 3)} ${a.getDate()} – ${MONTHS[b.getMonth()].slice(0, 3)} ${b.getDate()}`;
  } else if (S.view === 'progress') { h1 = 'Progress'; sub = 'Habits, tests and study'; }
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
      <div class="vmenu"><button class="${isCal ? 'on' : ''}" data-act="vmenu" aria-haspopup="true" aria-expanded="${S.vmenuOpen}">${calLabel[0].toUpperCase() + calLabel.slice(1)} <span class="vdots">${['day', 'week', 'month'].map(v => `<i class="${isCal && v === calLabel ? 'on' : ''}"></i>`).join('')}</span></button>
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
  const nt = noteOf(it, d), openN = nt && nt.b && S.openNotes[it.id + '|' + d];
  const sub = [it.type === 'habit' ? '~' + fmtHrs(it.est || 30) : (it.type === 'study' && it.est) ? '~' + fmtHrs(it.est) : '', extraOf(it) || (r.type && r.type !== 'none' ? recSummary(it) : '')].filter(Boolean).join(' · ');
  const noteH = nt ? `<div class="ntwrap"><button class="ntchip ${openN ? 'open' : ''}" data-act="${nt.b ? 'note' : 'open'}" data-id="${it.id}" data-d="${d}">📝 ${esc(noteLabel(nt))}${nt.b ? ` <i>${openN ? '▴' : '▾'}</i>` : ''}</button></div>${openN ? `<div class="ntbody">${esc(nt.b)}</div>` : ''}` : '';
  const late = it.type === 'assignment' && !it.done && it.date < todayStr();
  const badge = it.type === 'assignment' ? assignBadge(it) : checkable(it) ? habitBadge(it, d) : it.type === 'test' ? `<span class="badge">${cd(it.date)}</span>` : '';
  return `<div class="row ${sk ? 'skipped' : ''} ${met ? 'met' : ''}" data-act="open" data-id="${it.id}"${((it.type === 'assignment' && !it.done) || (placeable(it) && !done)) ? ` data-drag="${it.id}"` : ''}>
    ${checkable(it) ? `<button class="chk ${done ? 'on' : ''}" style="--c:${late ? 'var(--danger)' : c}" data-act="toggle" data-id="${it.id}" aria-label="Toggle done"></button>` : `<span class="chk" style="--c:${c};border-style:dashed"></span>`}
    <div class="t"><b>${esc(it.title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}${noteH}</div>${badge}</div>`;
}

function trayHTML(d) {
  if (d < todayStr()) return '';
  const list = S.items.filter(i => i.type === 'assignment' && !i.done && !i.workStart).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!list.length) return '';
  const rows = list.map(i => {
    const cn = classById(i.classId)?.name;
    return `<div class="row" data-act="open" data-id="${i.id}" data-drag="${i.id}"><span class="chk" style="--c:${colorOf(i)};border-style:dashed"></span>
      <div class="t"><b>${esc(i.title)}</b><span>${[cn, 'due ' + shortDate(i.date), '~' + fmtHrs(i.est || 60)].filter(Boolean).join(' · ')}</span></div><span class="handle">⠿</span></div>`;
  }).join('');
  return `<details class="tray" ${S.trayOpen ? 'open' : ''}><summary>To schedule <em>${list.length}</em></summary><div class="card">${rows}</div><p class="hint" style="margin:6px 4px 0">Hold and drag onto the timeline to schedule.</p></details>`;
}
function dayHTML() {
  const d = S.date, items = shown(d), gc = S.gcal[d] || [];
  const overdue = d === todayStr() ? S.items.filter(i => i.type === 'assignment' && !i.done && i.date < d) : [];
  const schedOn = i => i.type === 'assignment' && i.workStart && i.workDate === d;
  const sched = S.items.filter(i => schedOn(i));
  const anytime = [...overdue.filter(i => !schedOn(i)), ...items.filter(i => (i.type === 'assignment' ? !schedOn(i) : ((i.anytime || !i.start) && !placedAt(i, d))))];
  const allDay = gc.filter(e => e.allDay);
  const blocks = [
    ...sched.map(i => { const s = toMin(i.workStart); return { k: 'app', id: i.id, type: 'assignment', title: i.title, s, e: Math.min(1440, s + (i.est || 60)), it: i, sched: true }; }),
    ...items.filter(i => placedAt(i, d)).map(i => { const s = toMin(placedAt(i, d)); return { k: 'app', id: i.id, type: i.type, title: i.title, s, e: Math.min(1440, s + (i.est || 30)), it: i, placed: true }; }),
    ...items.filter(i => i.type !== 'assignment' && !(i.anytime || !i.start)).map(i => {
      const s = toMin(i.start); const e = i.end ? toMin(i.end) : s + (i.type === 'habit' ? (i.est || 30) : 60);
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
    const done = b.it ? doneFor(b.it, d) : isDone(b.id, d), sk = off(b.it, d), ex = [extraOf(b.it), b.it && noteOf(b.it, d) ? '📝 ' + noteLabel(noteOf(b.it, d)) : ''].filter(Boolean).join(' · ');
    return `<div class="blk${sm} ${b.type} ${done ? 'done' : ''} ${sk ? 'skipped' : ''}" style="${style}" data-act="open" data-id="${b.id}"${(b.sched || b.placed) && !done ? ` data-drag="${b.id}"` : ''}>
      ${checkable(b.it) ? `<button class="chk ${done ? 'on' : ''}" data-act="toggle" data-id="${b.id}" aria-label="Toggle done"></button>` : ''}
      <div class="bt"><b>${esc(b.title)}</b><span>${fmtRange(b.s, b.e)}${ex ? ' · ' + esc(ex) : ''}</span></div>${b.sched ? `<i class="grip" data-resize="${b.id}"></i>` : ''}</div>`;
  }).join('');
  let now = '';
  if (d === todayStr()) { const n = new Date(), m = n.getHours() * 60 + n.getMinutes(); if (m >= rs * 60 && m <= re * 60) now = `<div class="now" style="top:${(m - rs * 60) / 60 * H}px"></div>`; }

  const topSec = (allDay.length || anytime.length) ? `
    <div class="card" style="margin-top:4px">
      ${allDay.map(e => `<div class="row allday" data-act="gopen" data-id="${esc(e.id)}"><div class="bar" style="background:${gColor(e)}"></div><div class="t"><b>${esc(e.title)}</b><span>All day</span></div></div>`).join('')}
      ${anytime.map(i => anytimeRow(i, d)).join('')}
    </div>` : '';
  const dn = logOf(d).note || '';
  const noteBox = `<div class="daynote"><textarea class="dnta" data-f="daynote" rows="${dn ? Math.min(4, dn.split('\n').length + 1) : 1}" placeholder="Note for ${d === todayStr() ? 'today' : 'this day'}…" aria-label="Day note">${esc(dn)}</textarea></div>`;
  return `${stripHTML()}${bannerHTML()}${awayBanner(d)}${topSec}${trayHTML(d)}
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
  const ws = weekStart(S.date), t = todayStr(), WH = 34;
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(ws, i), items = shown(d).filter(i => i.inWeek !== false), gc = S.gcal[d] || [];
    const sched = S.items.filter(i => i.type === 'assignment' && i.workStart && i.workDate === d && i.inWeek !== false);
    const blocks = [
      ...sched.map(i => { const s = toMin(i.workStart); return { k: 'app', id: i.id, title: i.title, s, e: Math.min(1440, s + (i.est || 60)), c: colorOf(i), done: !!i.done }; }),
      ...items.filter(i => placedAt(i, d)).map(i => { const s = toMin(placedAt(i, d)); return { k: 'app', id: i.id, title: i.title, s, e: Math.min(1440, s + (i.est || 30)), c: colorOf(i), done: doneFor(i, d) }; }),
      ...items.filter(i => i.type !== 'assignment' && !(i.anytime || !i.start)).map(i => { const s = toMin(i.start), e = i.end ? toMin(i.end) : s + (i.type === 'habit' ? (i.est || 30) : 60); return { k: 'app', id: i.id, title: i.title, s, e: Math.max(e, s + 15), c: colorOf(i), done: doneFor(i, d) }; }),
      ...gc.filter(e => !e.allDay).map(e => ({ k: 'g', id: e.id, title: e.title, s: e.s, e: e.e, c: gColor(e) })),
    ];
    const schedIds = new Set(sched.map(i => i.id));
    const chips = [
      ...gc.filter(e => e.allDay).map(e => ({ k: 'g', id: e.id, title: e.title, c: gColor(e) })),
      ...items.filter(i => (i.type === 'assignment' ? !schedIds.has(i.id) : ((i.anytime || !i.start) && !placedAt(i, d)))).map(i => ({ k: 'app', id: i.id, title: i.title, c: colorOf(i), done: doneFor(i, d) })),
    ];
    const bg = [];
    S.items.forEach(it => {
      if (it.type !== 'block' || !it.start || !it.end) return;
      const s = toMin(it.start), e = toMin(it.end);
      if (occursOn(it, d)) bg.push({ it, s, e: e > s ? e : 1440 });
      if (e <= s && occursOn(it, addDays(d, -1))) bg.push({ it, s: 0, e });
    });
    return { d, blocks, chips, bg };
  });
  let rs = S.settings.dayStart, re = S.settings.dayEnd;
  days.forEach(x => x.blocks.forEach(b => { rs = Math.min(rs, Math.floor(b.s / 60)); re = Math.max(re, Math.ceil(b.e / 60)); }));
  days.forEach(x => x.bg.forEach(b => { if (b.s > 0) re = Math.max(re, Math.min(24, Math.ceil(b.e / 60))); }));
  re = Math.min(24, re);
  const head = days.map(x => {
    const dt = parse(x.d), gs = goalStatus(x.d), away = vacationFor(x.d);
    return `<button class="wh ${x.d === t ? 'today' : ''} ${x.d === S.date ? 'sel' : ''}" data-act="goto" data-d="${x.d}" data-open-day="1"><small>${DOW[dt.getDay()].slice(0, 1)}</small><b>${dt.getDate()}</b>${away ? '<i class="wg">✈</i>' : gs.total ? `<i class="wg ${gs.done === gs.total ? 'ok' : ''}">${gs.done}/${gs.total}</i>` : '<i class="wg"></i>'}</button>`;
  }).join('');
  const chipRow = days.map(x => {
    const show = x.chips.slice(0, 3), more = x.chips.length - show.length;
    return `<div class="wc" data-act="goto" data-d="${x.d}" data-open-day="1">${show.map(c => `<span class="wchip ${c.done ? 'done' : ''}" style="--c:${c.c}" data-act="${c.k === 'g' ? 'gopen' : 'open'}" data-id="${esc(c.id)}">${esc(c.title)}</span>`).join('')}${more > 0 ? `<em>+${more}</em>` : ''}</div>`;
  }).join('');
  const hrs = Array.from({ length: re - rs + 1 }, (_, i) => rs + i);
  const gutter = hrs.map(h => `<span style="top:${(h - rs) * WH}px">${h === 24 || h === rs && false ? '' : (h % 12 || 12) + (h < 12 || h === 24 ? 'a' : 'p')}</span>`).join('');
  const cols = days.map(x => {
    const bgH = x.bg.map(b => { const s = Math.max(b.s, rs * 60), e = Math.min(b.e, re * 60); if (e <= s) return ''; return `<div class="wbg" style="top:${(s - rs * 60) / 60 * WH}px;height:${(e - s) / 60 * WH}px"></div>`; }).join('');
    layout(x.blocks);
    const bl = x.blocks.map(b => {
      const top = (b.s - rs * 60) / 60 * WH, ht = Math.max((b.e - b.s) / 60 * WH - 1, 12);
      return `<div class="wb ${b.done ? 'done' : ''}" style="--c:${b.c};top:${top}px;height:${ht}px;left:calc(${b.col / b.cols * 100}% + 1px);width:calc(${100 / b.cols}% - 2px)" data-act="${b.k === 'g' ? 'gopen' : 'open'}" data-id="${esc(b.id)}"><b>${esc(b.title)}</b></div>`;
    }).join('');
    let now = '';
    if (x.d === t) { const n = new Date(), m = n.getHours() * 60 + n.getMinutes(); if (m >= rs * 60 && m <= re * 60) now = `<div class="wnow" style="top:${(m - rs * 60) / 60 * WH}px"></div>`; }
    return `<div class="wcol ${x.d === t ? 'today' : ''}" data-act="goto" data-d="${x.d}" data-open-day="1">${bgH}${bl}${now}</div>`;
  }).join('');
  return `${bannerHTML()}<div class="wk"><div class="wk-head"><span></span>${head}</div><div class="wk-chips"><span></span>${chipRow}</div>
    <div class="wk-body" style="height:${(re - rs) * WH + 8}px;--wh:${WH}px"><div class="wgut">${gutter}</div>${cols}</div></div>`;
}

function monthHTML() {
  const first = S.date.slice(0, 8) + '01', from = weekStart(first), tdy = todayStr(), mon = S.date.slice(0, 7);
  const st = dayStreaks();
  let mDone = 0, mDays = 0, cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(from, i), inMonth = d.slice(0, 7) === mon;
    if (i >= 35 && !inMonth) break;
    const items = shown(d), gc = S.gcal[d] || [], gs = goalStatus(d);
    const asg = items.filter(x => x.type === 'assignment'), tot = gs.total + asg.length, dn = gs.done + asg.filter(x => x.done).length;
    const all = tot > 0 && dn === tot, frac = tot ? dn / tot : 0;
    if (inMonth && d <= tdy && gs.total) { mDays++; if (all) mDone++; }
    const dots = [
      gc.length ? gColor(gc[0]) : '',
      items.some(x => x.type === 'event') ? TYPE_COLOR.event : '',
      items.some(x => x.type === 'study') ? TYPE_COLOR.study : '',
      items.some(x => x.type === 'test') ? TYPE_COLOR.test : '',
      items.some(x => x.type === 'assignment') ? TYPE_COLOR.assignment : '',
    ].filter(Boolean).map(c => `<i style="background:${c}"></i>`).join('');
    const gl = [...goalList(d), ...asg.map(x => ({ it: x, done: !!x.done, off: false }))], shownG = gl.slice(0, 3);
    const chipsH = shownG.map(g => `<span class="mchip ${g.done ? 'done' : ''} ${g.off ? 'off' : ''}">${esc(goalLabel(g.it))}</span>`).join('') + (gl.length > 3 ? `<span class="mmore">+${gl.length - 3}</span>` : '');
    cells += `<button class="mcell ${inMonth ? '' : 'out'} ${d === tdy ? 'today' : ''} ${d === S.date ? 'sel' : ''} ${all ? 'full' : ''} ${frac > 0 && !all ? 'part' : ''} ${vacationFor(d) ? 'away' : ''}" style="--p:${frac.toFixed(2)}" data-act="goto" data-d="${d}" data-open-day="1">
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
        const dur = i.start && i.end ? Math.max(0, toMin(i.end) - toMin(i.start)) : (i.est || 0);
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
function habitCard(it) {
  const t = todayStr(), r = it.rec || { type: 'none' }, per = r.type === 'perweek', col = colorOf(it);
  let sched = 0, done = 0, mins = 0, wk = 0, last = ''; const cells = [];
  for (let i = 27; i >= 0; i--) {
    const d = addDays(t, -i), dn = isDone(it.id, d), lg = logOf(d);
    const occ = d >= it.date && !per && occursOn(it, d) && !isPaused(it, d) && !isSkipped(it.id, d);
    cells.push(dn ? 'd' : (occ && d < t) ? 'm' : occ ? 't' : 'n');
    if (dn) { done++; sched++; mins += lg.mins?.[it.id] || 0; if (i < 7) wk++; if (!last && false) last = ''; }
    else if (occ && d < t) sched++;
    { const nn = noteOf(it, d); if (nn && lg.notes?.[it.id]) last = (nn.t ? nn.t + (nn.b ? ' — ' + nn.b.split('\n')[0] : '') : nn.b); }
  }
  const st = streakOf(it, t), rate = sched ? Math.round(done / sched * 100) : 0;
  const weekTxt = per ? `${Math.min(weekDoneCount(it, t), r.times)}/${r.times}` : String(wk);
  return `<div class="pcard" data-act="open" data-id="${it.id}">
    <div class="ph"><div><b>${esc(it.title)}</b><span>${esc(recSummary(it))} · ~${fmtHrs(it.est || 30)}</span></div><div class="pbig" style="color:${col}">${st.n ? '🔥 ' + st.n + st.unit : '–'}</div></div>
    <div class="hheat" style="--c:${col}">${cells.map(c => `<i class="${c}"></i>`).join('')}</div>
    <div class="pstats"><div><b>${weekTxt}</b><span>this week</span></div><div><b>${rate}%</b><span>last 28 days</span></div><div><b>${mins ? fmtHrs(mins) : done}</b><span>${mins ? 'logged' : 'done'}</span></div></div>
    ${last ? `<p class="hnote">📝 ${esc(last)}</p>` : ''}</div>`;
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
  const habits = S.items.filter(i => i.type === 'habit' && i.active !== false);
  const habitSec = habits.length ? `<div class="sec-title">Habits · last 4 weeks</div>${habits.map(habitCard).join('')}` : '';
  if (!tests.length) return `${bannerHTML()}${habitSec}<p class="hint" style="margin-top:20px">${habits.length ? '' : 'Add a habit like Workout to track it here. '}No tests yet. Tap + → Test to add one, then tie study blocks to it with “For test”. This tab will show sessions, hours and days studied next to each score.</p>`;
  return `${bannerHTML()}${habitSec}
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
    <div class="amain"><b>${esc(i.title)}</b><div class="ameta">${cpill(i)}<span class="due">${dueText(i)}</span><span>&nbsp;· ~${fmtHrs(i.est || 60)}</span>${i.workStart ? `<span>&nbsp;· 📅 ${shortDate(i.workDate)} ${fmtT(toMin(i.workStart))}</span>` : ''}</div>${i.note ? `<div class="anote">${esc(i.note)}</div>` : ''}</div>
    ${!i.done ? `<button class="schedbtn" data-act="gosched" data-id="${i.id}" aria-label="Schedule">📅</button>` : ''}${assignBadge(i)}</div>`;
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
  const tests = S.items.filter(i => i.type === 'test' && i.date >= tdy).sort((a, b) => (a.date < b.date ? -1 : 1));
  const testRow = t => {
    const pl = S.items.filter(i => i.type === 'study' && i.testId === t.id && i.id.startsWith('sp_')), mins = pl.reduce((a, i) => a + (i.est || 0), 0);
    return `<div class="arow" data-act="studyplan" data-id="${t.id}"><span class="vi">🎓</span>
      <div class="amain"><b>${esc(t.title)}</b><div class="ameta">${cpill(t)}<span>${DOW[parse(t.date).getDay()].slice(0, 3)}, ${shortDate(t.date)}</span></div>
      <div class="ameta"><span class="${pl.length ? '' : 'due'}">${pl.length ? `Study plan · ${pl.length} day${pl.length === 1 ? '' : 's'} · ${fmtHrs(mins)}` : 'Set up study plan'}</span></div></div><span class="badge">${cd(t.date)}</span></div>`;
  };
  const testSec = tests.length ? `<div class="sec-title">Tests · study plans</div><div class="card">${tests.map(testRow).join('')}</div>` : '';
  return `${bannerHTML()}
    <div class="qa"><button data-act="qadd" data-t="assignment"><b>＋</b>Assignment</button><button data-act="qadd" data-t="test"><b>＋</b>Test</button><button data-act="qadd" data-t="vacation"><b>＋</b>Time away</button></div>
    ${testSec}
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
    active: o.active ?? true, color: null, testId: '', score: '', max: 100, classId: '', est: 60, workDate: '', workStart: '', inWeek: true, dnote: '', dnoteT: '',
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
  d.color = it.color || null; d.testId = it.testId || ''; d.score = it.score ?? ''; d.max = it.max || 100; d.classId = it.classId || ''; d.inWeek = it.inWeek !== false; d.est = it.est || (it.type === 'habit' ? 30 : 60); { const nn = noteOf(it, S.date); d.dnoteT = nn?.t || ''; d.dnote = nn?.b || ''; } d.workDate = it.workDate || ''; d.workStart = it.workStart || '';
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
  if (D.type === 'habit' && prev !== 'habit' && (!D.est || D.est === 60)) D.est = 30;
  if (D.type === 'assignment' && prev === 'habit' && D.est === 30) D.est = 60;
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
  const ests = [...new Set([5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, Number(D.est) || (D.type === 'habit' ? 30 : 60)])].sort((a, b) => a - b);
  const atNow = placeable(D) && editing ? placedAt(D, S.date) : '';
  const durCard = placeable(D) ? `<div class="f"><div class="fr"><label>Time to complete</label><select data-f="est">${ests.map(m => `<option value="${m}" ${(Number(D.est) || (D.type === 'habit' ? 30 : 60)) === m ? 'selected' : ''}>${fmtHrs(m)}</option>`).join('')}</select></div>
      ${atNow ? `<div class="fr"><span class="muted">On ${S.date === todayStr() ? 'today' : shortDate(S.date)}’s timeline at ${fmtT(toMin(atNow))}</span><button data-act="clearat" style="color:var(--danger);font-weight:650">Remove</button></div>` : ''}</div>
    <p class="hint">${D.anytime ? 'Shows at the top of the day. Hold it and drag it onto the timeline where you want it.' : 'Used as the block length when there is no end time.'}</p>` : '';
  const doneNow = editing && checkable(D) && (D.type === 'assignment' ? !!S.items.find(x => x.id === D.id)?.done : isDone(D.id, S.date));
  const dayLbl = S.date === todayStr() ? 'today' : shortDate(S.date);
  const noteCard = editing && D.type !== 'vacation' ? `<div class="f"><div class="fr stack"><label>${doneNow ? 'After-action note' : 'Note'} · ${dayLbl}</label>
      <input type="text" data-f="dnoteT" placeholder="Title (shows on the card)" value="${esc(D.dnoteT || '')}" autocomplete="off">
      <textarea data-f="dnote" placeholder="${doneNow ? 'How did it go? Weights, what you covered, next time…' : 'Details to read when you tap the title…'}">${esc(D.dnote || '')}</textarea></div>
      <p class="hint" style="margin:6px 12px 8px">This note is just for ${dayLbl}. To preset one for another day, open that day and tap the item.</p></div>` : '';
  const workCard = isA ? `<div class="f"><div class="fr"><label>Estimated time</label><select data-f="est">${ests.map(m => `<option value="${m}" ${(Number(D.est) || 60) === m ? 'selected' : ''}>${fmtHrs(m)}</option>`).join('')}</select></div>
      <div class="fr"><label>Work on it</label><input type="date" data-f="workDate" value="${D.workDate}"></div>
      <div class="fr"><label>Starting at</label><input type="time" data-f="workStart" value="${D.workStart}"></div>
      ${D.workStart ? '<div class="fr"><span class="muted">Scheduled on your timeline</span><button data-act="clearwork" style="color:var(--danger);font-weight:650">Clear</button></div>' : ''}</div>
    <p class="hint">Tip: on the Day tab, hold an assignment and drag it onto the timeline.</p>` : '';

  return `<div class="scrim" data-act="close"></div><div class="sheet"><div class="grab"></div>
    <div class="sh-head"><button class="link" data-act="close">Cancel</button><b>${editing ? 'Edit' : 'New'}</b><button class="link r save" data-act="save">Save</button></div>
    <div class="sh-body">
      ${typeBar}
      <div class="f"><input type="text" data-f="title" placeholder="${ph}" value="${esc(D.title)}" autocomplete="off">
        ${D.type !== 'habit' ? `<textarea data-f="note" placeholder="${notePh}">${esc(D.note)}</textarea>` : ''}</div>
      ${noteCard}
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
      ${workCard}${durCard}${colorCard}
      ${D.type === 'habit' ? '' : `<div class="f"><div class="fr"><label>Show on week view</label>${onOff(D.inWeek !== false, 'inweek')}</div></div>`}
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

const SP_DAYS = [['all', 'Every day'], ['weekdays', 'Weekdays'], ['mwf', 'Mon · Wed · Fri'], ['weekends', 'Weekends']];
const spPick = (rule, d) => { const w = parse(d).getDay(); return rule === 'all' || (rule === 'weekdays' && w >= 1 && w <= 5) || (rule === 'mwf' && [1, 3, 5].includes(w)) || (rule === 'weekends' && (w === 0 || w === 6)); };
const spId = (tid, d) => `sp_${tid}_${d}`;
function openStudyPlan(tid) {
  const t = S.items.find(x => x.id === tid); if (!t) return;
  const tdy = todayStr(), rows = []; let def = { mins: 60, start: '18:00', any: false, days: 'all' }, seeded = false;
  for (let d = tdy, n = 0; d < t.date && n < 60; d = addDays(d, 1), n++) {
    const e = S.items.find(x => x.id === spId(tid, d));
    if (e && !seeded) { def = { ...def, mins: e.est || 60, start: e.start || '18:00', any: !e.start }; seeded = true; }
    rows.push(e ? { d, on: true, mins: e.est || 60, start: e.start || '', any: !e.start, title: e.title, note: e.note || '' } : { d, on: false, mins: def.mins, start: def.start, any: def.any, title: '', note: '' });
  }
  if (!rows.length) { toast('That test is today. Add a study block from the + button.'); return; }
  S.sheet = { kind: 'sp', draft: { testId: tid, def, rows } }; renderSheet();
}
function spSheetHTML() {
  const D = S.sheet.draft, t = S.items.find(x => x.id === D.testId) || {}, def = D.def;
  const mopts = cur => [...new Set([15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240, Number(cur) || 60])].sort((a, b) => a - b).map(m => `<option value="${m}" ${(Number(cur) || 60) === m ? 'selected' : ''}>${fmtHrs(m)}</option>`).join('');
  const on = D.rows.filter(r => r.on), tot = on.reduce((a, r) => a + (Number(r.mins) || 0), 0);
  const other = S.items.filter(i => i.type === 'study' && i.testId === t.id && !i.id.startsWith('sp_')).length;
  const rowH = (r, i) => `<div class="f sp ${r.on ? '' : 'off'}">
      <div class="fr"><label>${DOW[parse(r.d).getDay()].slice(0, 3)}, ${shortDate(r.d)}<small class="muted"> · ${cd(r.d)}</small></label>${r.on ? `<select data-f="rows.${i}.mins">${mopts(r.mins)}</select>` : ''}<button class="sw ${r.on ? 'on' : ''}" data-act="sptoggle" data-i="${i}" aria-pressed="${r.on}"></button></div>
      ${r.on ? `<div class="fr stack"><input type="text" data-f="rows.${i}.title" placeholder="Title, e.g. Chapter 5 problems" value="${esc(r.title)}" autocomplete="off"><textarea data-f="rows.${i}.note" placeholder="Notes for this day">${esc(r.note)}</textarea></div>
      <div class="fr"><label>Shows on schedule</label><span class="calctl">${r.any ? '<span class="muted">Any time</span>' : `<input type="time" data-f="rows.${i}.start" value="${r.start}">`}<button class="cb ${r.any ? 'on' : ''}" data-act="spany" data-i="${i}">Any time</button></span></div>` : ''}</div>`;
  return `<div class="scrim" data-act="close"></div><div class="sheet"><div class="grab"></div>
    <div class="sh-head"><button class="link" data-act="close">Cancel</button><b>Study plan</b><button class="link r save" data-act="save">Save</button></div>
    <div class="sh-body">
      <div class="f"><div class="fr stack"><b style="font-size:17px">${esc(t.title || 'Test')}</b><span class="muted">${cpill(t)}${t.date ? DOW[parse(t.date).getDay()] + ', ' + shortDate(t.date) + ' · ' + cd(t.date) : ''}</span></div></div>
      <div class="sec-title" style="margin-top:6px">Quick fill</div>
      <div class="f">
        <div class="fr"><label>Study time per day</label><select data-f="def.mins">${mopts(def.mins)}</select></div>
        <div class="fr"><label>Usual time</label><span class="calctl">${def.any ? '<span class="muted">Any time</span>' : `<input type="time" data-f="def.start" value="${def.start}">`}<button class="cb ${def.any ? 'on' : ''}" data-act="spdefany">Any time</button></span></div>
        <div class="fr"><label>Days</label><select data-f="def.days">${SP_DAYS.map(([v, l]) => `<option value="${v}" ${def.days === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <button class="btn" data-act="spapply">Fill the days below</button>
      <div class="sec-title">${on.length ? `${on.length} study day${on.length === 1 ? '' : 's'} · ${fmtHrs(tot)} total` : 'Days'}</div>
      ${D.rows.map(rowH).join('')}
      <p class="hint">Each study day becomes a goal on that date, with its own title, notes and spot on the daily schedule.${other ? ` ${other} repeating study block${other === 1 ? '' : 's'} for this test also stay${other === 1 ? 's' : ''} as is.` : ''}</p>
      <button class="btn" data-act="edittest" data-id="${t.id}">Edit test details</button>
    </div></div>`;
}
function saveStudyPlan() {
  const D = S.sheet.draft, t = S.items.find(x => x.id === D.testId); if (!t) return true;
  const base = (classById(t.classId)?.name || t.title.replace(/\s*(exam|test|midterm|final|quiz)\s*$/i, '')).trim() || t.title;
  let n = 0;
  D.rows.forEach(r => {
    const id = spId(t.id, r.d), old = S.items.find(x => x.id === id);
    if (!r.on) { if (old) DB.delItem(id); return; }
    const mins = Number(r.mins) || 60, start = r.any ? '' : (r.start || '18:00'), end = start ? fromMin(Math.min(1439, toMin(start) + mins)) : '';
    DB.saveItem({ id, type: 'study', title: (r.title || '').trim() || `${base} study`, note: (r.note || '').trim(), date: r.d, start, end, anytime: r.any, rec: { type: 'none', days: [], every: 1, unit: 'day', dom: 1, times: 3 }, active: true, color: old?.color || '', testId: t.id, classId: t.classId || '', score: null, max: null, inWeek: true, est: mins });
    n++;
  });
  toast(n ? `Study plan saved · ${n} day${n === 1 ? '' : 's'}` : 'Study plan cleared'); return true;
}
function renderSheet() {
  const root = $('#sheet-root');
  if (!S.sheet) { root.innerHTML = ''; return; }
  const scroll = $('.sh-body', root)?.scrollTop || 0;
  const hadSheet = !!$('.sheet', root);
  root.innerHTML = S.sheet.kind === 'item' ? itemSheetHTML() : S.sheet.kind === 'sp' ? spSheetHTML() : S.sheet.kind === 'settings' ? settingsSheetHTML() : gSheetHTML();
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
  if (S.sheet.kind === 'sp') return saveStudyPlan();
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
  it.inWeek = D.inWeek !== false;
  if (placeable(D)) it.est = Number(D.est) || (D.type === 'habit' ? 30 : 60);
  delete it.doneNote;
  if (D.type === 'assignment') { it.done = !!prev?.done; it.est = Number(D.est) || 60; it.workStart = D.workStart || ''; it.workDate = D.workStart ? (D.workDate || D.date) : ''; }
  if (it.type === 'test' || it.type === 'assignment') { it.rec = { type: 'none', days: [], every: 1, unit: 'day', dom: 1, times: 3 }; it.active = true; }
  if (it.rec.type === 'none') it.active = true;
  if (it.rec.type === 'weekdays' && !(it.rec.days || []).length) { toast('Pick at least one weekday'); return false; }
  DB.saveItem(it);
  if (prev) {
    const lg = blankLog(clean(logOf(S.date))); lg.notes ||= {}; const nt = { t: (D.dnoteT || '').trim(), b: (D.dnote || '').trim() };
    const old = JSON.stringify(noteOf(it, S.date) || { t: '', b: '' });
    if (nt.t || nt.b) lg.notes[it.id] = nt; else delete lg.notes[it.id];
    if (JSON.stringify(nt) !== old) DB.saveLog(S.date, lg);
  }
  return true;
}

document.addEventListener('click', e => {
  if (Date.now() < S.noClickUntil) return;
  if (S.vmenuOpen && !e.target.closest('.vmenu')) { S.vmenuOpen = false; render(); return; }  // tap outside just closes the menu
  const t = e.target.closest('[data-act]');
  if (t) {
    const act = t.dataset.act, id = t.dataset.id;
    if (act !== 'toggle' && t.closest('[data-act="toggle"]')) return;
    switch (act) {
      case 'signin': Cloud.signIn(); break;
      case 'signout': Cloud.signOut().then(() => { S.sheet = null; renderSheet(); render(); }); break;
      case 'vmenu': {
        const cal = ['day', 'week', 'month'], now = Date.now();
        if (S.vmenuOpen) { S.vmenuOpen = false; render(); break; }
        if (now - S.lastVTap < 350 && cal.includes(S.view)) {          // double-tap: next view
          S.lastVTap = 0; S.view = cal[(cal.indexOf(S.view) + 1) % 3]; S.calView = S.view; S.scrollToNow = true; render(); ensureGcal(); break;
        }
        S.lastVTap = now;
        if (!cal.includes(S.view)) { S.view = S.calView; S.scrollToNow = true; render(); ensureGcal(); }   // from Plan/Progress: back to calendar
        break;
      }
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
        render(); if (it && it.type !== 'assignment' && isDone(id, S.date)) toast('Done ✓  Tap it to add a note', 2600); break;
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
      case 'gosched': S.view = 'day'; S.calView = 'day'; S.date = todayStr(); S.trayOpen = true; S.scrollToNow = true; render(); toast('Hold the assignment and drag it onto the timeline', 4000); break;
      case 'note': { const k = id + '|' + t.dataset.d; S.openNotes[k] = !S.openNotes[k]; render(); break; }
      case 'clearat': { const lg = blankLog(clean(logOf(S.date))); if (lg.at) delete lg.at[S.sheet.draft.id]; DB.saveLog(S.date, lg); renderSheet(); render(); break; }
      case 'clearwork': S.sheet.draft.workDate = ''; S.sheet.draft.workStart = ''; renderSheet(); break;
      case 'vabs': { const D = S.sheet.draft; D.absent[t.dataset.k] = !D.absent[t.dataset.k]; renderSheet(); break; }
      case 'qadd': openAddType(t.dataset.t); break;
      case 'studyplan': openStudyPlan(id); break;
      case 'sptoggle': { const r = S.sheet.draft.rows[+t.dataset.i]; r.on = !r.on; if (r.on && !r.mins) r.mins = S.sheet.draft.def.mins; renderSheet(); break; }
      case 'spany': { const r = S.sheet.draft.rows[+t.dataset.i]; r.any = !r.any; if (!r.any && !r.start) r.start = S.sheet.draft.def.start || '18:00'; renderSheet(); break; }
      case 'spdefany': { const df = S.sheet.draft.def; df.any = !df.any; if (!df.any && !df.start) df.start = '18:00'; renderSheet(); break; }
      case 'spapply': { const D = S.sheet.draft; D.rows.forEach(r => { r.on = spPick(D.def.days, r.d); if (r.on) { r.mins = Number(D.def.mins); r.start = D.def.start; r.any = D.def.any; } }); renderSheet(); break; }
      case 'edittest': { const tid = id; S.sheet = null; renderSheet(); openEdit(tid); break; }
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
        if (f === 'inweek') D.inWeek = D.inWeek === false;
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
  if (f === 'daynote') {
    const dd = S.date, lg = blankLog(clean(logOf(dd))); const v = el.value; if (v.trim()) lg.note = v; else delete lg.note;
    S.logs[dd] = lg; clearTimeout(S.dnT);
    const flush = () => DB.saveLog(dd, lg);
    if (e.type === 'change') flush(); else S.dnT = setTimeout(flush, 600);
    el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; return;
  }
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
  if (e.type === 'change' && S.sheet.kind === 'sp' && /mins$/.test(f)) { renderSheet(); return; }
  if (e.type === 'change' && (f === 'classId' || f === 'testId' || f === 'vstart' || f === 'workStart')) renderSheet();
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

document.addEventListener('visibilitychange', () => { if (!document.hidden && !DR.on) { render(); ensureGcal(); } });
setInterval(() => { if (!DR.on && !S.sheet && document.activeElement?.tagName !== 'TEXTAREA' && !document.hidden && S.view === 'day' && S.date === todayStr()) { const m = $('#main'), sc = m?.scrollTop; render(); if (m && $('#main')) $('#main').scrollTop = sc; } }, 60000);

/* ============================================================
   drag to schedule, resize, view-button long press
   ============================================================ */
const DR = { timer: null, on: false, id: null, pt: { x: 0, y: 0 }, sx: 0, sy: 0, src: null, ghost: null, start: null, dur: 60, scrollT: null, resize: null, lastTouch: 0 };
const ptOf = e => { const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e; return { x: t.clientX, y: t.clientY }; };
function dragPress(e) {
  if (e.type === 'mousedown' && Date.now() - DR.lastTouch < 800) return;
  if (e.type === 'touchstart') DR.lastTouch = Date.now();
  if (e.button > 0 || S.sheet) return;
  const vb = e.target.closest('[data-act=vmenu]'), grip = e.target.closest('[data-resize]'), src = e.target.closest('[data-drag]');
  if (!vb && !grip && !src) return;
  const pt = ptOf(e); DR.sx = pt.x; DR.sy = pt.y; DR.pt = pt;
  if (grip && $('.lane')) { startResize(grip, pt); if (e.cancelable) e.preventDefault(); return; }
  if (e.target.closest('.chk')) return;
  DR.src = src; clearTimeout(DR.timer);
  DR.timer = setTimeout(() => {
    DR.timer = null;
    if (vb) { S.vmenuOpen = true; S.noClickUntil = Date.now() + 500; render(); DR.src = null; return; }
    if ($('.lane') && src) beginDrag(src);
  }, vb ? 450 : 380);
}
function dragMove(e) {
  if (e.type === 'mousemove' && Date.now() - DR.lastTouch < 800) return;
  const pt = ptOf(e); DR.pt = pt;
  if (DR.resize) { doResize(pt); if (e.cancelable) e.preventDefault(); return; }
  if (DR.timer) { if (Math.hypot(pt.x - DR.sx, pt.y - DR.sy) > 10) { clearTimeout(DR.timer); DR.timer = null; DR.src = null; } return; }
  if (DR.on) { if (e.cancelable) e.preventDefault(); updateDrag(); }
}
function dragEnd(e) {
  if (e.type === 'mouseup' && Date.now() - DR.lastTouch < 800) return;
  clearTimeout(DR.timer); DR.timer = null;
  if (DR.resize) { finishResize(); return; }
  if (DR.on) { finishDrag(e.type === 'touchcancel'); return; }
  DR.src = null;
}
function beginDrag(src) {
  const it = S.items.find(x => x.id === src.dataset.drag); if (!it) return;
  DR.on = true; DR.id = it.id; DR.dur = it.est || (it.type === 'habit' ? 30 : 60); DR.start = null;
  src.classList.add('dragsrc');
  const g = document.createElement('div'); g.className = 'ghost'; g.style.setProperty('--c', colorOf(it));
  g.innerHTML = `<b>${esc(it.title)}</b><span>${fmtHrs(DR.dur)}</span>`; document.body.appendChild(g); DR.ghost = g;
  document.body.classList.add('dragging'); if (navigator.vibrate) navigator.vibrate(12);
  DR.scrollT = setInterval(autoScroll, 16); updateDrag();
}
function updateDrag() {
  if (DR.ghost) DR.ghost.style.transform = `translate(${DR.pt.x - 70}px,${DR.pt.y - 26}px)`;
  const lane = $('.lane'); if (!lane) return;
  const r = lane.getBoundingClientRect(), rs = +lane.dataset.rs, { x, y } = DR.pt;
  let ind = lane.querySelector('.dropind');
  if (y < r.top - 6 || y > r.bottom || x < r.left - 52) { if (ind) ind.remove(); DR.start = null; return; }
  let m = Math.round((rs * 60 + (y - r.top) / H * 60 - 8) / 15) * 15;
  m = Math.max(rs * 60, Math.min(m, 1440 - DR.dur)); DR.start = m;
  if (!ind) { ind = document.createElement('div'); ind.className = 'dropind'; const it = S.items.find(x => x.id === DR.id); ind.style.setProperty('--c', colorOf(it)); lane.appendChild(ind); }
  ind.style.top = `${(m - rs * 60) / 60 * H}px`; ind.style.height = `${Math.max(DR.dur / 60 * H - 2, 26)}px`; ind.textContent = fmtRange(m, m + DR.dur);
}
function autoScroll() {
  const main = $('#main'); if (!main) return;
  const r = main.getBoundingClientRect(), y = DR.pt.y;
  if (y > r.bottom - 90) main.scrollTop += Math.min(20, (y - (r.bottom - 90)) / 3 + 4);
  else if (y < r.top + 50) main.scrollTop -= Math.min(20, (r.top + 50 - y) / 3 + 4);
  updateDrag();
}
function finishDrag(cancel) {
  clearInterval(DR.scrollT); DR.ghost?.remove(); DR.ghost = null; document.body.classList.remove('dragging');
  S.noClickUntil = Date.now() + 450;
  const it = S.items.find(x => x.id === DR.id), start = DR.start, dur = DR.dur;
  DR.on = false; DR.src = null; DR.start = null;
  if (!cancel && it && start != null && placeable(it)) { const lg = blankLog(clean(logOf(S.date))); lg.at ||= {}; lg.at[it.id] = fromMin(start); DB.saveLog(S.date, lg); toast(`${it.title} · ${fmtRange(start, start + dur)}`); }
  else if (!cancel && it && start != null) { DB.saveItem({ ...it, workDate: S.date, workStart: fromMin(start), est: it.est || 60 }); toast(`Scheduled ${fmtRange(start, start + dur)} · ${fmtHrs(dur)}`); }
  render();
}
function startResize(grip, pt) {
  const it = S.items.find(x => x.id === grip.dataset.resize); if (!it || !it.workStart) return;
  DR.resize = { id: it.id, y0: pt.y, d0: it.est || 60, cur: it.est || 60, blk: grip.closest('.blk'), s: toMin(it.workStart) };
  document.body.classList.add('dragging');
}
function doResize(pt) {
  const R = DR.resize; let dur = Math.round((R.d0 + (pt.y - R.y0) / H * 60) / 15) * 15;
  dur = Math.max(15, Math.min(dur, 1440 - R.s)); R.cur = dur;
  R.blk.style.height = `${Math.max(dur / 60 * H - 2, 26)}px`;
  const sp = $('.bt span', R.blk); if (sp) sp.textContent = `${fmtRange(R.s, R.s + dur)} · ${fmtHrs(dur)}`;
}
function finishResize() {
  const R = DR.resize; DR.resize = null; document.body.classList.remove('dragging'); S.noClickUntil = Date.now() + 450;
  const it = S.items.find(x => x.id === R.id); if (it && R.cur !== (it.est || 60)) { DB.saveItem({ ...it, est: R.cur }); toast(`Estimated ${fmtHrs(R.cur)}`); }
  render();
}
['touchstart', 'mousedown'].forEach(t => document.addEventListener(t, dragPress, { passive: false }));
['touchmove', 'mousemove'].forEach(t => document.addEventListener(t, dragMove, { passive: false }));
['touchend', 'touchcancel', 'mouseup'].forEach(t => document.addEventListener(t, dragEnd));
document.addEventListener('contextmenu', e => { if (e.target.closest('[data-drag],[data-act=vmenu],[data-resize]')) e.preventDefault(); });
document.addEventListener('toggle', e => { if (e.target.classList?.contains('tray')) S.trayOpen = e.target.open; }, true);

/* ============================================================
   boot
   ============================================================ */
const forceLocal = new URLSearchParams(location.search).has('local');
if (firebaseConfig?.apiKey && !forceLocal) { S.mode = 'cloud'; Cloud.init().catch(e => { S.booting = false; render(); toast('Firebase failed to load: ' + e.message); }); }
else { S.mode = 'local'; Local.load(); render(); }
try { if (!localStorage.getItem('planit.tip1')) { localStorage.setItem('planit.tip1', '1'); setTimeout(() => toast('Tip: double-tap the view button to switch Day / Week / Month. Hold it for the menu.', 6000), 1200); } } catch { /* ignore */ }
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
