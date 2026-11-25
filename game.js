/* =====================================================================
 * game.js — 팀원1(지도 담당) · "직접 찾아가기" 게임 모드
 * 3D 지도 위 캐릭터를 방향키(또는 WASD, 화면 버튼)로 직접 움직여
 * 추천 동선(window.routePlan)의 1 → 2 → 3 목적지를 차례로 찾아간다.
 *
 *  - map.js가 지도와 시설 데이터를 다 준비한 뒤 이 파일을 불러온다(index.html 수정 필요 없음).
 *  - 쓰는 것: window.mapUtils.getMap(), window.routePlan, window.recommendations, window.appState
 *  - 길은 '직선' 기준이다(팀 결정). 화면에 "실제 길·계단은 현장 안내를 따라 주세요"를 늘 보여준다.
 *  - 게임 속 걷는 속도는 빠르게(초당 GAME_SPEED_MS m) 했고, 실제 예상 도보 시간은 따로 보여준다.
 * ===================================================================== */
(function () {
  'use strict';

  // ───────────────────── 1. 설정값 ─────────────────────
  const GAME_SPEED_MS = 22;      // 게임 속 이동 속도(m/초). 실제 걸음보다 약 20배 빠르다
  const TURN_DEG_S = 130;        // 좌우로 도는 속도(도/초)
  const ARRIVE_M = 18;           // 목적지에서 이 거리 안이면 '도착'
  const MAX_FROM_PARK_M = 1600;  // 공원 중심에서 이보다 멀리 못 가게
  const GAME_PITCH = 62;
  const GAME_ZOOM = 18.2;
  const COLOR = '#db2777';       // map.js 추천 동선 색과 같게
  const AVATAR_BY_PROFILE = [['wheelchair', '♿'], ['stroller', '👶'], ['pregnant', '🤰'], ['elderly', '🧓'], ['concert', '🎤']];

  const G = {
    on: false, map: null, raf: 0, last: 0,
    pos: null, heading: 0, keys: new Set(),
    targets: [], idx: 0, avatar: null, beacon: null,
    startedAt: 0, saved: null, btn: null, hud: null, pad: null,
  };

  // ───────────────────── 2. 작은 도구 ─────────────────────
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  function haversine(a, b) {
    const R = 6371000;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) { // a에서 b를 보는 방향(북쪽 0도, 시계방향)
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + 'km' : Math.round(m) + 'm');
  const ll = (p) => [p.lng, p.lat];

  function avatarEmoji() {
    const p = (window.appState && window.appState.profiles) || [];
    const hit = AVATAR_BY_PROFILE.find(([id]) => p.includes(id));
    return hit ? hit[1] : '🚶';
  }

  // ───────────────────── 3. 모양 (CSS) ─────────────────────
  function injectStyle() {
    if (document.getElementById('game-style')) return;
    const css = `
:where(.gm-start){display:flex;align-items:center;gap:6px;border:0;border-radius:999px;padding:0 14px;min-height:40px;background:${COLOR};color:#fff;
  font:800 13px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 10px rgba(219,39,119,.35)}
:where(.gm-start:hover){filter:brightness(1.07)}
#map.is-game .maplibregl-ctrl-top-left, #map.is-game .maplibregl-ctrl-top-right, #map.is-game .map-notice{display:none}
#map.is-game-full{position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;height:100dvh !important;max-height:none !important;
  border-radius:0 !important;z-index:3000 !important;margin:0 !important}
:where(.gm-hud){position:absolute;z-index:6;left:10px;right:10px;top:10px;display:flex;gap:8px;align-items:flex-start;pointer-events:none;font-family:system-ui,sans-serif}
:where(.gm-card){pointer-events:auto;flex:1;min-width:0;background:rgba(17,24,39,.86);color:#fff;border-radius:14px;padding:9px 12px;box-shadow:0 6px 20px rgba(0,0,0,.3);backdrop-filter:blur(4px)}
:where(.gm-step){font-size:12px;opacity:.85;font-weight:700}
:where(.gm-goal){font-size:15px;font-weight:800;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
:where(.gm-goal small){font-weight:600;opacity:.8}
:where(.gm-dots){display:flex;gap:4px;margin-top:6px}
:where(.gm-dots i){width:18px;height:5px;border-radius:3px;background:rgba(255,255,255,.3)}
:where(.gm-dots i.done){background:#34d399}
:where(.gm-dots i.now){background:${COLOR}}
:where(.gm-warn){font-size:11px;opacity:.75;margin-top:4px}
:where(.gm-compass){pointer-events:auto;flex:none;width:64px;height:64px;border-radius:50%;background:rgba(17,24,39,.86);color:#fff;display:grid;place-items:center;position:relative;box-shadow:0 6px 20px rgba(0,0,0,.3)}
:where(.gm-arrow){width:0;height:0;border-left:10px solid transparent;border-right:10px solid transparent;border-bottom:26px solid ${COLOR};transform-origin:50% 60%;transition:transform .08s linear;margin-top:-10px}
:where(.gm-dist){position:absolute;bottom:6px;left:0;right:0;text-align:center;font:800 11px/1 system-ui,sans-serif}
:where(.gm-exit){pointer-events:auto;flex:none;width:40px;height:40px;border-radius:50%;border:0;background:rgba(17,24,39,.86);color:#fff;font-size:18px;cursor:pointer}
:where(.gm-pad){position:absolute;z-index:6;right:12px;bottom:28px;display:grid;grid-template-columns:repeat(3,52px);grid-template-rows:repeat(3,52px);gap:4px;touch-action:none;user-select:none;-webkit-user-select:none}
:where(.gm-pad button){border:0;border-radius:14px;background:rgba(255,255,255,.92);color:#111827;font-size:22px;font-weight:800;box-shadow:0 3px 10px rgba(0,0,0,.25);touch-action:none;cursor:pointer}
:where(.gm-pad button.is-down){background:${COLOR};color:#fff}
:where(.gm-help){position:absolute;z-index:6;left:12px;bottom:28px;max-width:calc(100% - 200px);background:rgba(255,255,255,.94);border-radius:12px;padding:7px 10px;font:600 12px/1.45 system-ui,sans-serif;color:#1a1d21;box-shadow:0 3px 10px rgba(0,0,0,.2)}
:where(.gm-toast){position:absolute;z-index:7;left:50%;top:42%;transform:translate(-50%,-50%) scale(.9);opacity:0;pointer-events:none;background:#fff;color:#111827;border-radius:18px;padding:16px 22px;text-align:center;
  font:800 18px/1.4 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.3);transition:opacity .25s,transform .25s}
:where(.gm-toast.show){opacity:1;transform:translate(-50%,-50%) scale(1)}
:where(.gm-toast small){display:block;font-size:13px;font-weight:600;color:#4a5260;margin-top:4px}
:where(.gm-end){pointer-events:auto;position:absolute;z-index:8;inset:0;display:grid;place-items:center;background:rgba(17,24,39,.45)}
:where(.gm-end-card){background:#fff;border-radius:18px;padding:20px 22px;max-width:320px;width:calc(100% - 40px);text-align:center;font-family:system-ui,sans-serif;color:#1a1d21;box-shadow:0 12px 40px rgba(0,0,0,.3)}
:where(.gm-end-card h3){margin:0 0 6px;font-size:20px}
:where(.gm-end-card p){margin:4px 0;font-size:14px;color:#4a5260}
:where(.gm-end-card .row){display:flex;gap:8px;justify-content:center;margin-top:12px}
:where(.gm-end-card button){min-height:44px;padding:0 16px;border-radius:12px;border:2px solid ${COLOR};background:#fff;color:${COLOR};font:800 14px system-ui,sans-serif;cursor:pointer}
:where(.gm-end-card button.primary){background:${COLOR};color:#fff}
:where(.gm-avatar){display:grid;place-items:center;width:46px;height:46px;border-radius:50%;background:#fff;border:3px solid ${COLOR};font-size:24px;line-height:1;
  box-shadow:0 6px 14px rgba(0,0,0,.35);position:relative}
:where(.gm-avatar)::after{content:'';position:absolute;left:50%;top:-11px;margin-left:-7px;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:10px solid ${COLOR}}
:where(.gm-avatar.walking){animation:gm-walk .32s ease-in-out infinite alternate}
:where(.gm-avatar-shadow){width:34px;height:9px;margin:2px auto 0;border-radius:50%;background:radial-gradient(rgba(0,0,0,.4),rgba(0,0,0,0) 70%)}
:where(.gm-beacon){position:relative;width:60px;height:150px;pointer-events:none}
:where(.gm-beacon .beam){position:absolute;left:50%;bottom:10px;width:16px;margin-left:-8px;height:140px;border-radius:8px;
  background:linear-gradient(to top,${COLOR}cc,${COLOR}00);filter:blur(1px);animation:gm-beam 1.6s ease-in-out infinite}
:where(.gm-beacon .ring){position:absolute;left:50%;bottom:0;width:56px;height:20px;margin-left:-28px;border-radius:50%;border:3px solid ${COLOR};animation:gm-ring 1.6s ease-out infinite}
:where(.gm-beacon .num){position:absolute;left:50%;bottom:40px;transform:translateX(-50%);min-width:30px;height:30px;padding:0 6px;border-radius:15px;background:${COLOR};color:#fff;
  display:grid;place-items:center;font:800 15px system-ui,sans-serif;border:2px solid #fff;box-shadow:0 4px 10px rgba(0,0,0,.3)}
@keyframes gm-walk{from{translate:0 0}to{translate:0 -5px}}
@keyframes gm-beam{0%,100%{opacity:.6}50%{opacity:1}}
@keyframes gm-ring{0%{transform:scale(.5);opacity:1}100%{transform:scale(1.4);opacity:0}}
@media (prefers-reduced-motion:reduce){:where(.gm-avatar.walking),:where(.gm-beacon .beam),:where(.gm-beacon .ring){animation:none}}
@media (max-width:420px){:where(.gm-pad){grid-template-columns:repeat(3,46px);grid-template-rows:repeat(3,46px)}:where(.gm-help){display:none}}
`;
    const st = document.createElement('style');
    st.id = 'game-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ───────────────────── 4. 목적지 정하기 ─────────────────────
  function buildTargets() {
    const plan = window.routePlan;
    if (plan && plan.stops && plan.stops.length) {
      return plan.stops.map((s) => ({ lat: s.lat, lng: s.lng, label: s.label, name: s.name }));
    }
    const r = (window.recommendations || [])[0];
    return r ? [{ lat: r.lat, lng: r.lng, label: '추천 화장실 1위', name: r.name }] : [];
  }

  function startPoint() {
    const u = window.appState && window.appState.userLocation;
    return u ? { lat: u.lat, lng: u.lng } : null;
  }

  // ───────────────────── 5. 화면 요소 ─────────────────────
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function buildHud(container) {
    const hud = el('div', 'gm-hud');
    hud.innerHTML =
      '<div class="gm-card" role="status" aria-live="polite">' +
        '<div class="gm-step"></div><div class="gm-goal"></div><div class="gm-dots"></div>' +
        '<div class="gm-warn">직선 안내예요. 실제 길·계단은 현장 안내를 따라 주세요.</div>' +
      '</div>' +
      '<div class="gm-compass" aria-hidden="true"><div class="gm-arrow"></div><div class="gm-dist"></div></div>' +
      '<button type="button" class="gm-exit" aria-label="찾아가기 그만하기">✕</button>';
    hud.querySelector('.gm-exit').addEventListener('click', () => stop());
    container.appendChild(hud);

    const help = el('div', 'gm-help', '⬆ 앞으로 · ⬇ 뒤로 · ⬅➡ 돌기<br>키보드: 방향키 또는 W A S D');
    container.appendChild(help);

    const pad = el('div', 'gm-pad');
    const btns = [['', ''], ['up', '▲'], ['', ''], ['left', '◀'], ['', ''], ['right', '▶'], ['', ''], ['down', '▼'], ['', '']];
    btns.forEach(([k, t]) => {
      if (!k) { pad.appendChild(el('span')); return; }
      const b = el('button', '', t);
      b.type = 'button';
      b.setAttribute('aria-label', { up: '앞으로', down: '뒤로', left: '왼쪽으로 돌기', right: '오른쪽으로 돌기' }[k]);
      const on = (ev) => { ev.preventDefault(); G.keys.add(k); b.classList.add('is-down'); };
      const off = (ev) => { if (ev) ev.preventDefault(); G.keys.delete(k); b.classList.remove('is-down'); };
      b.addEventListener('pointerdown', (ev) => { b.setPointerCapture && b.setPointerCapture(ev.pointerId); on(ev); });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((n) => b.addEventListener(n, off));
      b.addEventListener('contextmenu', (ev) => ev.preventDefault());
      pad.appendChild(b);
    });
    container.appendChild(pad);

    const toast = el('div', 'gm-toast');
    container.appendChild(toast);
    G.hud = hud; G.help = help; G.pad = pad; G.toast = toast;
  }

  function updateHud(dist, relDeg) {
    const t = G.targets[G.idx];
    G.hud.querySelector('.gm-step').textContent = '목표 ' + (G.idx + 1) + ' / ' + G.targets.length;
    G.hud.querySelector('.gm-goal').innerHTML = esc(t.label) + ' <small>' + esc(t.name) + '</small>';
    G.hud.querySelector('.gm-dots').innerHTML = G.targets.map((_, i) => '<i class="' + (i < G.idx ? 'done' : i === G.idx ? 'now' : '') + '"></i>').join('');
    G.hud.querySelector('.gm-arrow').style.transform = 'rotate(' + relDeg.toFixed(1) + 'deg)';
    G.hud.querySelector('.gm-dist').textContent = fmtM(dist);
  }

  let toastTimer = 0;
  function toast(html, ms) {
    G.toast.innerHTML = html;
    G.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => G.toast.classList.remove('show'), ms || 1600);
  }

  function placeBeacon() {
    const t = G.targets[G.idx];
    if (!G.beacon) {
      const b = el('div', 'gm-beacon', '<div class="beam"></div><div class="ring"></div><div class="num"></div>');
      G.beacon = new maplibregl.Marker({ element: b, anchor: 'bottom', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(ll(t)).addTo(G.map);
    }
    G.beacon.setLngLat(ll(t));
    G.beacon.getElement().querySelector('.num').textContent = G.idx + 1;
  }

  // ───────────────────── 6. 게임 진행 ─────────────────────
  function start() {
    const map = window.mapUtils && window.mapUtils.getMap && window.mapUtils.getMap();
    const from = startPoint();
    const targets = buildTargets();
    if (!map || !from) return;
    if (!targets.length) {
      alertInMap('찾아갈 곳이 없어요. 위에서 상황을 고르거나 필터를 줄여 주세요.');
      return;
    }
    G.map = map;
    G.on = true;
    G.pos = { lat: from.lat, lng: from.lng };
    G.targets = targets;
    G.idx = 0;
    G.heading = bearing(G.pos, targets[0]);
    G.startedAt = performance.now();
    G.walked = 0;
    if (window.mapUtils.set3D) window.mapUtils.set3D(true);

    const box = map.getContainer();
    // 지도 조작 잠그기(방향키가 지도를 움직이지 않게), 끝나면 되돌린다
    G.saved = {
      dragPan: map.dragPan.isEnabled(), dragRotate: map.dragRotate.isEnabled(), keyboard: map.keyboard.isEnabled(),
      touchZoomRotate: map.touchZoomRotate.isEnabled(), doubleClickZoom: map.doubleClickZoom.isEnabled(),
      pitch: map.getPitch(), bearing: map.getBearing(), zoom: map.getZoom(), center: map.getCenter(),
      scrollY: window.scrollY,
    };
    map.dragPan.disable(); map.dragRotate.disable(); map.keyboard.disable(); map.doubleClickZoom.disable();
    box.classList.add('is-game');
    if (box.clientHeight < 450 || window.innerWidth < 700) {
      box.classList.add('is-game-full'); // 휴대폰: 화면 가득 크게
      document.documentElement.style.overflow = 'hidden';
    }
    map.resize();
    if (!box.classList.contains('is-game-full')) box.scrollIntoView({ block: 'center', behavior: 'smooth' });

    buildHud(box);
    const av = el('div', '', '<div class="gm-avatar">' + avatarEmoji() + '</div><div class="gm-avatar-shadow"></div>');
    G.avatar = new maplibregl.Marker({ element: av, anchor: 'bottom', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(ll(G.pos)).addTo(map);
    placeBeacon();
    map.jumpTo({ center: ll(G.pos), zoom: GAME_ZOOM, pitch: GAME_PITCH, bearing: G.heading, padding: camPadding() });
    toast('찾아가기 시작! <small>' + esc(targets[0].label) + '부터 가 볼까요?</small>', 1800);

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', clearKeys);
    G.last = performance.now();
    G.raf = requestAnimationFrame(tick);
  }

  function camPadding() {
    const h = G.map.getContainer().clientHeight;
    return { top: Math.round(h * 0.38), bottom: 0, left: 0, right: 0 }; // 캐릭터를 화면 아래쪽에 두고 앞을 넓게
  }

  const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  function onKey(ev) {
    if (!G.on) return;
    if (ev.key === 'Escape' && ev.type === 'keydown') { stop(); return; }
    const k = KEYMAP[ev.code];
    if (!k) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    ev.preventDefault();
    if (ev.type === 'keydown') G.keys.add(k); else G.keys.delete(k);
  }
  function clearKeys() { G.keys.clear(); if (G.pad) G.pad.querySelectorAll('.is-down').forEach((b) => b.classList.remove('is-down')); }

  function tick(now) {
    if (!G.on) return;
    const dt = Math.min(0.2, (now - G.last) / 1000); // 화면이 느려도 같은 속도로 움직이게
    G.last = now;
    const k = G.keys;
    if (k.has('left')) G.heading -= TURN_DEG_S * dt;
    if (k.has('right')) G.heading += TURN_DEG_S * dt;
    G.heading = (G.heading + 360) % 360;
    const move = (k.has('up') ? 1 : 0) - (k.has('down') ? 0.6 : 0);
    if (move) {
      const d = GAME_SPEED_MS * dt * move;
      const next = {
        lat: G.pos.lat + (Math.cos(toRad(G.heading)) * d) / 111320,
        lng: G.pos.lng + (Math.sin(toRad(G.heading)) * d) / (111320 * Math.cos(toRad(G.pos.lat))),
      };
      const center = window.appState && window.appState.userLocation;
      if (!center || haversine(next, G.targets[G.targets.length - 1]) < MAX_FROM_PARK_M * 2 && haversine(next, G.pos) < 50) {
        G.walked += Math.abs(d);
        G.pos = next;
      }
    }
    G.avatar.setLngLat(ll(G.pos));
    G.avatar.getElement().firstChild.classList.toggle('walking', !!move);
    G.map.jumpTo({ center: ll(G.pos), bearing: G.heading, pitch: GAME_PITCH, padding: camPadding() });

    const t = G.targets[G.idx];
    const dist = haversine(G.pos, t);
    const rel = ((bearing(G.pos, t) - G.heading + 540) % 360) - 180;
    updateHud(dist, rel);
    if (dist <= ARRIVE_M) arrive();
    G.raf = requestAnimationFrame(tick);
  }

  function arrive() {
    const t = G.targets[G.idx];
    G.idx++;
    if (G.idx >= G.targets.length) { finish(t); return; }
    toast('✅ 도착! ' + esc(t.label) + '<small>다음: ' + esc(G.targets[G.idx].label) + '</small>', 1900);
    placeBeacon();
  }

  function finish(last) {
    G.on = false;
    cancelAnimationFrame(G.raf);
    clearKeys();
    const plan = window.routePlan;
    const secs = Math.round((performance.now() - G.startedAt) / 1000);
    const real = plan && plan.totalMin ? '실제로 걸으면 직선 기준 도보 약 ' + plan.totalMin + '분 거리예요.' : '';
    const end = el('div', 'gm-end',
      '<div class="gm-end-card" role="dialog" aria-label="찾아가기 완료">' +
        '<h3>🎉 모두 도착했어요!</h3>' +
        '<p>' + G.targets.length + '곳 · 게임 속 ' + secs + '초</p>' +
        (real ? '<p>' + esc(real) + '</p>' : '') +
        '<p style="font-size:12px">직선 안내라 실제 길은 더 멀거나 계단이 있을 수 있어요.</p>' +
        '<div class="row"><button type="button" class="again">다시 하기</button><button type="button" class="primary close">지도로 돌아가기</button></div>' +
      '</div>');
    G.map.getContainer().appendChild(end);
    end.querySelector('.again').addEventListener('click', () => { stop(); setTimeout(start, 50); });
    end.querySelector('.close').addEventListener('click', () => stop());
    end.querySelector('.close').focus();
    G.endEl = end;
  }

  function stop() {
    G.on = false;
    cancelAnimationFrame(G.raf);
    clearKeys();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('blur', clearKeys);
    const map = G.map;
    if (!map) return;
    [G.hud, G.help, G.pad, G.toast, G.endEl].forEach((x) => x && x.remove());
    G.hud = G.help = G.pad = G.toast = G.endEl = null;
    if (G.avatar) G.avatar.remove();
    if (G.beacon) G.beacon.remove();
    G.avatar = G.beacon = null;
    const box = map.getContainer();
    box.classList.remove('is-game', 'is-game-full');
    document.documentElement.style.overflow = '';
    const s = G.saved || {};
    if (s.dragPan) map.dragPan.enable();
    if (s.dragRotate) map.dragRotate.enable();
    if (s.keyboard) map.keyboard.enable();
    if (s.doubleClickZoom) map.doubleClickZoom.enable();
    map.resize();
    map.jumpTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    if (s.center) map.easeTo({ center: s.center, zoom: s.zoom, pitch: s.pitch, bearing: s.bearing, duration: 600 });
    if (typeof s.scrollY === 'number') window.scrollTo(0, s.scrollY);
    if (G.btn) G.btn.focus();
  }

  function alertInMap(text) {
    const box = window.mapUtils.getMap().getContainer();
    const t = el('div', 'gm-toast show', esc(text));
    box.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ───────────────────── 7. 시작 버튼 (지도 오른쪽 위) ─────────────────────
  function StartControl() {}
  StartControl.prototype.onAdd = function () {
    const div = el('div', 'maplibregl-ctrl');
    const b = el('button', 'gm-start', '🎮 찾아가기');
    b.type = 'button';
    b.title = '캐릭터를 직접 움직여 추천 동선대로 찾아가 보기';
    b.addEventListener('click', start);
    div.appendChild(b);
    G.btn = b;
    this._div = div;
    return div;
  };
  StartControl.prototype.onRemove = function () { this._div.remove(); };

  function init() {
    const map = window.mapUtils && window.mapUtils.getMap && window.mapUtils.getMap();
    if (!map || typeof maplibregl === 'undefined') return;
    injectStyle();
    map.addControl(new StartControl(), 'top-right');
    window.gameMode = { start: start, stop: stop, isOn: () => G.on };
  }

  init();
})();
