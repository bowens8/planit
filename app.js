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
const TYPE_LABEL = { event: 'Event', study: 'Study', habit: 'Habit' };

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
  settings: { dayStart: 6, dayEnd: 23, calendars: ['primary'] },
  view: 'day',
  date: todayStr(),
  gcal: {},                // { 'YYYY-MM-DD': [events] }
  gcalLoaded: {},          // range key -> timestamp
  gcalStatus: 'off',       // off | ok | expired | error
  calList: [],
  sheet: null,
  sw: { id: null, running: false, t0: 0, acc: 0 },
  scrollToNow: true,
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
    if (isSkipped(it.id, d)) continue;
    if (isDone(it.id, d)) n++; else if (d !== today) break;
  }
  return { n, unit: 'd' };
}
const checkable = it => it.type === 'habit' || it.type === 'study';
const itemsOn = d => S.items.filter(it => occursOn(it, d));

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
function addGEvent(ev) {
  if (ev.status === 'cancelled') return;
  if (ev.attendees?.some(a => a.self && a.responseStatus === 'declined')) return;
  const title = ev.summary || '(No title)';
  const push = (d, o) => { (S.gcal[d] ||= []).push({ title, link: ev.htmlLink, loc: ev.location || '', ...o }); };
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
    const results = await Promise.all(cals.map(c => gfetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c)}/events?${qs}`, tok).then(j => j.items || [])));
    for (let d = from; d < to; d = addDays(d, 1)) S.gcal[d] = [];
    results.flat().forEach(addGEvent);
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
  const body = S.view === 'day' ? dayHTML() : S.view === 'week' ? weekHTML() : monthHTML();
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
  } else { h1 = MONTHS[d.getMonth()]; sub = String(d.getFullYear()); }
  const atToday = S.view === 'day' ? S.date === t : S.view === 'week' ? weekStart(S.date) === weekStart(t) : S.date.slice(0, 7) === t.slice(0, 7);
  const initial = esc((S.user?.displayName || S.user?.email || 'B').trim()[0]?.toUpperCase() || 'B');
  return `<header class="top">
    <div><h1>${h1}</h1><p>${sub}</p></div>
    <div class="top-actions">
      ${atToday ? '' : '<button class="pill" data-act="today">Today</button>'}
      <button class="ico" data-act="nav" data-n="-1" aria-label="Previous">‹</button>
      <button class="ico" data-act="nav" data-n="1" aria-label="Next">›</button>
      <button class="avatar" data-act="settings" aria-label="Settings">${initial}</button>
    </div></header>
    <div class="seg">${['day', 'week', 'month'].map(v => `<button class="${S.view === v ? 'on' : ''}" data-act="view" data-v="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>`;
}

/* ============================================================
   rendering: day view
   ============================================================ */
function stripHTML() {
  const ws = weekStart(S.date), t = todayStr();
  return '<div class="strip">' + Array.from({ length: 7 }, (_, i) => {
    const d = addDays(ws, i);
    const has = itemsOn(d).length || (S.gcal[d] || []).length;
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

function anytimeRow(it, d) {
  const sk = isSkipped(it.id, d), done = isDone(it.id, d);
  const r = it.rec || {};
  const met = r.type === 'perweek' && !done && weekDoneCount(it, d) >= r.times;
  const c = it.type === 'study' ? 'var(--study)' : it.type === 'event' ? 'var(--event)' : 'var(--habit)';
  return `<div class="row ${sk ? 'skipped' : ''} ${met ? 'met' : ''}" data-act="open" data-id="${it.id}">
    ${checkable(it) ? `<button class="chk ${done ? 'on' : ''}" style="--c:${c}" data-act="toggle" data-id="${it.id}" aria-label="Toggle done"></button>` : `<span class="chk" style="--c:${c};border-style:dashed"></span>`}
    <div class="t"><b>${esc(it.title)}</b>${it.note ? `<span>${esc(it.note)}</span>` : r.type && r.type !== 'none' ? `<span>${esc(recSummary(it))}</span>` : ''}</div>
    ${checkable(it) ? habitBadge(it, d) : ''}</div>`;
}

function dayHTML() {
  const d = S.date, items = itemsOn(d), gc = S.gcal[d] || [];
  const anytime = items.filter(i => i.anytime || !i.start);
  const allDay = gc.filter(e => e.allDay);
  const blocks = [
    ...items.filter(i => !(i.anytime || !i.start)).map(i => {
      const s = toMin(i.start); const e = i.end ? toMin(i.end) : s + (i.type === 'habit' ? 30 : 60);
      return { k: 'app', id: i.id, type: i.type, title: i.title, s, e: Math.max(e, s + 15), it: i };
    }),
    ...gc.filter(e => !e.allDay).map(e => ({ k: 'g', id: e.id, type: 'g', title: e.title, s: e.s, e: e.e })),
  ];
  let rs = S.settings.dayStart, re = S.settings.dayEnd;
  blocks.forEach(b => { rs = Math.min(rs, Math.floor(b.s / 60)); re = Math.max(re, Math.ceil(b.e / 60)); });
  re = Math.min(24, re);
  layout(blocks);
  const hours = Array.from({ length: re - rs + 1 }, (_, i) => rs + i);
  const lines = hours.map(h => `<div class="hr" style="top:${(h - rs) * H}px"><span>${h === 24 ? '' : fmtT(h * 60)}</span></div>`).join('');
  const blk = blocks.map(b => {
    const top = (b.s - rs * 60) / 60 * H, ht = Math.max((b.e - b.s) / 60 * H - 2, 26);
    const left = (b.col / b.cols) * 100, w = 100 / b.cols;
    const style = `top:${top}px;height:${ht}px;left:calc(${left}% + 1px);width:calc(${w}% - 4px)`;
    const sm = ht < 40 ? ' sm' : '';
    if (b.k === 'g') return `<div class="blk g${sm}" style="${style}" data-act="gopen" data-id="${esc(b.id)}"><div class="bt"><b>${esc(b.title)}</b><span>${fmtRange(b.s, b.e)}</span></div></div>`;
    const done = isDone(b.id, d), sk = isSkipped(b.id, d);
    return `<div class="blk${sm} ${b.type} ${done ? 'done' : ''} ${sk ? 'skipped' : ''}" style="${style}" data-act="open" data-id="${b.id}">
      ${checkable(b.it) ? `<button class="chk ${done ? 'on' : ''}" data-act="toggle" data-id="${b.id}" aria-label="Toggle done"></button>` : ''}
      <div class="bt"><b>${esc(b.title)}</b><span>${fmtRange(b.s, b.e)}${b.it.note ? ' · ' + esc(b.it.note) : ''}</span></div></div>`;
  }).join('');
  let now = '';
  if (d === todayStr()) { const n = new Date(), m = n.getHours() * 60 + n.getMinutes(); if (m >= rs * 60 && m <= re * 60) now = `<div class="now" style="top:${(m - rs * 60) / 60 * H}px"></div>`; }

  const topSec = (allDay.length || anytime.length) ? `
    <div class="card" style="margin-top:4px">
      ${allDay.map(e => `<div class="row allday" data-act="gopen" data-id="${esc(e.id)}"><div class="bar"></div><div class="t"><b>${esc(e.title)}</b><span>All day</span></div></div>`).join('')}
      ${anytime.map(i => anytimeRow(i, d)).join('')}
    </div>` : '';
  return `${stripHTML()}${bannerHTML()}${topSec}
    <div class="tl" data-rs="${rs}" style="height:${(re - rs) * H + 8}px">${lines}<div class="lane" data-rs="${rs}">${blk}</div>${now}</div>`;
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
function habitCounts(d) {
  const hs = itemsOn(d).filter(i => i.type === 'habit' && !isSkipped(i.id, d) && i.rec?.type !== 'perweek');
  return { total: hs.length, done: hs.filter(i => isDone(i.id, d)).length };
}
function weekHTML() {
  const ws = weekStart(S.date), t = todayStr();
  const out = bannerHTML() + Array.from({ length: 7 }, (_, i) => {
    const d = addDays(ws, i), items = itemsOn(d), gc = S.gcal[d] || [];
    const lines = [
      ...gc.filter(e => e.allDay).map(e => ({ s: -1, html: `<div class="ln g"><i></i><em>All day</em>${esc(e.title)}</div>` })),
      ...items.filter(i => !i.anytime && i.start && i.type !== 'habit').map(i => ({ s: toMin(i.start), html: `<div class="ln ${i.type}"><i></i><em>${fmtT(toMin(i.start))}</em>${esc(i.title)}</div>` })),
      ...gc.filter(e => !e.allDay).map(e => ({ s: e.s, html: `<div class="ln g"><i></i><em>${fmtT(e.s)}</em>${esc(e.title)}</div>` })),
    ].sort((a, b) => a.s - b.s).map(l => l.html);
    const hc = habitCounts(d);
    const habitTimed = items.filter(i => i.type === 'habit' && !i.anytime && i.start).length;
    const hl = items.some(i => i.type === 'habit') ? `<div class="ln habit"><i></i><em>Habits</em>${hc.done}/${hc.total || items.filter(i => i.type === 'habit').length}${habitTimed ? ' · ' + habitTimed + ' timed' : ''}</div>` : '';
    const d_ = parse(d);
    return `<button class="wk-row ${d === t ? 'today' : ''}" data-act="goto" data-d="${d}" data-open-day="1">
      <div class="wk-day"><small>${DOW[d_.getDay()].slice(0, 3)}</small><b>${d_.getDate()}</b></div>
      <div class="wk-list">${lines.join('') + hl || '<span class="muted">Nothing planned</span>'}</div></button>`;
  }).join('');
  return out;
}
function monthHTML() {
  const first = S.date.slice(0, 8) + '01', from = weekStart(first), t = todayStr(), mon = S.date.slice(0, 7);
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(from, i), inMonth = d.slice(0, 7) === mon;
    if (i >= 35 && !inMonth) break;
    const items = itemsOn(d), gc = S.gcal[d] || [], hc = habitCounts(d);
    const dots = [gc.length ? 'var(--gcal)' : '', items.some(x => x.type === 'event') ? 'var(--event)' : '', items.some(x => x.type === 'study') ? 'var(--study)' : '']
      .filter(Boolean).map(c => `<i style="background:${c}"></i>`).join('');
    const mark = hc.total ? (hc.done === hc.total ? '<span class="mcheck">✓</span>' : hc.done ? '<span class="mring" style="border-color:var(--habit)"></span>' : '<span class="mring"></span>') : '';
    cells += `<button class="mcell ${inMonth ? '' : 'out'} ${d === t ? 'today' : ''} ${d === S.date ? 'sel' : ''}" data-act="goto" data-d="${d}" data-open-day="1">
      <b>${parse(d).getDate()}</b><span class="mdots">${dots}</span>${mark}</button>`;
  }
  return `${bannerHTML()}<div class="mgrid">${DOW1.map(x => `<div class="mdow">${x}</div>`).join('')}${cells}</div>
    <p class="hint" style="margin-top:14px"><span style="color:var(--habit)">●</span> habits &nbsp;<span style="color:var(--event)">●</span> events &nbsp;<span style="color:var(--study)">●</span> study &nbsp;<span style="color:var(--gcal)">●</span> Google</p>`;
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
    active: o.active ?? true,
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
  if (!d.start) { d.start = '09:00'; d.end = '10:00'; }
  S.sheet = { kind: 'item', draft: d, editing: true }; renderSheet();
}
function closeSheet() { S.sheet = null; renderSheet(); render(); }

function onOff(on, f) { return `<button class="sw ${on ? 'on' : ''}" data-act="sw" data-f="${f}" aria-pressed="${on}"></button>`; }

function itemSheetHTML() {
  const { draft: D, editing } = S.sheet, r = D.rec, d = S.date;
  const ph = D.type === 'study' ? 'Class (e.g. Biochem)' : D.type === 'habit' ? 'Habit (e.g. Workout)' : 'Title (e.g. Dinner)';
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

  return `<div class="scrim" data-act="close"></div><div class="sheet"><div class="grab"></div>
    <div class="sh-head"><button class="link" data-act="close">Cancel</button><b>${editing ? 'Edit' : 'New'}</b><button class="link r save" data-act="save">Save</button></div>
    <div class="sh-body">
      <div class="seg" style="margin:0 0 12px">${['event', 'study', 'habit'].map(t => `<button class="${D.type === t ? 'on' : ''}" data-act="type" data-v="${t}">${TYPE_LABEL[t]}</button>`).join('')}</div>
      <div class="f"><input type="text" data-f="title" placeholder="${ph}" value="${esc(D.title)}" autocomplete="off">
        ${D.type !== 'habit' ? `<textarea data-f="note" placeholder="${D.type === 'study' ? 'What I’ll cover (e.g. Ch. 5, problems 1–10)' : 'Notes'}">${esc(D.note)}</textarea>` : ''}</div>
      ${stopwatch}
      <div class="f">
        <div class="fr"><label>${r.type === 'none' ? 'Date' : 'Starts'}</label><input type="date" data-f="date" value="${D.date}"></div>
        <div class="fr"><label>Specific time</label>${onOff(!D.anytime, 'timed')}</div>
        ${D.anytime ? '' : `<div class="fr"><label>Start</label><input type="time" data-f="start" value="${D.start}"></div>
        <div class="fr"><label>End</label><input type="time" data-f="end" value="${D.end}"></div>`}
        <div class="fr"><label>Repeat</label><select data-f="rec.type">${recOpts.map(([v, l]) => `<option value="${v}" ${r.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${recSub}
        ${r.type !== 'none' ? `<div class="fr"><label>Active</label>${onOff(D.active, 'active')}</div>` : ''}
      </div>
      ${editing && checkable(D) && occursToday ? `<button class="btn" data-act="skip">${isSkipped(D.id, d) ? 'Unskip today' : 'Skip today (keeps streak)'}</button>` : ''}
      ${r.type !== 'none' && editing ? '<p class="hint">Edits apply to the whole series.</p>' : ''}
      ${editing ? '<button class="btn danger" data-act="delete">Delete</button>' : ''}
    </div></div>`;
}

function settingsSheetHTML() {
  const cloud = S.mode === 'cloud';
  const hours = (sel, from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i).map(h => `<option value="${h}" ${h === sel ? 'selected' : ''}>${fmtT(h * 60)}</option>`).join('');
  const sel = S.settings.calendars?.length ? S.settings.calendars : ['primary'];
  const cal = cloud ? `<div class="sec-title">Google Calendar</div><div class="f">
      <div class="fr"><span>${gToken() ? 'Connected' : 'Needs reconnect'}</span><button data-act="reconnect" style="color:var(--accent);font-weight:650">${gToken() ? 'Refresh' : 'Reconnect'}</button></div>
      ${S.calList.length ? S.calList.map(c => `<div class="fr"><label>${esc(c.summaryOverride || c.summary)}</label><button class="sw ${sel.includes(c.id) || (c.primary && sel.includes('primary')) ? 'on' : ''}" data-act="cal" data-id="${esc(c.primary ? 'primary' : c.id)}"></button></div>`).join('') : '<div class="fr"><span class="muted">Choose which calendars to show…</span><button data-act="loadcals" style="color:var(--accent);font-weight:650">Load</button></div>'}
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
  if (!D.title.trim()) { toast('Add a title'); return false; }
  if (!D.anytime && D.start && D.end && toMin(D.end) <= toMin(D.start)) { toast('End must be after start'); return false; }
  const it = { id: D.id, type: D.type, title: D.title.trim(), note: (D.note || '').trim(), date: D.date, start: D.anytime ? '' : D.start, end: D.anytime ? '' : D.end, anytime: D.anytime, rec: D.rec, active: D.active };
  if (it.rec.type === 'none') it.active = true;
  if (it.rec.type === 'weekdays' && !(it.rec.days || []).length) { toast('Pick at least one weekday'); return false; }
  DB.saveItem(it); return true;
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (t) {
    const act = t.dataset.act, id = t.dataset.id;
    if (act !== 'toggle' && t.closest('[data-act="toggle"]')) return;
    switch (act) {
      case 'signin': Cloud.signIn(); break;
      case 'signout': Cloud.signOut().then(() => { S.sheet = null; renderSheet(); render(); }); break;
      case 'view': S.view = t.dataset.v; S.scrollToNow = true; render(); ensureGcal(); break;
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
      case 'toggle': e.stopPropagation(); toggleDone(id, S.date); render(); break;
      case 'add': openAdd(null); break;
      case 'open': openEdit(id); break;
      case 'gopen': { const ev = (S.gcal[S.date] || []).find(x => x.id === id); if (ev) { S.sheet = { kind: 'g', ev }; renderSheet(); } break; }
      case 'close': if (S.sheet?.kind === 'item' && S.sw.running && S.sw.id === S.sheet.draft.id) { /* keep running */ } S.sheet = null; renderSheet(); render(); break;
      case 'save': if (saveDraft()) closeSheet(); break;
      case 'delete': if (confirm('Delete this item?')) { DB.delItem(S.sheet.draft.id); closeSheet(); } break;
      case 'skip': toggleSkip(S.sheet.draft.id, S.date); renderSheet(); render(); break;
      case 'type': {
        const D = S.sheet.draft, prevType = D.type; D.type = t.dataset.v;
        if (!S.sheet.editing && D.rec.type === 'none' && D.type === 'habit' && prevType !== 'habit') D.rec.type = 'weekdays', D.rec.days = [0, 1, 2, 3, 4, 5, 6];
        if (!S.sheet.editing && D.type !== 'habit' && prevType === 'habit' && D.rec.type === 'weekdays' && D.rec.days.length === 7) D.rec.type = 'none';
        if (!S.sheet.editing && prevType !== D.type && !S.sheet.slotPicked) {
          D.anytime = D.type === 'habit';
          if (!D.anytime && !D.start) D.start = '18:00', D.end = '19:00';
        }
        renderSheet(); break;
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

document.addEventListener('input', onField);
document.addEventListener('change', onField);
function onField(e) {
  const el = e.target.closest('[data-f]'); if (!el || el.tagName === 'BUTTON') return;
  const f = el.dataset.f;
  if (f.startsWith('set.')) {
    S.settings[f.slice(4)] = +el.value;
    if (S.settings.dayEnd <= S.settings.dayStart) S.settings.dayEnd = Math.min(24, S.settings.dayStart + 1);
    DB.saveSettings(); if (e.type === 'change') { renderSheet(); render(); } return;
  }
  const D = S.sheet?.draft; if (!D) return;
  let val = el.value; if (el.type === 'number') val = Math.max(+el.min || 1, Math.min(+el.max || 99, parseInt(val, 10) || 1));
  setPath(D, f, val);
  if (e.type === 'change' && (f === 'rec.type' || f === 'rec.every')) {
    if (f === 'rec.type' && val === 'monthly') D.rec.dom = parse(D.date).getDate();
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
