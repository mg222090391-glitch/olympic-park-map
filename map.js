/* =====================================================================
 * map.js — 팀원1(지도·추천 기능 담당)  ·  3D 버전 (MapLibre GL JS)
 * 올림픽공원 편의시설 지도: 3D 지도, 레이어, 팝업, 기준 위치,
 * 거리·추천 계산, "지금 운영 중" 판단
 *
 * Leaflet 2D → MapLibre GL 3D로 바꿨지만, 팀 약속(프롬프트 4번 계산 규칙, 7번 연결 약속)은 그대로다.
 *  - 읽는 것 : window.appState (ui.js가 만듦), window.conditionInfo (weather.js가 만듦)
 *  - 채우는 것: window.appState.userLocation, window.recommendations
 *  - 듣는 이벤트 : profilechange, filterchange, conditionready, focusplace
 *  - 보내는 이벤트: recommendready, routeready (실패 시 mapdataerror)
 *  - 채우는 것(추가): window.routePlan — 상황별 '들를 곳 순서'(직선거리 기준). 상황을 안 고르면 null
 *  - 마커 : <div class="mk mk-종류"> (종류: toilet, toilet-accessible, facility, heat, cold, charger, elevator, aed, me)
 *      강조 'mk-highlight', 흐림 'mk-dim' (팀원3 style.css 약속). 아이콘 모양은 style.css의 .mk-종류::before가 그린다.
 *      3D 핀 모양을 위해 바깥에 .mk-wrap(기둥·그림자)을 한 겹 더 씌웠다. 이 겉 칸은 팀원3이 꾸밀 필요 없다.
 *  - #map 상태 클래스: 불러오는 중 'is-loading', 실패 'is-error'
 *  - 팝업 HTML (팀원3 style.css 약속):
 *      <div class="pop"> pop-type(종류) / pop-title(이름) / pop-badge is-open|is-closed|is-unknown|is-heat|is-cold
 *                        / pop-row(정보 줄, <b>항목</b> 값) / pop-note(칸 수 정보 없음 같은 주의 문구)
 *  - recommendations 항목에는 약속된 6개 값에 더해 stallsType('total'|'female'|'accessible')을 넣는다.
 *
 * index.html에 필요한 것 (Leaflet 대신):
 *   <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.24.1/dist/maplibre-gl.css">
 *   <script src="https://unpkg.com/maplibre-gl@5.24.1/dist/maplibre-gl.js"></script>  ← map.js보다 먼저
 *
 * 배경 지도: OpenFreeMap(무료·키 없음, OpenStreetMap 데이터, 건물 높이 포함).
 *   불러오지 못하면 OpenStreetMap 2D 타일로 자동 대체한다.
 * 데이터가 아직 없을 때 미리보기: 주소 뒤에 ?demo 를 붙이면 mock_data.js(가상 데이터)를 쓴다.
 * ===================================================================== */
(function () {
  'use strict';

  // ───────────────────── 1. 설정값 ─────────────────────
  const DATA_URL = 'data/olympic_park_data.json';
  const MOCK_URL = 'mock_data.js';             // ?demo 일 때만 불러오는 가상 데이터
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
  const FALLBACK_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const DEFAULT_CENTER = [37.5189, 127.1239]; // [위도, 경도]. JSON의 meta.park_center가 있으면 그 값을 쓴다
  const DEFAULT_ZOOM = 16;
  const FOCUS_ZOOM = 18;
  const PITCH_3D = 58;                         // 3D로 볼 때 기울기(도)
  const BEARING_3D = -28;                      // 3D로 볼 때 방향(도). 북쪽이 0
  const ICON_SIZE = [30, 30];                  // 마커 칸 크기(px). style.css의 .mk::before(30px)와 맞춤
  const OUTSIDE_PARK_M = 300;                  // 가장 가까운 공원 시설에서 이보다 멀면 '공원 밖'으로 본다(가정값)
  const SPEED_NORMAL = 67;                     // 분당 m (가정): 일반·공연 대기
  const SPEED_SLOW = 50;                       // 분당 m (가정): 휠체어·유아차·오래 못 걷는 동행·임산부
  const SLOW_PROFILES = ['wheelchair', 'stroller', 'elderly', 'pregnant'];
  const MAX_RECOMMEND = 3;
  const ELDERLY_NEAR_COUNT = 3;                // 'elderly'일 때 강조할 가까운 화장실 수
  const CONCERT_FACILITY_RE = /자판기|편의점|매점|스낵|카페|식음/; // 공연 대기 때 강조할 편의시설 종류
  const REFRESH_MS = 5 * 60 * 1000;            // "지금 열림" 판단을 5분마다 다시 한다
  const ROUTE_COLOR = '#db2777';               // 추천 동선(들를 곳 순서) 선 색
  const ROUTE_MAX_STOPS = 4;
  const REST_FACILITY_RE = /휴게|쉼터|벤치|그늘|쉼터/;  // 편의시설 중 '쉴 곳'으로 볼 종류
  const NURSING_FACILITY_RE = /수유/;
  // 상황별로 들를 곳 (순서는 아래에서 '직선거리 합이 가장 짧은 순서'로 정한다)
  const ROUTE_NEEDS = {
    wheelchair: ['toilet', 'charger', 'elevator'],
    stroller: ['toilet', 'nursing', 'elevator'],
    pregnant: ['toilet', 'rest'],
    elderly: ['rest', 'toilet'],
    concert: ['toilet', 'shop'],
  };
  const WALK_RING_MIN = 5;                     // 기준 위치 둘레에 그릴 '도보 N분' 원
  const KOREAN_FONTS = "'Pretendard', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif";

  // 종류별 색(팀원3 style.css의 --mk-종류 변수가 있으면 그 색을 쓰고, 없을 때만 아래 색) · 팝업 머리 기호
  const KIND_STYLE = {
    'toilet':            { color: '#1d4ed8', emoji: '🚻' },
    'toilet-accessible': { color: '#0f766e', emoji: '🚻' },
    'facility':          { color: '#475569', emoji: '🏪' },
    'heat':              { color: '#c2410c', emoji: '☀️' },
    'cold':              { color: '#0369a1', emoji: '❄️' },
    'charger':           { color: '#15803d', emoji: '🔌' },
    'elevator':          { color: '#6d28d9', emoji: '🛗' },
    'aed':               { color: '#b91c1c', emoji: '❤️' },
    'me':                { color: '#2563eb', emoji: '📍' },
  };
  const kindColor = (kind) => 'var(--mk-' + kind + ', ' + (KIND_STYLE[kind] || KIND_STYLE.facility).color + ')';

  const DAY_CHARS = '일월화수목금토';            // Date.getDay(): 0=일 ~ 6=토

  // ───────────────────── 2. 작은 도구 함수 ─────────────────────
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // true / 'Y' / '있음' 등을 '예'로 본다. null·undefined는 null(정보 없음)
  function yesNo(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v === true || v === false) return v;
    const s = String(v).trim().toLowerCase();
    if (['y', 'yes', 'true', '있음', 'o', '1', '운영'].includes(s)) return true;
    if (['n', 'no', 'false', '없음', 'x', '0', '미운영'].includes(s)) return false;
    return null;
  }

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  // ───────────────────── 3. 계산 규칙 (팀 공통 약속 4번) ─────────────────────
  // 하버사인 공식: 두 지점의 직선거리(m)
  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // 프로필을 여러 개 고르면 가장 느린 속도를 쓴다
  function walkSpeed(profiles) {
    return (profiles || []).some((p) => SLOW_PROFILES.includes(p)) ? SPEED_SLOW : SPEED_NORMAL;
  }

  function walkMinutes(meters, profiles) {
    return meters / walkSpeed(profiles);
  }

  // 점수에 쓸 칸 수
  //  - 휠체어: accessible_stalls
  //  - 여성 칸 기준 필터(femaleStalls)가 켜지면: female_stalls
  //  - 그 밖(일반·공연 대기 등): total
  //  - 여러 개를 고르면 위 순서(휠체어 > 여성 칸 기준 > 전체)가 먼저다. 예: 휠체어+공연 대기 → 장애인 칸
  function stallsType(profiles, filters) {
    if (profiles.includes('wheelchair')) return 'accessible';
    if (filters.femaleStalls) return 'female';
    return 'total';
  }

  function stallsFor(toilet, profiles, filters) {
    const type = stallsType(profiles, filters);
    if (type === 'accessible') return num(toilet.accessible_stalls);
    if (type === 'female') return num(toilet.female_stalls);
    return num(toilet.total);
  }

  // 화장실 추천: 점수 = 칸 수 ÷ (도보 시간(분) + 1), 상위 3곳
  function computeRecommendations(toilets, origin, profiles, filters, now) {
    profiles = profiles || [];
    filters = filters || {};
    now = now || new Date();
    const list = [];
    (toilets || []).forEach((t) => {
      if (num(t.total) === null) return;                                   // 칸 수 정보 없는 화장실 제외
      if (profiles.includes('stroller') && yesNo(t.diaper_table) !== true) return; // 유아차: 기저귀 교환대 있는 곳만
      if (filters.diaper && yesNo(t.diaper_table) !== true) return;
      if (filters.bell && yesNo(t.emergency_bell) !== true) return;
      if (filters.openNow && toiletOpenNow(t, now) !== true) return;       // 열림이 확실한 곳만
      const stalls = stallsFor(t, profiles, filters);
      if (!stalls || stalls <= 0) return;                                  // 휠체어 칸 0이면 제외 등
      const meters = haversine(origin.lat, origin.lng, t.lat, t.lng);
      const minutes = walkMinutes(meters, profiles);
      list.push({
        name: t.name,
        rawScore: stalls / (minutes + 1),
        walkMin: Math.max(1, Math.round(minutes)),
        stalls: stalls,
        lat: t.lat,
        lng: t.lng,
      });
    });
    list.sort((a, b) => b.rawScore - a.rawScore);
    const type = stallsType(profiles, filters);
    return list.slice(0, MAX_RECOMMEND).map((r) => ({
      name: r.name, score: round2(r.rawScore), walkMin: r.walkMin, stalls: r.stalls, lat: r.lat, lng: r.lng,
      stallsType: type, // 'total'(칸) | 'female'(여성 칸) | 'accessible'(장애인 칸) — 목록 표시용
    }));
  }

  // ───────────────────── 4. "지금 열림 / 운영 중" 판단 ─────────────────────
  // 결과는 true(열림) / false(닫힘) / null(정보가 없거나 읽을 수 없음) 셋 중 하나

  // 운영시간 값을 글자로 바꾼다(배열·객체로 들어와도 처리)
  function hoursToText(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.join('~');
    if (typeof v === 'object') {
      const s = v.start || v.open || v.from || '';
      const e = v.end || v.close || v.to || '';
      return s || e ? s + '~' + e : '';
    }
    return String(v);
  }

  // "09:00~18:00", "0900-1800", "9시~18시", "06:00~22:00, 23:00~24:00" → [{start, end}] (분 단위)
  function parseTimeRanges(value) {
    let s = hoursToText(value);
    if (!s.trim()) return [];
    // 콜론 없는 4자리 시각(0900)을 09:00으로 바꾼다
    s = s.replace(/\b(\d{2})(\d{2})\b/g, (all, h, m) =>
      Number(h) <= 24 && Number(m) < 60 ? h + ':' + m : all);
    const re = /(\d{1,2})\s*(?::\s*(\d{2})|시\s*(?:(\d{1,2})\s*분)?)/g;
    const times = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      const h = Number(m[1]);
      const min = Number(m[2] || m[3] || 0);
      if (h <= 24 && min < 60) times.push(h * 60 + min);
    }
    const ranges = [];
    for (let i = 0; i + 1 < times.length; i += 2) ranges.push({ start: times[i], end: times[i + 1] });
    return ranges;
  }

  function isNowInRanges(ranges, now) {
    const cur = now.getHours() * 60 + now.getMinutes();
    return ranges.some((r) => {
      if (r.start === r.end) return true;                       // 00:00~00:00 등은 24시간으로 본다(가정)
      if (r.start < r.end) return cur >= r.start && cur < r.end;
      return cur >= r.start || cur < r.end;                     // 자정을 넘는 경우(22:00~02:00)
    });
  }

  const ALWAYS_OPEN_RE = /상시|24\s*시간|연중\s*무휴|항시|365\s*일/;
  const CLOSED_RE = /폐쇄|휴관|미개방|운영\s*중지|사용\s*불가|공사/;

  function openStatusFromText(value, now) {
    const s = hoursToText(value).trim();
    if (!s) return null;
    if (CLOSED_RE.test(s)) return false;
    if (ALWAYS_OPEN_RE.test(s)) return true;
    const ranges = parseTimeRanges(s);
    if (ranges.length === 0) return null;
    return isNowInRanges(ranges, now);
  }

  // 화장실: 개방시간상세(open_detail)를 먼저 보고, 없으면 개방시간(open)을 본다
  function toiletOpenNow(t, now) {
    now = now || new Date();
    const d = openStatusFromText(t.open_detail, now);
    if (d !== null) return d;
    return openStatusFromText(t.open, now);
  }

  // "월~금", "월,수,금", "평일", "주말", "매일", "토·일요일" → [요일 번호]
  function parseDays(value) {
    if (value === null || value === undefined) return null;
    let s = String(value);
    if (!s.trim()) return null;
    const set = new Set();
    if (/매일|연중|전체|상시|무휴/.test(s)) [0, 1, 2, 3, 4, 5, 6].forEach((d) => set.add(d));
    if (/평일/.test(s)) [1, 2, 3, 4, 5].forEach((d) => set.add(d));
    if (/주말/.test(s)) [0, 6].forEach((d) => set.add(d));
    // '평일'의 '일'처럼 요일로 오해할 낱말을 먼저 지운다
    s = s.replace(/평일|매일|공휴일|휴일|주말|연중\s*무휴|무휴|요일/g, ' ');
    // 범위: 월~금, 화-일
    s = s.replace(/([일월화수목금토])\s*[~\-–]\s*([일월화수목금토])/g, (all, a, b) => {
      let k = DAY_CHARS.indexOf(a);
      const end = DAY_CHARS.indexOf(b);
      for (let guard = 0; guard < 7; guard++) {
        set.add(k);
        if (k === end) break;
        k = (k + 1) % 7;
      }
      return ' ';
    });
    // 낱개: 월, 수, 금
    for (const ch of s) {
      const idx = DAY_CHARS.indexOf(ch);
      if (idx >= 0) set.add(idx);
    }
    return set.size ? Array.from(set).sort() : null;
  }

  // 무더위쉼터: 운영 요일(days) + 운영 시간(hours). 공휴일 달력은 반영하지 않는다
  function heatShelterOpenNow(s, now) {
    now = now || new Date();
    const days = parseDays(s.days);
    const ranges = parseTimeRanges(s.hours);
    if (!days || ranges.length === 0) return null;
    const base = days.includes(now.getDay()) && isNowInRanges(ranges, now);
    if (!base && yesNo(s.weekend_extra) === true) return null; // 추가 운영이 있다고 돼 있으면 '확인 필요'
    return base;
  }

  // 한파쉼터: 데이터에 운영 요일·시간이 없어 판단할 수 없다
  function coldShelterOpenNow() {
    return null;
  }

  // 전동휠체어 충전기: 평일은 weekday, 토·일은 holiday 시간(공휴일 달력은 반영하지 않음)
  function isHolidayLike(now) {
    const d = now.getDay();
    return d === 0 || d === 6;
  }

  function chargerOpenNow(c, now) {
    now = now || new Date();
    return openStatusFromText(isHolidayLike(now) ? c.holiday : c.weekday, now);
  }

  // ───────────────────── 5. 공유 상태 ─────────────────────
  function ensureAppState() {
    // ui.js가 아직 없을 때도 테스트할 수 있게, 없으면 7번 형식대로 만든다
    if (!window.appState) {
      window.appState = {
        profiles: [],
        filters: { diaper: false, bell: false, openNow: false, femaleStalls: false },
        userLocation: null,
      };
    }
    const st = window.appState;
    if (!Array.isArray(st.profiles)) st.profiles = [];
    st.filters = Object.assign({ diaper: false, bell: false, openNow: false, femaleStalls: false }, st.filters || {});
    return st;
  }

  const S = {
    map: null,
    data: null,
    layers: {},          // key → { label, kind, visible, entries: [], input }
    entries: [],         // 모든 마커 정보 { marker, el, pin, kind, cat, item, layerKey, iconState, title }
    meMarker: null,
    origin: null,
    originLabel: '',
    prevProfiles: [],
    noticeEl: null,
    tempNoticeTimer: null,
    popup: null,
    popupEntry: null,
    is3D: true,
    orbiting: false,
    extrusionLayers: [],
    overlayReady: false,
    compact: false,      // 지도가 좁을 때(휴대폰) true: 안내 접기, 팝업 높이 제한
  };

  const ll = (lat, lng) => [lng, lat]; // MapLibre는 [경도, 위도] 순서다(Leaflet과 반대!)
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ───────────────────── 6. 기본 모양 (CSS) ─────────────────────
  // :where()로 감싸 우선순위를 0으로 만들었다 → 팀원3의 style.css가 같은 클래스를 꾸미면 그쪽이 이긴다.
  function injectBaseStyle() {
    if (document.getElementById('map3d-base-style')) return;
    const kindVars = Object.keys(KIND_STYLE)
      .map((k) => ':where(.mk-wrap[data-kind="' + k + '"]){--mk-c:' + kindColor(k) + '}')
      .join('\n');
    const css = `
:where(#map){position:relative;min-height:320px;background:#e8edf1;overflow:hidden}
:where(#map.is-loading)::before{content:'3D 지도를 불러오는 중…';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:5;
  padding:10px 16px;border-radius:999px;background:rgba(255,255,255,.92);font:600 14px/1.4 system-ui,sans-serif;color:#334155;box-shadow:0 4px 16px rgba(15,23,42,.15)}
:where(#map.is-error) .map3d-fail{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;font:500 14px/1.6 system-ui,sans-serif;color:#7f1d1d;background:#fef2f2}
${kindVars}
/* 3D 핀: 겉 칸(.mk-wrap) = 아이콘(.mk) + 기둥 + 바닥 그림자. 아이콘 모양은 팀원3 style.css의 .mk-종류::before */
:where(.mk-wrap){display:flex;flex-direction:column;align-items:center;cursor:pointer;-webkit-tap-highlight-color:transparent}
:where(.mk){position:relative;display:block;flex:none;transition:transform .2s}
:where(.mk)::before{content:'';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:26px;height:26px;border-radius:50%;
  background:var(--mk-c);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45)}   /* style.css가 없을 때만 보이는 대체 모양 */
:where(.mk.mk-highlight)::before{transform:translate(-50%,-50%) scale(1.35);box-shadow:0 0 0 4px #ffbf47,0 2px 8px rgba(0,0,0,.5)}
:where(.mk.mk-dim)::before{opacity:.35;filter:grayscale(1)}
:where(.mk-stem){width:2px;height:12px;margin-top:2px;border-radius:1px;background:linear-gradient(var(--mk-c),rgba(15,23,42,.35))}
:where(.mk-shadow){width:14px;height:5px;margin-top:-1px;border-radius:50%;background:radial-gradient(rgba(15,23,42,.45),rgba(15,23,42,0) 70%)}
:where(.mk-wrap:hover .mk){transform:translateY(-3px)}
:where(.mk-wrap.mk-wrap-hi){z-index:2;animation:mk-bob 1.8s ease-in-out infinite}
:where(.mk-wrap.mk-wrap-dim) .mk-stem, :where(.mk-wrap.mk-wrap-dim) .mk-shadow{opacity:.3}
:where(.mk-rank){position:absolute;z-index:1;top:-10px;right:-12px;min-width:18px;height:18px;padding:0 3px;box-sizing:border-box;border-radius:9px;background:#1a1d21;color:#fff;
  font:800 11px/15px system-ui,sans-serif;text-align:center;border:1.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)}
:where(.mk-rank:empty){display:none}
:where(.mk-step){position:absolute;z-index:1;top:-10px;left:-12px;min-width:18px;height:18px;padding:0 3px;box-sizing:border-box;border-radius:9px;background:${ROUTE_COLOR};color:#fff;
  font:800 11px/15px system-ui,sans-serif;text-align:center;border:1.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)}
:where(.mk-step:empty){display:none}
:where(.mk-wrap.is-step){z-index:3}
:where(.mk-wrap.is-ranked){z-index:3}
:where(.mk-wrap-me){z-index:4}
:where(.mk.mk-me)::after{content:'';position:absolute;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
  border:2px solid rgba(37,99,235,.7);animation:mk-pulse 2s ease-out infinite;pointer-events:none}
@keyframes mk-bob{0%,100%{translate:0 0}50%{translate:0 -4px}}
@keyframes mk-pulse{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.7);opacity:0}}
@media (prefers-reduced-motion:reduce){:where(.mk-wrap.mk-wrap-hi){animation:none}:where(.mk.mk-me)::after{animation:none;opacity:.5}}

/* 팝업 틀(내용 .pop-* 모양은 팀원3 style.css가 정한다). 팝업이 레이어 패널·안내 문구 위로 오게 */
.maplibregl-popup{z-index:5}
:where(.maplibregl-popup-content){padding:14px 16px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:.9375rem;line-height:1.5}
:where(.maplibregl-popup-close-button){width:36px;height:36px;font-size:24px;line-height:34px;border-radius:0 12px 0 8px}

:where(.map-notice){display:flex;flex-direction:column;align-items:flex-start;gap:6px;max-width:min(320px,70vw)}
:where(.map-notice-list){display:flex;flex-direction:column;gap:6px}
:where(.map-notice.is-compact:not(.is-open)) .map-notice-list{display:none}
:where(.map-notice-toggle){display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 14px;border:0;border-radius:999px;
  background:rgba(255,255,255,.97);box-shadow:0 2px 10px rgba(15,23,42,.22);font:700 13px/1 system-ui,sans-serif;color:#1a1d21;cursor:pointer}
:where(.map-notice-toggle.has-warn){box-shadow:inset 0 0 0 2px #f59e0b,0 2px 10px rgba(15,23,42,.22)}
:where(.map-notice-toggle[hidden]){display:none}
:where(.maplibregl-popup-content .pop){max-height:var(--op-popup-max,none);overflow:auto;overscroll-behavior:contain}
:where(.map-notice-item){background:rgba(255,255,255,.95);padding:8px 11px;border-radius:10px;box-shadow:0 4px 14px rgba(15,23,42,.18);
  font:500 12.5px/1.5 system-ui,sans-serif;color:#0f172a;border-left:4px solid #2563eb}
:where(.map-notice-warn){border-left-color:#f59e0b}
:where(.map-notice-demo){border-left-color:#a855f7}

:where(.op-panel){background:rgba(255,255,255,.96);border-radius:12px;box-shadow:0 4px 18px rgba(15,23,42,.18);font:13px/1.4 system-ui,sans-serif;color:#0f172a;
  max-width:min(250px,64vw);overflow:hidden}
:where(.op-panel > button){display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;padding:9px 12px;font:700 13px system-ui,sans-serif;color:inherit;cursor:pointer}
:where(.op-panel > button)::after{content:'▾';margin-left:auto;transition:transform .2s}
:where(.op-panel.is-collapsed > button)::after{transform:rotate(-90deg)}
:where(.op-panel.is-collapsed .op-body){display:none}
:where(.op-body){padding:0 8px 8px;max-height:52vh;overflow:auto}
:where(.op-body label){display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:8px;cursor:pointer}
:where(.op-body label:hover){background:#f1f5f9}
:where(.op-dot){width:12px;height:12px;border-radius:50%;flex:none;box-shadow:inset 0 -2px 0 rgba(0,0,0,.18)}
:where(.op-count){margin-left:auto;color:#94a3b8;font-size:11.5px}
:where(.op-legend){border-top:1px solid #e2e8f0;margin-top:6px;padding:7px 6px 0;font-size:11.5px;color:#64748b;line-height:1.55}
:where(.op-legend i){display:inline-block;width:16px;height:0;border-top:2px dashed #2563eb;vertical-align:middle;margin-right:4px}
:where(.op-legend i.ring){border-top-color:#0ea5e9}
:where(.op-legend i.route){border-top:3px dashed ${ROUTE_COLOR}}
:where(.op-view button){font:800 12px system-ui,sans-serif;color:#0f172a}
:where(.op-view button.is-on){background:#e0e7ff;color:#3730a3}
`;
    const st = document.createElement('style');
    st.id = 'map3d-base-style';
    st.textContent = css;
    document.head.insertBefore(st, document.head.firstChild); // 맨 앞에 넣어 팀 CSS가 뒤에서 덮어쓰게
  }

  // ───────────────────── 7. 마커 ─────────────────────
  // 팀 약속 클래스(mk mk-종류 + 상태)를 가진 핀 하나를 만든다
  function makePinElement(kind, title) {
    const wrap = document.createElement('div');
    wrap.className = 'mk-wrap' + (kind === 'me' ? ' mk-wrap-me' : '');
    wrap.dataset.kind = kind;
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('aria-label', title || kind);
    wrap.title = title || '';
    const pin = document.createElement('div');
    pin.className = 'mk mk-' + kind;
    pin.style.width = ICON_SIZE[0] + 'px';
    pin.style.height = ICON_SIZE[1] + 'px';
    pin.setAttribute('aria-hidden', 'true');
    pin.innerHTML = '<span class="mk-rank"></span><span class="mk-step"></span>';
    wrap.appendChild(pin);
    wrap.insertAdjacentHTML('beforeend', '<span class="mk-stem"></span><span class="mk-shadow"></span>');
    return { wrap: wrap, pin: pin };
  }

  function setPinState(entry, state) {
    entry.pin.className = 'mk mk-' + entry.kind + (state ? ' ' + state : '');
    entry.el.classList.toggle('mk-wrap-hi', state === 'mk-highlight');
    entry.el.classList.toggle('mk-wrap-dim', state === 'mk-dim');
  }

  function onActivate(el, fn) {
    el.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fn(); }
    });
  }

  function validPoint(item) {
    return item && Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng));
  }

  function addLayer(key, label, kind, visible) {
    S.layers[key] = { label: label, kind: kind, visible: !!visible, entries: [], input: null };
    return S.layers[key];
  }

  function addEntry(layerKey, cat, kind, item, title) {
    if (!validPoint(item)) return null;
    item.lat = Number(item.lat);
    item.lng = Number(item.lng);
    const p = makePinElement(kind, title);
    const entry = { cat: cat, kind: kind, item: item, layerKey: layerKey, iconState: '', title: title || '', el: p.wrap, pin: p.pin };
    entry.marker = new maplibregl.Marker({ element: p.wrap, anchor: 'bottom', pitchAlignment: 'viewport', rotationAlignment: 'viewport' })
      .setLngLat(ll(item.lat, item.lng))
      .addTo(S.map);
    onActivate(p.wrap, () => openEntryPopup(entry));
    const layer = S.layers[layerKey];
    layer.entries.push(entry);
    if (!layer.visible) p.wrap.style.display = 'none';
    S.entries.push(entry);
    return entry;
  }

  function buildLayers(data) {
    let skipped = 0;
    const count = (e) => { if (!e) skipped++; };

    addLayer('toilets', '화장실', 'toilet', true);
    (data.toilets || []).forEach((t) => {
      const kind = num(t.accessible_stalls) > 0 ? 'toilet-accessible' : 'toilet';
      count(addEntry('toilets', 'toilet', kind, t, t.name));
    });

    // 편의시설은 type(구분)별로 레이어를 나눈다
    const types = {};
    (data.facilities || []).forEach((f) => {
      const type = f.type || '기타';
      if (!types[type]) types[type] = [];
      types[type].push(f);
    });
    Object.keys(types).sort().forEach((type, i) => {
      const key = 'facility:' + i;
      addLayer(key, '편의시설 · ' + type, 'facility', true);
      types[type].forEach((f) => count(addEntry(key, 'facility', 'facility', f, type + ' ' + (f.place || ''))));
    });

    addLayer('heat', '무더위쉼터', 'heat', false);
    (data.heat_shelters || []).forEach((s) => count(addEntry('heat', 'heat', 'heat', s, s.name)));

    addLayer('cold', '한파쉼터', 'cold', false);
    (data.cold_shelters || []).forEach((s) => count(addEntry('cold', 'cold', 'cold', s, s.name)));

    addLayer('charger', '전동휠체어 충전기', 'charger', true);
    (data.wheelchair_chargers || []).forEach((c) => count(addEntry('charger', 'charger', 'charger', c, c.name)));

    addLayer('elevator', '지하철 엘리베이터', 'elevator', true);
    (data.subway_elevators || []).forEach((e) => count(addEntry('elevator', 'elevator', 'elevator', e, (e.station || '') + ' 엘리베이터')));

    addLayer('aed', 'AED(자동심장충격기)', 'aed', false);
    (data.aed || []).forEach((a) => count(addEntry('aed', 'aed', 'aed', a, 'AED ' + (a.name || ''))));

    if (skipped) console.warn('[map.js] 좌표가 없거나 잘못된 항목 ' + skipped + '개는 지도에서 뺐어요.');

    S.map.addControl(new LayerControl(), 'top-left');
  }

  function setLayerVisible(key, visible) {
    const layer = S.layers[key];
    if (!layer) return;
    layer.visible = !!visible;
    layer.entries.forEach((e) => { e.el.style.display = visible ? '' : 'none'; });
    if (layer.input) layer.input.checked = !!visible;
    if (!visible && S.popupEntry && S.popupEntry.layerKey === key) S.popup.remove();
  }

  function showLayer(key) {
    const layer = S.layers[key];
    if (layer && !layer.visible) setLayerVisible(key, true);
  }

  // ───────────────────── 8. 지도 위 조작 패널 ─────────────────────
  // (1) 레이어 켜고 끄기 — Leaflet의 L.control.layers를 대신한다
  function LayerControl() {}
  LayerControl.prototype.onAdd = function () {
    const div = document.createElement('div');
    // 지도 폭이 넉넉할 때만 펼친 채로 시작(좁으면 팝업·핀을 가리므로 접어 둔다)
    div.className = 'maplibregl-ctrl op-panel' + (S.map.getContainer().clientWidth < 900 ? ' is-collapsed' : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5z" fill="#2563eb"/><path d="m3 12.5 9 5 9-5M3 16.5l9 5 9-5" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round"/></svg>시설 레이어';
    btn.setAttribute('aria-expanded', String(!div.classList.contains('is-collapsed')));
    btn.addEventListener('click', () => {
      div.classList.toggle('is-collapsed');
      btn.setAttribute('aria-expanded', String(!div.classList.contains('is-collapsed')));
    });
    const body = document.createElement('div');
    body.className = 'op-body';
    Object.keys(S.layers).forEach((key) => {
      const layer = S.layers[key];
      const lab = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = layer.visible;
      input.addEventListener('change', () => setLayerVisible(key, input.checked));
      layer.input = input;
      const dot = document.createElement('span');
      dot.className = 'op-dot';
      dot.style.background = kindColor(layer.kind);
      const name = document.createElement('span');
      name.textContent = layer.label;
      const cnt = document.createElement('span');
      cnt.className = 'op-count';
      cnt.textContent = layer.entries.length;
      lab.append(input, dot, name, cnt);
      body.appendChild(lab);
    });
    const legend = document.createElement('div');
    legend.className = 'op-legend';
    legend.innerHTML = '<div><i class="route"></i>추천 동선: 들를 곳 순서(상황을 고르면 보여요)</div><div><i></i>추천 화장실까지 연결</div>' +
      '<div><i class="ring"></i>기준 위치에서 도보 ' + WALK_RING_MIN + '분 범위(가정 속도)</div>' +
      '<div><b>선은 모두 직선이에요. 실제 길은 더 멀거나 계단이 있을 수 있어요.</b></div>' +
      '<div>지도를 누르거나 ● 기준 핀을 끌어 기준 위치를 바꿀 수 있어요.</div>';
    body.appendChild(legend);
    div.append(btn, body);
    this._div = div;
    return div;
  };
  LayerControl.prototype.onRemove = function () { this._div.remove(); };

  // (2) 3D/2D 전환 · 공원 전체 보기 · 둘러보기(천천히 회전)
  function ViewControl() {}
  ViewControl.prototype.onAdd = function () {
    const div = document.createElement('div');
    div.className = 'maplibregl-ctrl maplibregl-ctrl-group op-view';
    const mk = (text, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      div.appendChild(b);
      return b;
    };
    this.dim = mk('2D', '2D 평면으로 보기', () => set3D(!S.is3D));
    mk('⌂', '공원 전체 보기', () => resetView());
    this.orbit = mk('⟳', '천천히 돌며 둘러보기', () => (S.orbiting ? stopOrbit() : startOrbit()));
    S.viewCtl = this;
    this._div = div;
    return div;
  };
  ViewControl.prototype.onRemove = function () { this._div.remove(); };

  function updateViewButtons() {
    if (!S.viewCtl) return;
    S.viewCtl.dim.textContent = S.is3D ? '2D' : '3D';
    S.viewCtl.dim.title = S.is3D ? '2D 평면으로 보기' : '3D 입체로 보기';
    S.viewCtl.dim.setAttribute('aria-label', S.viewCtl.dim.title);
    S.viewCtl.orbit.classList.toggle('is-on', S.orbiting);
  }

  function set3D(on) {
    S.is3D = !!on;
    S.extrusionLayers.forEach((id) => {
      if (S.map.getLayer(id)) S.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
    if (!on) stopOrbit();
    S.map.easeTo({ pitch: on ? PITCH_3D : 0, bearing: on ? BEARING_3D : 0, duration: reducedMotion() ? 0 : 900 });
    updateViewButtons();
  }

  function resetView() {
    const c = parkCenter();
    S.map.flyTo({
      center: ll(c.lat, c.lng), zoom: DEFAULT_ZOOM, pitch: S.is3D ? PITCH_3D : 0, bearing: S.is3D ? BEARING_3D : 0,
      duration: reducedMotion() ? 0 : 1600, essential: false,
    });
  }

  function startOrbit() {
    if (S.orbiting) return;
    if (!S.is3D) set3D(true);
    S.orbiting = true;
    updateViewButtons();
    let last = performance.now();
    const step = (t) => {
      if (!S.orbiting) return;
      const dt = Math.min(64, t - last);
      last = t;
      S.map.setBearing(S.map.getBearing() + dt * 0.006); // 약 6도/초
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function stopOrbit() {
    if (!S.orbiting) return;
    S.orbiting = false;
    updateViewButtons();
  }

  // (3) 안내 문구 — 왼쪽 아래. 휴대폰처럼 지도가 좁으면 'ⓘ 안내 N' 버튼 하나로 접어 둔다.
  function NoticeControl() {}
  NoticeControl.prototype.onAdd = function () {
    const div = document.createElement('div');
    div.className = 'maplibregl-ctrl map-notice';
    const list = document.createElement('div');
    list.className = 'map-notice-list';
    list.setAttribute('role', 'status');
    list.setAttribute('aria-live', 'polite');
    list.innerHTML = '<div class="map-notice-demo"></div><div class="map-notice-temp"></div><div class="map-notice-shelter"></div>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'map-notice-toggle';
    btn.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => setNoticeOpen(!div.classList.contains('is-open')));
    div.append(list, btn);
    this._div = div;
    return div;
  };
  NoticeControl.prototype.onRemove = function () { this._div.remove(); };

  function buildNotice() {
    const ctl = new NoticeControl();
    S.map.addControl(ctl, 'bottom-left');
    S.noticeEl = ctl._div;
  }

  function setNoticeOpen(open) {
    if (!S.noticeEl) return;
    S.noticeEl.classList.toggle('is-open', !!open);
    S.noticeEl.querySelector('.map-notice-toggle').setAttribute('aria-expanded', String(!!open));
    updateNoticeToggle();
  }

  // 접힌 버튼에 안내 개수를 적고, 주의 안내가 있으면 주황 테두리를 단다
  function updateNoticeToggle() {
    if (!S.noticeEl) return;
    const items = S.noticeEl.querySelectorAll('.map-notice-list .map-notice-item');
    const warn = S.noticeEl.querySelector('.map-notice-list .map-notice-warn');
    const btn = S.noticeEl.querySelector('.map-notice-toggle');
    const open = S.noticeEl.classList.contains('is-open');
    if (!items.length && open) S.noticeEl.classList.remove('is-open');
    btn.hidden = !S.compact || !items.length;
    btn.classList.toggle('has-warn', !!warn);
    btn.textContent = S.noticeEl.classList.contains('is-open') ? '안내 접기 ▾' : 'ⓘ 안내 ' + items.length;
  }

  // 지도 크기에 따라 휴대폰용(좁은) 모양으로 바꾼다. 지도 크기가 바뀔 때마다 다시 부른다.
  function applyCompact() {
    const box = S.map.getContainer();
    const w = box.clientWidth;
    const h = box.clientHeight;
    S.compact = w < 600 || h < 420;
    if (S.noticeEl) S.noticeEl.classList.toggle('is-compact', S.compact);
    // 팝업이 지도 높이를 넘지 않게(핀 높이·여백을 뺀 만큼): 넘치는 내용은 팝업 안에서 스크롤
    box.style.setProperty('--op-popup-max', Math.max(120, h - PIN_H - 70) + 'px');
    updateNoticeToggle();
  }

  // 핀을 화면 가운데보다 아래에 두는 비율(위로 팝업이 펼쳐질 자리)
  function focusOffsetRatio() { return S.compact ? 0.3 : 0.22; }
  function focusOffset() { return [0, Math.round(S.map.getContainer().clientHeight * focusOffsetRatio())]; }

  function setNotice(slot, text, level) {
    if (!S.noticeEl) return;
    const el = S.noticeEl.querySelector('.map-notice-' + slot);
    el.className = 'map-notice-' + slot + (text ? ' map-notice-item map-notice-' + (level || 'info') : '');
    el.textContent = text || '';
    updateNoticeToggle();
  }

  function tempNotice(text, level) {
    setNotice('temp', text, level);
    clearTimeout(S.tempNoticeTimer);
    S.tempNoticeTimer = setTimeout(() => setNotice('temp', ''), 7000);
  }

  // ───────────────────── 9. 팝업 내용 ─────────────────────
  // 팝업 HTML 구조 (팀원3 style.css 약속)
  //  <div class="pop pop-종류">
  //    <p class="pop-type">🚻 화장실</p>
  //    <h3 class="pop-title">이름</h3>
  //    <span class="pop-badge is-open">지금 열림</span>   (is-open | is-closed | is-unknown | is-heat | is-cold)
  //    <p class="pop-row"><b>칸 수</b> 여성 11칸 · 남성 변기 8개 · 장애인 2칸</p>
  //    <p class="pop-note">칸 수 정보 없음</p>
  //  </div>
  function headHtml(kind, type, name) {
    const emoji = (KIND_STYLE[kind] || KIND_STYLE.facility).emoji;
    return '<p class="pop-type">' + emoji + ' ' + esc(type) + '</p><h3 class="pop-title">' + esc(name || type) + '</h3>';
  }

  function badgeHtml(cls, text) {
    return '<span class="pop-badge ' + cls + '">' + esc(text) + '</span>';
  }

  function stateHtml(status, openText, closedText, unknownText) {
    const cls = status === true ? 'is-open' : status === false ? 'is-closed' : 'is-unknown';
    const txt = status === true ? openText : status === false ? closedText : unknownText;
    return badgeHtml(cls, txt);
  }

  // [항목, 값] 여러 개 → 값이 있는 것만 <p class="pop-row"><b>항목</b> 값</p>
  function rowsHtml(pairs) {
    return pairs
      .filter((p) => p[1] !== null && p[1] !== undefined && String(p[1]).trim() !== '')
      .map((p) => '<p class="pop-row"><b>' + esc(p[0]) + '</b> ' + esc(p[1]) + '</p>')
      .join('');
  }

  function noteHtml(text) {
    return text ? '<p class="pop-note">' + esc(text) + '</p>' : '';
  }

  // 있음/없음 설비 → "기저귀 교환대 있음 · 비상벨 없음" (정보가 없는 항목은 뺀다)
  function equipText(pairs) {
    return pairs
      .map(([label, v]) => [label, yesNo(v)])
      .filter(([, b]) => b !== null)
      .map(([label, b]) => label + (b ? ' 있음' : ' 없음'))
      .join(' · ');
  }

  function stallsText(it) {
    return [['여성', it.female_stalls, '칸'], ['남성 변기', it.male_fixtures, '개'], ['장애인', it.accessible_stalls, '칸']]
      .filter(([, v]) => num(v) !== null)
      .map(([label, v, unit]) => label + ' ' + num(v) + unit)
      .join(' · ');
  }

  function distanceText(item) {
    if (!S.origin) return null;
    const st = ensureAppState();
    const m = haversine(S.origin.lat, S.origin.lng, item.lat, item.lng);
    const min = Math.max(1, Math.round(walkMinutes(m, st.profiles)));
    return '직선 약 ' + Math.round(m).toLocaleString() + 'm · 도보 약 ' + min + '분 (분당 ' + walkSpeed(st.profiles) + 'm 가정)';
  }

  function parkDist(item) {
    const d = num(item.dist_from_park_m);
    return d === null ? null : '약 ' + Math.round(d).toLocaleString() + 'm';
  }

  // 날씨 때문에 쉼터를 찾아야 하는 날, 지금 운영 중인 쉼터에는 is-heat / is-cold 배지를 하나 더 단다
  function weatherBadge(cat, status) {
    const ci = window.conditionInfo || {};
    if (status !== true) return '';
    if (cat === 'heat' && ci.needHeatShelter) return badgeHtml('is-heat', '오늘 더위 쉼터로 추천');
    if (cat === 'cold' && ci.needColdShelter) return badgeHtml('is-cold', '오늘 추위 쉼터로 추천');
    return '';
  }

  function popupHtml(entry) {
    const it = entry.item;
    const now = new Date();
    let h = '';
    let st;
    switch (entry.cat) {
      case 'toilet':
        h += headHtml(entry.kind, entry.kind === 'toilet-accessible' ? '화장실 · 장애인 칸 있음' : '화장실', it.name);
        h += stateHtml(toiletOpenNow(it, now), '지금 열림', '지금 닫힘', '개방시간 확인 필요');
        h += num(it.total) === null ? '' : rowsHtml([['칸 수', stallsText(it)]]);
        h += rowsHtml([
          ['설비', equipText([['기저귀 교환대', it.diaper_table], ['비상벨', it.emergency_bell]])],
          ['개방시간', [it.open, it.open_detail].filter((x) => x && String(x).trim()).join(' / ') || '정보 없음'],
          ['거리', distanceText(it)],
          ['출처', it.source],
        ]);
        if (num(it.total) === null) h += noteHtml('칸 수 정보 없음 (추천 목록에서는 빠져요)');
        break;
      case 'heat':
        st = heatShelterOpenNow(it, now);
        h += headHtml('heat', '무더위쉼터', it.name);
        h += stateHtml(st, '지금 운영 중', '지금 운영 안 함', '운영 여부 확인 필요') + weatherBadge('heat', st);
        h += rowsHtml([
          ['구분', it.kind], ['시설', it.facility], ['운영 요일', it.days], ['운영 시간', hoursToText(it.hours)],
          ['추가 운영', yesNo(it.weekend_extra) === null ? null : (yesNo(it.weekend_extra) ? '있음' : '없음')],
          ['공원에서', parkDist(it)], ['거리', distanceText(it)],
        ]);
        h += noteHtml('공휴일 운영 여부는 반영하지 않았어요.');
        break;
      case 'cold':
        st = coldShelterOpenNow(it, now);
        h += headHtml('cold', '한파쉼터', it.name);
        h += stateHtml(st, '지금 운영 중', '지금 운영 안 함', '운영시간 정보 없음') + weatherBadge('cold', st);
        h += rowsHtml([['구분', it.kind], ['시설', it.facility], ['이용 대상', it.who], ['비고', it.note], ['공원에서', parkDist(it)], ['거리', distanceText(it)]]);
        if (st === null) h += noteHtml('운영시간 정보가 없어요. 방문 전에 확인해 주세요.');
        break;
      case 'charger':
        h += headHtml('charger', '전동휠체어 충전기', it.name);
        h += stateHtml(chargerOpenNow(it, now), '지금 운영 중', '지금 운영 안 함', '운영 여부 확인 필요');
        h += rowsHtml([
          ['설치 위치', it.detail], ['평일 운영', hoursToText(it.weekday)], ['휴일 운영', hoursToText(it.holiday)],
          ['동시 사용', num(it.slots) === null ? it.slots : num(it.slots) + '대'], ['공원에서', parkDist(it)], ['거리', distanceText(it)],
        ]);
        h += noteHtml('토·일요일은 휴일 시간으로 계산했어요(공휴일 미반영).');
        break;
      case 'elevator':
        h += headHtml('elevator', '지하철 엘리베이터', (it.station || '지하철역') + ' 엘리베이터');
        h += rowsHtml([['거리', distanceText(it)]]);
        break;
      case 'aed':
        h += headHtml('aed', '자동심장충격기(AED)', it.name || 'AED');
        h += rowsHtml([['설치기관', it.name], ['설치위치', it.detail], ['거리', distanceText(it)]]);
        break;
      default: // facility
        h += headHtml('facility', '편의시설 · ' + (it.type || '기타'), it.place || it.type);
        h += rowsHtml([['상세 위치', it.detail], ['비고', it.note], ['거리', distanceText(it)]]);
    }
    return '<div class="pop pop-' + entry.cat + '">' + h + '</div>';
  }

  // 핀 꼭대기 위로 팝업이 뜨도록 띄우는 거리
  const PIN_H = ICON_SIZE[1] + 14;
  const POPUP_OFFSET = {
    'top': [0, 4], 'top-left': [0, 4], 'top-right': [0, 4],
    'bottom': [0, -PIN_H], 'bottom-left': [0, -PIN_H], 'bottom-right': [0, -PIN_H],
    'left': [ICON_SIZE[0] / 2, -PIN_H / 2], 'right': [-ICON_SIZE[0] / 2, -PIN_H / 2],
  };

  function openEntryPopup(entry, noMove) {
    stopOrbit();
    S.popupEntry = entry;
    if (S.compact) setNoticeOpen(false); // 휴대폰: 안내 상자가 팝업을 가리지 않게 접는다
    S.popup.setLngLat(ll(entry.item.lat, entry.item.lng)).setHTML(popupHtml(entry)).addTo(S.map);
    if (!noMove) ensurePopupVisible();
  }

  // 팝업이 지도 밖으로 잘리면, 잘린 만큼 지도를 밀어서 팝업 전체가 보이게 한다
  function ensurePopupVisible() {
    requestAnimationFrame(() => {
      if (!S.popup || !S.popup.isOpen()) return;
      const el = S.popup.getElement();
      if (!el) return;
      const p = el.getBoundingClientRect();
      const m = S.map.getContainer().getBoundingClientRect();
      const pad = 10;
      let dx = 0;
      let dy = 0;
      if (p.top < m.top + pad) dy = p.top - m.top - pad;
      else if (p.bottom > m.bottom - pad) dy = p.bottom - m.bottom + pad;
      if (p.left < m.left + pad) dx = p.left - m.left - pad;
      else if (p.right > m.right - pad) dx = p.right - m.right + pad;
      if (dx || dy) S.map.panBy([Math.round(dx), Math.round(dy)], { duration: reducedMotion() ? 0 : 350 });
    });
  }

  function openMePopup() {
    S.popupEntry = null;
    S.popup.setLngLat(ll(S.origin.lat, S.origin.lng))
      .setHTML('<div class="pop pop-me">' + headHtml('me', '기준 위치', S.originLabel) +
        '<p class="pop-row">지도를 누르거나 이 핀을 끌어서 기준 위치를 바꿀 수 있어요.</p></div>')
      .addTo(S.map);
  }

  // ───────────────────── 10. 기준 위치 ─────────────────────
  function parkCenter() {
    const c = S.data && S.data.meta && S.data.meta.park_center;
    return Array.isArray(c) && c.length === 2 ? { lat: Number(c[0]), lng: Number(c[1]) } : { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
  }

  // 공원 안인지: 가장 가까운 공원 시설(화장실·편의시설)까지 OUTSIDE_PARK_M 이내면 안으로 본다
  function isInsidePark(lat, lng) {
    const pts = (S.data.toilets || []).concat(S.data.facilities || []).filter(validPoint);
    if (!pts.length) return true;
    let min = Infinity;
    pts.forEach((p) => { min = Math.min(min, haversine(lat, lng, Number(p.lat), Number(p.lng))); });
    return min <= OUTSIDE_PARK_M;
  }

  function setOrigin(lat, lng, label) {
    S.origin = { lat: lat, lng: lng };
    S.originLabel = label;
    ensureAppState().userLocation = { lat: lat, lng: lng };
    if (!S.meMarker) {
      const p = makePinElement('me', '기준 위치');
      S.meMarker = new maplibregl.Marker({ element: p.wrap, anchor: 'bottom', draggable: true, pitchAlignment: 'viewport', rotationAlignment: 'viewport' })
        .setLngLat(ll(lat, lng))
        .addTo(S.map);
      onActivate(p.wrap, openMePopup);
      S.meMarker.on('dragend', () => {
        const q = S.meMarker.getLngLat();
        setOrigin(q.lat, q.lng, '직접 옮긴 위치');
      });
    } else {
      S.meMarker.setLngLat(ll(lat, lng));
    }
    recompute();
  }

  function initLocation() {
    const c = parkCenter();
    setOrigin(c.lat, c.lng, '공원 중심 (기본값)');
    if (!('geolocation' in navigator)) {
      tempNotice('이 브라우저는 위치 기능이 없어 공원 중심을 기준으로 계산해요.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        if (isInsidePark(lat, lng)) {
          setOrigin(lat, lng, '내 위치');
        } else {
          tempNotice('지금 공원 밖에 계셔서 공원 중심을 기준으로 계산해요. 지도를 누르면 기준 위치를 바꿀 수 있어요.');
        }
      },
      () => tempNotice('위치 정보를 쓸 수 없어 공원 중심을 기준으로 계산해요. 지도를 누르면 기준 위치를 바꿀 수 있어요.'),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }

  // ───────────────────── 10-2. 추천 동선: 상황별 '들를 곳 순서' (직선거리 기준) ─────────────────────
  // 계단·경사로가 표시된 '실제 길' 데이터가 없어서, 길 모양은 안내하지 않고 들를 곳과 순서만 정한다(팀 결정).
  //  1) 고른 상황마다 들를 곳 종류를 모은다(ROUTE_NEEDS). 화장실은 한 번만 들르고, 조건(장애인 칸·기저귀 교환대)을 모두 건다.
  //  2) 종류마다 후보 시설을 모은다. 화장실은 추천 목록(window.recommendations)에 있는 곳을 먼저 쓴다.
  //  3) 들를 순서를 모두 따져 보고(최대 4곳 → 24가지), 기준 위치에서 출발해 직선거리 합이 가장 짧은 순서를 고른다.
  //     각 순서에서는 '지금 자리에서 가장 가까운 후보'를 차례로 고른다.
  const NEED_LABEL = { charger: '전동휠체어 충전기', elevator: '지하철 엘리베이터', rest: '쉴 곳(쉼터)', nursing: '수유실', shop: '편의점·매점' };

  function toiletNeedLabel(profiles) {
    const parts = [];
    if (profiles.includes('wheelchair')) parts.push('장애인 칸');
    if (profiles.includes('stroller')) parts.push('기저귀 교환대');
    return parts.length ? parts.join('·') + ' 있는 화장실' : '화장실';
  }

  // ignoreOpen: 운영 여부를 따지지 않고 '시설이 있기는 한지'만 볼 때
  function routeCandidates(need, profiles, now, ignoreOpen) {
    const E = S.entries;
    const notClosed = (v) => ignoreOpen || v !== false;
    const facType = (e) => String(e.item.type || '');
    switch (need) {
      case 'toilet': {
        const ok = E.filter((e) => e.cat === 'toilet' && notClosed(toiletOpenNow(e.item, now)) &&
          (!profiles.includes('wheelchair') || num(e.item.accessible_stalls) > 0) &&
          (!profiles.includes('stroller') || yesNo(e.item.diaper_table) === true));
        const rec = new Set((window.recommendations || []).map((r) => r.lat + ',' + r.lng));
        const recOk = ok.filter((e) => rec.has(e.item.lat + ',' + e.item.lng));
        return recOk.length ? recOk : ok;
      }
      case 'charger': return E.filter((e) => e.cat === 'charger' && notClosed(chargerOpenNow(e.item, now)));
      case 'elevator': return E.filter((e) => e.cat === 'elevator');
      case 'rest': return E.filter((e) => ((e.cat === 'heat' || e.cat === 'cold') && notClosed(shelterStatus(e, now))) ||
        (e.cat === 'facility' && REST_FACILITY_RE.test(facType(e))));
      case 'nursing': return E.filter((e) => e.cat === 'facility' && NURSING_FACILITY_RE.test(facType(e)));
      case 'shop': return E.filter((e) => e.cat === 'facility' && CONCERT_FACILITY_RE.test(facType(e)));
      default: return [];
    }
  }

  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    arr.forEach((x, i) => {
      permutations(arr.slice(0, i).concat(arr.slice(i + 1))).forEach((rest) => out.push([x].concat(rest)));
    });
    return out;
  }

  function entryName(e) {
    if (e.cat === 'elevator') return (e.item.station || '지하철역') + ' 엘리베이터';
    if (e.cat === 'facility') return e.item.place || e.item.type || '편의시설';
    return e.item.name || e.title || '';
  }

  function computeRoutePlan(now) {
    const st = ensureAppState();
    const profiles = st.profiles || [];
    S.routeEntries = [];
    if (!profiles.length || !S.origin) return null;
    const needs = [];
    profiles.forEach((p) => (ROUTE_NEEDS[p] || []).forEach((n) => { if (!needs.includes(n)) needs.push(n); }));
    const groups = [];
    const missing = [];
    needs.forEach((n) => {
      const label = n === 'toilet' ? toiletNeedLabel(profiles) : NEED_LABEL[n];
      const cands = routeCandidates(n, profiles, now);
      if (cands.length) groups.push({ need: n, label: label, cands: cands });
      else missing.push(label + (routeCandidates(n, profiles, now, true).length ? ' (지금 운영 안 함)' : ' (근처 정보 없음)'));
    });
    const speed = walkSpeed(profiles);
    const basis = '직선거리 기준 · 분당 ' + speed + 'm 가정 · 실제 길은 더 멀거나 계단이 있을 수 있어요';
    const use = groups.slice(0, ROUTE_MAX_STOPS);
    if (!use.length) return { profiles: profiles.slice(), stops: [], totalM: 0, totalMin: 0, speed: speed, missing: missing, basis: basis };

    let best = null;
    permutations(use).forEach((order) => {
      let pos = S.origin;
      let total = 0;
      const stops = [];
      const used = new Set();
      order.forEach((g) => {
        let pick = null;
        let pickD = Infinity;
        g.cands.forEach((e) => {
          if (used.has(e)) return;
          const d = haversine(pos.lat, pos.lng, e.item.lat, e.item.lng);
          if (d < pickD) { pickD = d; pick = e; }
        });
        if (!pick) return;
        used.add(pick);
        stops.push({ g: g, e: pick, d: pickD });
        total += pickD;
        pos = pick.item;
      });
      if (!best || total < best.total) best = { total: total, stops: stops };
    });
    S.routeEntries = best.stops.map((s) => s.e);
    return {
      profiles: profiles.slice(),
      stops: best.stops.map((s, i) => ({
        step: i + 1, need: s.g.need, label: s.g.label, name: entryName(s.e),
        lat: s.e.item.lat, lng: s.e.item.lng, legM: Math.round(s.d), legMin: Math.max(1, Math.round(s.d / speed)),
      })),
      totalM: Math.round(best.total),
      totalMin: Math.max(1, Math.round(best.total / speed)),
      speed: speed,
      missing: missing,   // 들르지 못해 뺀 곳. 예: '전동휠체어 충전기 (지금 운영 안 함)'
      basis: basis,
    };
  }

  // ───────────────────── 11. 추천 + 강조 다시 계산 ─────────────────────
  function recompute() {
    if (!S.data || !S.origin) return;
    const st = ensureAppState();
    const now = new Date();

    // (1) 화장실 추천
    window.recommendations = computeRecommendations(S.data.toilets, S.origin, st.profiles, st.filters, now);
    // (1-2) 추천 동선(들를 곳 순서). 상황을 안 고르면 null
    window.routePlan = computeRoutePlan(now);
    document.dispatchEvent(new CustomEvent('recommendready', { detail: { recommendations: window.recommendations } }));
    document.dispatchEvent(new CustomEvent('routeready', { detail: { routePlan: window.routePlan } }));

    // (2) 강조/흐리게 + 3D 지도 위 표시(추천 순위, 연결선, 도보 범위)
    refreshEmphasis(now);
    updateOverlays();

    // (3) 열려 있는 팝업의 거리·상태 글자도 새로 고친다
    if (S.popupEntry && S.popup.isOpen()) S.popup.setHTML(popupHtml(S.popupEntry));
  }

  function nearestToilets(n) {
    return S.entries
      .filter((e) => e.cat === 'toilet')
      .map((e) => ({ e: e, d: haversine(S.origin.lat, S.origin.lng, e.item.lat, e.item.lng) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map((x) => x.e);
  }

  function shelterStatus(entry, now) {
    return entry.cat === 'heat' ? heatShelterOpenNow(entry.item, now) : coldShelterOpenNow(entry.item, now);
  }

  function refreshEmphasis(now) {
    if (!S.data || !S.origin) return; // 데이터가 오기 전에 conditionready가 와도, 데이터가 오면 다시 계산된다
    const st = ensureAppState();
    const profiles = st.profiles;
    const hi = new Set();
    const newlyChosen = profiles.filter((p) => !S.prevProfiles.includes(p));
    const recKeys = new Set((window.recommendations || []).map((r) => r.lat + ',' + r.lng));
    const isShelter = (e) => e.cat === 'heat' || e.cat === 'cold';
    const shelterNotClosed = (e) => isShelter(e) && shelterStatus(e, now) !== false;

    profiles.forEach((p) => {
      S.entries.forEach((e) => {
        const it = e.item;
        if (p === 'wheelchair' && ((e.cat === 'toilet' && num(it.accessible_stalls) > 0) || e.cat === 'charger' || e.cat === 'elevator')) hi.add(e);
        if (p === 'stroller' && ((e.cat === 'toilet' && yesNo(it.diaper_table) === true) || e.cat === 'elevator')) hi.add(e);
        if (p === 'elderly' && shelterNotClosed(e)) hi.add(e);
        if (p === 'pregnant' && (e.cat === 'toilet' || shelterNotClosed(e))) hi.add(e);
        if (p === 'concert' && ((e.cat === 'toilet' && recKeys.has(it.lat + ',' + it.lng)) ||
          (e.cat === 'facility' && CONCERT_FACILITY_RE.test(String(it.type || ''))) || shelterNotClosed(e))) hi.add(e);
      });
      if (p === 'elderly') nearestToilets(ELDERLY_NEAR_COUNT).forEach((e) => hi.add(e));
    });
    // 추천 동선에 들어간 곳은 강조하고, 꺼진 레이어면 켠다
    (S.routeEntries || []).forEach((e) => { hi.add(e); showLayer(e.layerKey); });

    // 새로 고른 프로필에 쉼터·충전기 등이 필요하면 그 레이어를 켠다(사용자가 다시 끌 수 있다)
    newlyChosen.forEach((p) => {
      if (p === 'wheelchair') { showLayer('charger'); showLayer('elevator'); }
      if (p === 'stroller') showLayer('elevator');
      if (p === 'elderly' || p === 'pregnant' || p === 'concert') { showLayer('heat'); showLayer('cold'); }
    });
    S.prevProfiles = profiles.slice();

    // 날씨(conditionready)에 따른 쉼터 강조: 지금 운영 중인 곳만
    const ci = window.conditionInfo || {};
    const shelterMsgs = [];
    [['heat', ci.needHeatShelter, '무더위쉼터'], ['cold', ci.needColdShelter, '한파쉼터']].forEach(([cat, need, label]) => {
      if (!need) return;
      showLayer(cat);
      const open = S.entries.filter((e) => e.cat === cat && shelterStatus(e, now) === true);
      open.forEach((e) => hi.add(e));
      if (open.length === 0) {
        const unknown = S.entries.some((e) => e.cat === cat && shelterStatus(e, now) === null);
        shelterMsgs.push('지금 운영 중인 ' + label + '가 확인되지 않아요' +
          (unknown ? '(운영시간 정보가 없는 곳이 있어요)' : '') + '. 가까운 실내 시설을 이용하세요.');
      } else {
        shelterMsgs.push('지금 운영 중인 ' + label + ' ' + open.length + '곳을 강조했어요.');
      }
    });
    setNotice('shelter', shelterMsgs.join(' '), shelterMsgs.some((m) => m.includes('확인되지')) ? 'warn' : 'info');

    // 아이콘 클래스 적용: 강조 'mk-highlight', 프로필이 있을 때 나머지는 'mk-dim' (팀원3 style.css 약속)
    S.entries.forEach((e) => {
      const state = hi.has(e) ? 'mk-highlight' : profiles.length ? 'mk-dim' : '';
      if (state !== e.iconState) {
        e.iconState = state;
        setPinState(e, state);
      }
    });
  }

  // ───────────────────── 12. 3D 배경 지도 꾸미기 ─────────────────────
  function circlePolygon(lat, lng, radiusM, steps) {
    const coords = [];
    const dLat = radiusM / 111320;
    const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      coords.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
  }

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  function firstLayerId(pred) {
    const layers = S.map.getStyle().layers || [];
    const hit = layers.find(pred);
    return hit ? hit.id : undefined;
  }

  // 지도 글자를 한국어 이름 우선으로
  function koreanLabels() {
    (S.map.getStyle().layers || []).forEach((l) => {
      if (l.type !== 'symbol' || !l.layout || !l.layout['text-field']) return;
      const tf = JSON.stringify(l.layout['text-field']);
      if (!/name/.test(tf)) return;
      try {
        S.map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ko'], ['get', 'name'], ['get', 'name_en']]);
      } catch (e) { /* 표현식을 못 바꾸는 층은 그대로 둔다 */ }
    });
  }

  // 3D 건물: 스타일에 이미 있으면 색을 다듬고, 없으면 새로 만든다
  function styleBuildings() {
    const style = S.map.getStyle();
    const hasOMT = style.sources && style.sources.openmaptiles;
    let ids = (style.layers || []).filter((l) => l.type === 'fill-extrusion').map((l) => l.id);
    if (!ids.length && hasOMT) {
      S.map.addLayer({
        id: 'op-building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
        paint: {
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        },
      }, firstLayerId((l) => l.type === 'symbol'));
      ids = ['op-building-3d'];
    }
    ids.forEach((id) => {
      try {
        S.map.setPaintProperty(id, 'fill-extrusion-color', [
          'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8],
          0, '#ece7df', 20, '#e2dbd0', 60, '#d3cabd', 150, '#c4b9aa',
        ]);
        S.map.setPaintProperty(id, 'fill-extrusion-opacity', 0.92);
        S.map.setPaintProperty(id, 'fill-extrusion-vertical-gradient', true);
      } catch (e) { /* 무시 */ }
    });
    S.extrusionLayers = ids;
  }

  function decorateMap() {
    const style = S.map.getStyle();
    const hasOMT = style.sources && style.sources.openmaptiles;
    if (hasOMT) {
      koreanLabels();
      styleBuildings();
      // 올림픽공원 경계를 초록 테두리로 (OSM 이름이 맞을 때만 보인다)
      const parkFilter = ['any', ['==', ['get', 'name'], '올림픽공원'], ['==', ['get', 'name:ko'], '올림픽공원']];
      const before = firstLayerId((l) => l.type === 'fill-extrusion' || l.type === 'symbol');
      try {
        S.map.addLayer({ id: 'op-park-fill', type: 'fill', source: 'openmaptiles', 'source-layer': 'park', filter: parkFilter,
          paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.07 } }, before);
        S.map.addLayer({ id: 'op-park-line', type: 'line', source: 'openmaptiles', 'source-layer': 'park', filter: parkFilter,
          paint: { 'line-color': '#16a34a', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 17, 4], 'line-opacity': 0.75, 'line-blur': 0.5 } }, before);
      } catch (e) { /* park 층이 없으면 건너뛴다 */ }
    }
    try {
      S.map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: 0.38, position: [1.4, 210, 35] });
    } catch (e) { /* 무시 */ }
    try {
      S.map.setSky({
        'sky-color': '#9fd0ff', 'horizon-color': '#e6f2ff', 'fog-color': '#eef3f7',
        'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0.6,
      });
    } catch (e) { /* 하늘 표현을 못 하는 환경이면 건너뛴다 */ }

    // 우리 표시층: 도보 범위 원, 추천 연결선 (건물·글자 아래에 깔리도록)
    const before = firstLayerId((l) => l.type === 'fill-extrusion' || l.type === 'symbol');
    S.map.addSource('op-walk', { type: 'geojson', data: emptyFC() });
    S.map.addSource('op-rec', { type: 'geojson', data: emptyFC() });
    S.map.addLayer({ id: 'op-walk-fill', type: 'fill', source: 'op-walk', paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.07 } }, before);
    S.map.addLayer({ id: 'op-walk-line', type: 'line', source: 'op-walk',
      paint: { 'line-color': '#0ea5e9', 'line-width': 2, 'line-opacity': 0.7, 'line-dasharray': [2, 2] } }, before);
    S.map.addLayer({ id: 'op-rec-casing', type: 'line', source: 'op-rec', layout: { 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['-', 9, ['*', 1.5, ['get', 'rank']]], 'line-opacity': 0.85 } }, before);
    S.map.addLayer({ id: 'op-rec-line', type: 'line', source: 'op-rec', layout: { 'line-cap': 'round' },
      paint: { 'line-color': ['match', ['get', 'rank'], 1, '#2563eb', 2, '#3b82f6', '#60a5fa'],
        'line-width': ['-', 5.5, ['*', 1, ['get', 'rank']]], 'line-dasharray': [1.2, 1.4] } }, before);
    // 추천 동선(들를 곳 순서) — 직선
    S.map.addSource('op-route', { type: 'geojson', data: emptyFC() });
    S.map.addLayer({ id: 'op-route-casing', type: 'line', source: 'op-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 } }, before);
    S.map.addLayer({ id: 'op-route-line', type: 'line', source: 'op-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ROUTE_COLOR, 'line-width': 4.5, 'line-dasharray': [1.6, 1.2] } }, before);
    S.overlayReady = true;
  }

  function updateOverlays() {
    // 추천 동선 순서 배지(①②③)
    const stepOf = new Map();
    (S.routeEntries || []).forEach((e, i) => stepOf.set(e, i + 1));
    S.entries.forEach((e) => {
      const n = stepOf.get(e) || '';
      const badge = e.pin.querySelector('.mk-step');
      if (badge && badge.textContent !== String(n)) badge.textContent = n;
      e.el.classList.toggle('is-step', !!n);
    });
    // 추천 순위 배지
    const rank = new Map();
    (window.recommendations || []).forEach((r, i) => rank.set(r.lat + ',' + r.lng, i + 1));
    S.entries.forEach((e) => {
      if (e.cat !== 'toilet') return;
      const r = rank.get(e.item.lat + ',' + e.item.lng) || '';
      const badge = e.pin.querySelector('.mk-rank');
      if (badge && badge.textContent !== String(r)) badge.textContent = r;
      e.el.classList.toggle('is-ranked', !!r);
    });
    if (!S.overlayReady || !S.origin) return;
    const st = ensureAppState();
    S.map.getSource('op-walk').setData({
      type: 'FeatureCollection',
      features: [circlePolygon(S.origin.lat, S.origin.lng, WALK_RING_MIN * walkSpeed(st.profiles), 72)],
    });
    const plan = window.routePlan;
    const hasRoute = !!(plan && plan.stops && plan.stops.length);
    S.map.getSource('op-route').setData(hasRoute ? {
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: [ll(S.origin.lat, S.origin.lng)].concat(plan.stops.map((x) => ll(x.lat, x.lng))) },
    } : emptyFC());
    // 동선이 있으면 화장실 연결선은 숨겨 지도를 덜 복잡하게
    ['op-rec-casing', 'op-rec-line'].forEach((id) => S.map.setLayoutProperty(id, 'visibility', hasRoute ? 'none' : 'visible'));
    // 들를 곳이 바뀌었을 때만, 기준 위치와 들를 곳이 모두 보이게 지도를 맞춘다
    const routeKey = hasRoute ? plan.stops.map((x) => x.lat + ',' + x.lng).join('|') : '';
    if (hasRoute && routeKey !== S.lastRouteKey) {
      const b = new maplibregl.LngLatBounds(ll(S.origin.lat, S.origin.lng), ll(S.origin.lat, S.origin.lng));
      plan.stops.forEach((x) => b.extend(ll(x.lat, x.lng)));
      const h = S.map.getContainer().clientHeight;
      S.map.fitBounds(b, {
        padding: { top: Math.round(h * 0.18), bottom: Math.round(h * 0.12), left: 50, right: 70 },
        maxZoom: 17.5, bearing: S.map.getBearing(), pitch: S.map.getPitch(), duration: reducedMotion() ? 0 : 900,
      });
    }
    S.lastRouteKey = routeKey;
    S.map.getSource('op-rec').setData({
      type: 'FeatureCollection',
      features: (window.recommendations || []).map((r, i) => ({
        type: 'Feature', properties: { rank: i + 1 },
        geometry: { type: 'LineString', coordinates: [ll(S.origin.lat, S.origin.lng), ll(r.lat, r.lng)] },
      })).reverse(), // 1위 선이 맨 위에 그려지도록
    });
  }

  // ───────────────────── 13. 추천 목록 클릭 → 지도 이동 ─────────────────────
  function focusPlace(lat, lng) {
    lat = Number(lat);
    lng = Number(lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    stopOrbit();
    const near = (e) => Math.abs(e.item.lat - lat) < 1e-6 && Math.abs(e.item.lng - lng) < 1e-6;
    const entry = S.entries.find((e) => e.cat === 'toilet' && near(e)) || S.entries.find(near);
    S.map.flyTo({
      center: ll(lat, lng), zoom: Math.max(S.map.getZoom(), FOCUS_ZOOM),
      offset: focusOffset(), // 핀을 아래쪽에 둬서 팝업이 위로 펼쳐질 자리를 만든다
      pitch: S.is3D ? PITCH_3D + 4 : 0, duration: reducedMotion() ? 0 : 1400, essential: false,
    });
    if (entry) {
      showLayer(entry.layerKey);
      openEntryPopup(entry, true); // 이미 flyTo로 옮기는 중 → 다 옮긴 뒤 잘림 확인
      S.map.once('moveend', ensurePopupVisible);
    } else {
      S.popupEntry = null;
      S.popup.setLngLat(ll(lat, lng)).setHTML('<div class="pop"><h3 class="pop-title">선택한 위치</h3></div>').addTo(S.map);
    }
  }

  // ───────────────────── 14. 데이터 점검 도구 (11-4번 작업용) ─────────────────────
  // 브라우저 개발자 도구(F12) 콘솔에서 mapUtils.checkOpenValues() 를 실행하면
  // 개방시간·운영시간 칸에 실제로 어떤 값이 있는지, 그리고 지금 어떻게 판단되는지 표로 보여준다.
  function checkOpenValues() {
    if (!S.data) { console.warn('데이터가 아직 안 불러와졌어요.'); return; }
    const now = new Date();
    const label = (v) => (v === true ? '열림' : v === false ? '닫힘' : '판단 불가');
    const uniq = (arr) => Array.from(new Set(arr.map((v) => JSON.stringify(v)))).map((v) => JSON.parse(v));
    console.log('기준 시각:', now.toLocaleString());
    console.log('■ 화장실 open / open_detail');
    console.table(uniq((S.data.toilets || []).map((t) => ({ open: t.open, open_detail: t.open_detail })))
      .map((r) => Object.assign(r, { 판단: label(toiletOpenNow(r, now)) })));
    console.log('■ 무더위쉼터 days / hours / weekend_extra');
    console.table(uniq((S.data.heat_shelters || []).map((s) => ({ days: s.days, hours: s.hours, weekend_extra: s.weekend_extra })))
      .map((r) => Object.assign(r, { 요일해석: (parseDays(r.days) || []).map((d) => DAY_CHARS[d]).join(''), 판단: label(heatShelterOpenNow(r, now)) })));
    console.log('■ 충전기 weekday / holiday');
    console.table(uniq((S.data.wheelchair_chargers || []).map((c) => ({ weekday: c.weekday, holiday: c.holiday })))
      .map((r) => Object.assign(r, { 판단: label(chargerOpenNow(r, now)) })));
    console.log('■ 편의시설 종류(type)');
    console.table(uniq((S.data.facilities || []).map((f) => f.type)));
  }

  // 다른 팀원이 콘솔에서 확인할 수 있게 계산 함수를 열어 둔다(서비스 동작에는 영향 없음)
  window.mapUtils = {
    haversine, walkSpeed, walkMinutes, stallsFor, computeRecommendations,
    parseTimeRanges, parseDays, openStatusFromText, toiletOpenNow, heatShelterOpenNow, chargerOpenNow,
    checkOpenValues, focusPlace: (lat, lng) => focusPlace(lat, lng),
    set3D: (on) => set3D(on), resetView: () => resetView(),
    getMap: () => S.map, // MapLibre 지도 객체(디버깅용)
  };

  // ───────────────────── 15. 시작 ─────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('스크립트를 불러오지 못함: ' + src));
      document.head.appendChild(s);
    });
  }

  const isDemo = () => /[?&]demo(?:[=&]|$)/.test(location.search);

  async function loadData() {
    // 테스트용: 서버 없이 열 때는 mock_data.js가 window.__PARK_DATA__를 미리 넣어 둔다
    if (window.__PARK_DATA__) return window.__PARK_DATA__;
    if (isDemo()) {
      await loadScript(MOCK_URL);
      if (window.__PARK_DATA__) return window.__PARK_DATA__;
    }
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function fallbackStyle() {
    return {
      version: 8,
      sources: {
        osm: { type: 'raster', tiles: [FALLBACK_TILES], tileSize: 256, maxzoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    };
  }

  // 3D 스타일을 먼저 받아 보고, 안 되면 2D 타일로 대체한다
  async function pickStyle() {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), 7000);
    try {
      const res = await fetch(STYLE_URL, ctrl ? { signal: ctrl.signal } : undefined);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return { style: await res.json(), is3D: true };
    } catch (err) {
      console.warn('[map.js] 3D 배경 지도를 불러오지 못해 2D 타일로 바꿨어요:', err);
      return { style: fallbackStyle(), is3D: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async function init() {
    if (typeof maplibregl === 'undefined') {
      console.error('[map.js] MapLibre GL이 없어요. index.html에서 maplibre-gl.js CDN이 map.js보다 먼저 있어야 해요.');
      return;
    }
    const el = document.getElementById('map');
    if (!el) {
      console.error('[map.js] #map 영역이 없어요.');
      return;
    }
    ensureAppState();
    injectBaseStyle();
    el.classList.add('is-loading');

    // 이벤트는 데이터가 오기 전에도 받아 두고, 데이터가 오면 계산한다
    document.addEventListener('profilechange', recompute);
    document.addEventListener('filterchange', recompute);
    document.addEventListener('conditionready', () => refreshEmphasis(new Date()));
    document.addEventListener('focusplace', (e) => { const d = (e && e.detail) || {}; if (S.data) focusPlace(d.lat, d.lng); });

    const dataPromise = loadData().then((d) => ({ ok: true, d: d }), (err) => ({ ok: false, err: err }));
    const picked = await pickStyle();
    const c0 = { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };

    try {
      S.map = new maplibregl.Map({
        container: el,
        style: picked.style,
        center: ll(c0.lat, c0.lng),
        zoom: 13.6,
        pitch: 0,
        bearing: 0,
        maxPitch: 75,
        attributionControl: { compact: true },
        localIdeographFontFamily: KOREAN_FONTS, // 한글은 기기 글꼴로 그려 선명하고 빠르다
        canvasContextAttributes: { antialias: true },
      });
    } catch (err) {
      el.classList.remove('is-loading');
      el.classList.add('is-error');
      el.innerHTML = '<div class="map3d-fail">이 기기·브라우저에서는 3D 지도(WebGL)를 쓸 수 없어요.<br>다른 브라우저(크롬·사파리·엣지 최신판)로 열어 주세요.</div>';
      console.error('[map.js] 지도를 만들지 못했어요:', err);
      document.dispatchEvent(new CustomEvent('mapdataerror', { detail: { error: String(err) } }));
      return;
    }
    S.is3D = picked.is3D;
    S.popup = new maplibregl.Popup({ maxWidth: '280px', offset: POPUP_OFFSET, focusAfterOpen: false });
    S.popup.on('close', () => { S.popupEntry = null; });

    S.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'top-right');
    S.map.addControl(new ViewControl(), 'top-right');
    S.map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-right');
    buildNotice();
    applyCompact();
    S.map.on('resize', applyCompact);
    updateViewButtons();
    ['mousedown', 'touchstart', 'wheel'].forEach((ev) => S.map.getCanvasContainer().addEventListener(ev, stopOrbit, { passive: true }));

    await new Promise((resolve) => (S.map.loaded() ? resolve() : S.map.once('load', resolve)));
    try { decorateMap(); } catch (err) { console.warn('[map.js] 지도 꾸미기 일부를 건너뛰었어요:', err); }

    const got = await dataPromise;
    el.classList.remove('is-loading');
    if (!got.ok) {
      el.classList.add('is-error');
      console.error('[map.js] 시설 데이터를 불러오지 못했어요:', got.err);
      setNotice('temp', '시설 데이터를 불러오지 못했어요. 잠시 뒤 새로고침해 주세요.', 'warn');
      document.dispatchEvent(new CustomEvent('mapdataerror', { detail: { error: String(got.err) } }));
      return;
    }
    S.data = got.d;
    if (isDemo() && S.data && S.data.meta && S.data.meta.is_mock) {
      setNotice('demo', '미리보기용 가상 데이터예요. 실제 시설 위치·정보가 아니에요.', 'demo');
    }

    buildLayers(S.data);

    // 지도(빈 곳)를 누르면 기준 위치를 옮긴다. 핀을 누른 경우는 빼고.
    S.map.on('click', (e) => {
      const t = e.originalEvent && e.originalEvent.target;
      if (t && t.closest && t.closest('.maplibregl-marker')) return;
      setOrigin(e.lngLat.lat, e.lngLat.lng, '지도에서 고른 위치');
    });
    initLocation(); // 안에서 recompute()가 불린다

    // 처음 열 때 하늘에서 내려오며 3D로 기울어지는 장면
    const c = parkCenter();
    S.map.flyTo({
      center: ll(c.lat, c.lng), zoom: DEFAULT_ZOOM, pitch: S.is3D ? PITCH_3D : 0, bearing: S.is3D ? BEARING_3D : 0,
      duration: reducedMotion() ? 0 : 2600, curve: 1.3, essential: false,
    });

    setInterval(recompute, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
