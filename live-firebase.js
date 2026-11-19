/* live-firebase.js — 외부 호스팅판 라이브 기능 (Firebase Realtime Database)
 * 수강생: 로그인 없이 강사 위치 알림 · 진행 막대 · 📍 · '수업 중 페이지' 버튼(누를 때만 한 번 이동, 자동으로 끌고 가지 않음)
 * 강사: 주소 뒤에 ?mode=teacher → Google 로그인(firebase-config.js의 teacherEmail 계정) → 라이브 시작
 * 데이터: /rooms/<room>/live {live, sec, at}  ·  /rooms/<room>/viewers/<id> {following, at}
 * room은 firebase-config.js의 LIVE_CONFIG.room (교안마다 다르게 하면 Firebase 프로젝트 하나로 여러 교안을 운영)
 */
(function(){
const CFG = window.LIVE_CONFIG || {};
const ROOM = String(CFG.room || 'main').replace(/[^a-zA-Z0-9_-]/g, '') || 'main';
const BASE = 'rooms/' + ROOM + '/';
const $ = id => document.getElementById(id);
const HEADS = [...document.querySelectorAll('#page h2[id], #page h3[id]')];
const IDS = HEADS.map(h => h.id);
const titleOf = id => { const h = document.getElementById(id); return h ? h.childNodes[0].textContent.trim() : ''; };
const idx = id => Math.max(0, IDS.indexOf(id));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wantTeacher = new URLSearchParams(location.search).get('mode') === 'teacher';

let isTeacher = false, user = null, following = false;
let teacher = { live:false, sec:IDS[0], at:0 };
let liveRef = null, myRef = null, connected = false, configured = false, ready = false;
let viewers = [], mySec = IDS[0], toastTimer = null, adoptedOwn = false;
const teacherMode = () => isTeacher;

let viewerId = '';
try { viewerId = sessionStorage.getItem('live-viewer-id') || ''; } catch(e){}
if (!viewerId){ viewerId = 'v' + Math.random().toString(36).slice(2, 12); try { sessionStorage.setItem('live-viewer-id', viewerId); } catch(e){} }

function toast(msg){
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  t.classList.toggle('up', !$('livebar').hidden);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* 목차 */
$('toc').innerHTML = '<div class="t">목차</div>' + HEADS.map(h =>
  `<a href="#${h.id}" data-id="${h.id}" class="${h.tagName === 'H3' ? 'h3' : ''}"><span>${titleOf(h.id)}</span><span class="pin" hidden>📍강사</span></a>`).join('');
$('toc').addEventListener('click', e => {
  const a = e.target.closest('a[data-id]'); if (!a) return;
  e.preventDefault();
  if (following) stopFollow('목차로 이동해서 따라가기가 해제됐어요');
  scrollToSec(a.dataset.id);
});

function barH(){ return document.querySelector('.topbar').getBoundingClientRect().height; }
function scrollToSec(id){
  const el = document.getElementById(id); if (!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY - barH() - 14;
  window.scrollTo({ top: Math.max(0, y), behavior: reduced ? 'auto' : 'smooth' });
}
function currentSec(){
  const top = barH() + 90; let id = IDS[0];
  for (const h of HEADS){ if (h.getBoundingClientRect().top <= top) id = h.id; else break; }
  return id;
}

/* 상단 바 */
function renderBar(){
  $('roleLabel').textContent = teacherMode() ? '· 강사 화면' : (wantTeacher ? '· 강사 로그인 필요' : '');
  const out = [];
  if (!configured && ready){
    out.push(`<span class="chip">실시간 기능 설정 전 (firebase-config.js)</span>`);
  } else {
    if (teacher.live) out.push(`<span class="chip live"><span class="dot"></span>LIVE</span>`);
    else out.push(`<span class="chip"><span class="dot"></span>${connected ? '라이브 대기 중' : '연결 중…'}</span>`);
  }
  if (configured && wantTeacher){
    if (teacherMode()){
      out.push(`<span class="chip">접속 ${viewers.length}명</span>`);
      out.push(`<button id="liveBtn" class="btn-live ${teacher.live ? 'on' : ''}">${teacher.live ? '■ 라이브 종료' : '● 라이브 시작'}</button>`);
      out.push(`<button id="logoutBtn">로그아웃</button>`);
    } else if (user){
      out.push(`<span class="chip">강사 계정이 아니에요 (${user.email})</span><button id="logoutBtn">로그아웃</button>`);
    } else {
      out.push(`<button id="loginBtn" class="btn-follow">강사 로그인 (Google)</button>`);
    }
  } else if (configured){
    out.push(`<button id="goBtn" class="btn-follow" ${teacher.live ? '' : 'disabled'}>📍 수업 중 페이지</button>`);
  }
  $('bar').innerHTML = out.join('');

  let hint = '';
  if (teacherMode()) hint = teacher.live ? `라이브 중 · 지금 전송 위치: ${titleOf(teacher.sec)}` : '“라이브 시작”을 누르면 수강생이 내가 보는 위치를 알 수 있어요.';
  else if (configured && !wantTeacher && !teacher.live) hint = '강사가 라이브를 시작하면 강사가 설명 중인 위치가 여기에 표시돼요.';
  $('hint').textContent = hint; $('hint').hidden = !hint;

  const lb = $('liveBtn'); if (lb) lb.onclick = toggleLive;
  const gb = $('goBtn'); if (gb) gb.onclick = goToTeacher;
  const li = $('loginBtn'); if (li) li.onclick = login;
  const lo = $('logoutBtn'); if (lo) lo.onclick = () => firebase.auth().signOut();
}

/* 진행 막대 + 📍 + 알림 바 */
function renderPosition(){
  const show = teacher.live && !teacherMode() && !wantTeacher;
  const n = Math.max(1, IDS.length - 1);
  const tp = idx(teacher.sec) / n * 100, mp = idx(mySec) / n * 100;
  $('track').hidden = !teacher.live;
  if (teacher.live){
    $('tFill').style.width = tp + '%'; $('tMk').style.left = tp + '%';
    $('meMk').style.left = mp + '%'; $('meMk').hidden = teacherMode();
    $('tLbl').textContent = `강사 ${idx(teacher.sec) + 1} / ${IDS.length}`;
  }
  HEADS.forEach(h => h.classList.toggle('here', show && h.id === teacher.sec));
  document.querySelectorAll('.toc a').forEach(a => {
    a.classList.toggle('cur', a.dataset.id === mySec);
    a.querySelector('.pin').hidden = !(show && a.dataset.id === teacher.sec);
  });

  const bar = $('livebar');
  if (!show){ bar.hidden = true; return; }
  const ti = idx(teacher.sec), mi = idx(mySec);
  const name = `<b>${titleOf(teacher.sec)}</b>`;
  let html;
  if (ti === mi){
    html = `<span class="msg">✓ 수업 중인 페이지를 보고 있어요 · ${name}</span>`;
    bar.classList.add('same');
  } else {
    const dir = ti > mi ? '↓ 아래쪽' : '↑ 위쪽';
    html = `<span class="msg">📍 지금 수업 중 · ${name} <span class="muted">(${dir})</span></span><button data-act="go" class="btn-follow">수업 중 페이지로 이동</button>`;
    bar.classList.remove('same');
  }
  bar.innerHTML = html; bar.hidden = false;
}
$('livebar').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  if (b.dataset.act === 'go') goToTeacher();
});
/* 수업 중 페이지로 한 번 이동 (자동으로 끌고 가지 않음) */
function goToTeacher(){
  if (!teacher.live) return;
  scrollToSec(teacher.sec); toast('수업 중인 페이지로 이동했어요');
}
function flashBar(){
  const bar = $('livebar'); if (bar.hidden || reduced) return;
  bar.classList.remove('flash'); void bar.offsetWidth; bar.classList.add('flash');
}
function render(){ renderBar(); renderPosition(); }

/* 강사 */
function login(){
  const p = new firebase.auth.GoogleAuthProvider();
  firebase.auth().signInWithPopup(p).catch(err => toast('로그인하지 못했어요: ' + (err.code || err.message)));
}
function broadcast(){
  teacher = { live: teacher.live, sec: mySec, at: Date.now() };
  if (liveRef) liveRef.set({ live: teacher.live, sec: teacher.sec, at: teacher.at })
    .catch(() => toast('위치를 보내지 못했어요. 강사 계정과 보안 규칙을 확인하세요'));
  render();
}
function toggleLive(){ teacher.live = !teacher.live; mySec = currentSec(); broadcast(); toast(teacher.live ? '라이브를 시작했어요' : '라이브를 종료했어요'); }

/* 수강생 */
function reportMe(){
  if (!myRef || !connected || wantTeacher) return;
  myRef.set({ following, at: firebase.database.ServerValue.TIMESTAMP }).catch(() => {});
}
function startFollow(){
  if (!teacher.live) return;
  following = true; reportMe();
  scrollToSec(teacher.sec); toast('강사 화면을 따라갑니다'); render();
}
function stopFollow(msg){
  following = false; reportMe();
  if (msg) toast(msg); render();
}
function applyTeacher(v){
  const sec = IDS.includes(v.sec) ? v.sec : IDS[0];
  const moved = sec !== teacher.sec, wasLive = teacher.live;
  teacher = { live: !!v.live && (teacherMode() || IDS.includes(v.sec)), sec, at: v.at || 0 };
  if (teacherMode()){
    if (!adoptedOwn){ adoptedOwn = true; if (teacher.live) scrollToSec(sec); }
    render(); return;
  }
  if (!teacher.live && following){ following = false; reportMe(); toast('강사가 라이브를 종료했어요'); }
  else if (teacher.live && !wasLive && adoptedOwn) toast('강사가 라이브를 시작했어요');
  adoptedOwn = true;
  if (following && moved) scrollToSec(sec);
  render();
  if (moved && !following) flashBar();
}

/* 스크롤 추적 */
let ticking = false, sendTimer = null;
window.addEventListener('scroll', () => {
  if (ticking) return; ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const s = currentSec();
    if (s !== mySec){
      mySec = s; renderPosition();
      if (teacherMode() && teacher.live){ clearTimeout(sendTimer); sendTimer = setTimeout(() => { if (teacher.sec !== mySec) broadcast(); }, 350); }
    }
  });
}, { passive: true });
const manual = () => { if (following) stopFollow('직접 스크롤해서 따라가기가 해제됐어요'); };
window.addEventListener('wheel', manual, { passive: true });
window.addEventListener('touchmove', manual, { passive: true });
window.addEventListener('keydown', e => {
  if (['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(e.key) && !e.target.closest('button,summary,a,input,textarea,select')) manual();
});

/* 시작 */
const fbc = CFG.firebase || {};
configured = !!(window.firebase && fbc.apiKey && fbc.databaseURL && !/여기|YOUR/.test(fbc.apiKey + fbc.databaseURL));
ready = true;
render();
if (configured){
  firebase.initializeApp(fbc);
  const db = firebase.database();
  liveRef = db.ref(BASE + 'live');
  myRef = db.ref(BASE + 'viewers/' + viewerId);
  db.ref('.info/connected').on('value', s => {
    connected = s.val() === true;
    if (connected && !wantTeacher){ myRef.onDisconnect().remove(); reportMe(); }
    renderBar();
  });
  liveRef.on('value', s => { const v = s.val(); if (v) applyTeacher(v); else { adoptedOwn = true; render(); } });
  if (wantTeacher){
    /* 강사 여부는 보안 규칙이 판단: viewers 목록을 읽을 수 있으면 강사 (이메일을 공개 파일에 두지 않음) */
    const vRef = db.ref(BASE + 'viewers');
    const onViewers = s => { viewers = Object.values(s.val() || {}); renderBar(); };
    firebase.auth().onAuthStateChanged(u => {
      user = u; isTeacher = false; adoptedOwn = false;
      vRef.off('value', onViewers);
      render();
      if (!u) return;
      vRef.once('value').then(s => {
        isTeacher = true; onViewers(s); vRef.on('value', onViewers);
        adoptedOwn = false; liveRef.once('value').then(x => { const v = x.val(); if (v) applyTeacher(v); else render(); });
      }).catch(() => { isTeacher = false; render(); });
    });
  }
}
})();
