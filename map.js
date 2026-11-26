/* =====================================================================
 * map.js — 팀원1(지도·추천 기능 담당)  ·  3D 버전 (MapLibre GL JS)
 * 올림픽공원 편의시설 지도: 3D 지도, 레이어, 팝업, 기준 위치,
 * 거리·추천 계산, "지금 운영 중" 판단
 *
 * Leaflet 2D → MapLibre GL 3D로 바꿨지만, 팀 약속(프롬프트 4번 계산 규칙, 7번 연결 약속)은 그대로다.
 *  - 읽는 것 : window.appState (ui.js가 만듦), window.conditionInfo (weather.js가 만듦)
 *  - 채우는 것: window.appState.userLocation, window.recommendations
 *  - 듣는 이벤트 : profilechange, filterchange, conditionready, focusplace, destinationchange(추가), originpick(추가)
 *  - 보내는 이벤트(추가): originchange { key, label, lat, lng } — 기준(출발) 위치가 바뀔 때
 *  - 듣는 이벤트(추가): themechange { theme: 'light' | 'dark' } — 지도 색을 밝게/어둡게
 *  - data/transit.json(추가): 지하철역·버스정류장(OpenStreetMap)과 택시 타기 좋은 곳. '역·버스·택시' 목적지와 교통 브리핑에 쓴다
 *  - 보내는 이벤트: recommendready, routeready (실패 시 mapdataerror)
 *  - 채우는 것(추가): window.routePlan — 상황별 '들를 곳 순서'(직선거리 기준). 상황을 안 고르면 null
 *      가고 싶은 곳(appState.destination)을 고르면 그곳까지의 '길안내'가 되고, 날씨에 맞는 경유지가 들어간다.
 *  - 채우는 것(추가): window.destList — 가고 싶은 곳이 화장실이 아닐 때 가까운 시설 목록(필요한 정보만)
 *  - 마커 : <div class="mk mk-종류"> (종류: toilet, toilet-accessible, facility, heat, cold, charger, elevator, aed, me)
 *      강조 'mk-highlight', 흐림 'mk-dim' (팀원3 style.css 약속). 아이콘 모양은 style.css의 .mk-종류::before가 그린다.
 *      3D 핀 모양을 위해 바깥에 .mk-wrap(기둥·그림자)을 한 겹 더 씌웠다. 이 겉 칸은 팀원3이 꾸밀 필요 없다.
 *  - #map 상태 클래스: 불러오는 중 'is-loading', 실패 'is-error'
 *  - 팝업 HTML (팀원3 style.css 약속):
 *      <div class="pop"> pop-type(종류) / pop-title(이름) / pop-badge is-open|is-closed|is-unknown|is-heat|is-cold
 *                        / pop-row(정보 줄, <b>항목</b> 값) / pop-note(칸 수 정보 없음 같은 주의 문구)
 *  - recommendations 항목에는 약속된 6개 값에 더해 stallsType('total'|'female'|'accessible')을 넣는다.
 *      [추가] walkM(걷는 거리 m), pathBased(true: 걷는 길 기준 / false: 길을 못 찾아 직선거리로 대신)도 넣는다.
 *  - 응급 화면(추가): 'emergencyopen'을 들으면 window.emergencyInfo(지금 위치 설명·가까운 AED)를 채우고
 *      'emergencyready'를 보낸다. 'emergencyroute' { lat, lng }를 들으면 그 AED까지 길안내를 만든다.
 *
 * index.html에 필요한 것 (Leaflet 대신):
 *   <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.24.1/dist/maplibre-gl.css">
 *   <script src="https://unpkg.com/maplibre-gl@5.24.1/dist/maplibre-gl.js"></script>  ← map.js보다 먼저
 *
 * 배경 지도: OpenFreeMap(무료·키 없음, OpenStreetMap 데이터, 건물 높이 포함).
 *   불러오지 못하면 OpenStreetMap 2D 타일로 자동 대체한다.
 * 데이터가 아직 없을 때 미리보기: 주소 뒤에 ?demo 를 붙이면 mock_data.js(가상 데이터)를 쓴다.
 * 게임 모드: 데이터가 준비되면 game.js(직접 찾아가기)를 이 파일이 불러온다. index.html에 따로 넣지 않는다.
 * ===================================================================== */
(function () {
  'use strict';

  // ───────────────────── 1. 설정값 ─────────────────────
  const DATA_URL = 'data/olympic_park_data.json';
  const WALK_GRAPH_URL = 'data/walk_graph.json';
  const TRANSIT_URL = 'data/transit.json';          // 지하철역·버스정류장·택시 타기 좋은 곳  // 걷는 길 그래프(OpenStreetMap). tools/build_walk_graph.py로 만든다
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
  // 현장 제보용 구글 폼 주소. 비어 있으면 팝업의 '정보가 달라요' 버튼을 숨긴다 [팀원1 추가]
  const REPORT_FORM_URL = '';
  // 응급 화면에 보여 줄 가까운 AED 수 [팀원1 추가]
  const EMERGENCY_AED_COUNT = 3;
  // 위치가 의심스러운 AED는 응급 화면의 '가까운 AED'에서 빼고, AED 목록에서는 뒤로 보낸다 [팀원1 추가]
  //  1) 서로 다른 건물 여러 곳(만남의광장·평화의광장·올림픽홀·수영장 등)이 같은 좌표로 들어 있는 곳
  const AED_UNSURE_COORDS = ['37.520339698,127.1155178766'];
  //  2) 설치 위치 설명에 적힌 경기장과 좌표가 이만큼 넘게 떨어진 곳 (예: '체조경기장 지하1층'인데 좌표는 900m 떨어짐)
  const AED_PLACE_MISMATCH_M = 400;
  const AED_PLACE_CHECK = [   // [설명에 나오는 이름, 그 장소 좌표] — 좌표는 아래 EMERGENCY_LANDMARKS와 같은 값
    [/체조경기장|KSPO\s*돔|KSPO\s*DOME/i, 37.51932, 127.127041], [/핸드볼/, 37.517703, 127.126494],
    [/테니스/, 37.514955, 127.128647], [/수영장|수영경기장/, 37.520654, 127.126685],
    [/우리금융아트홀|역도경기장/, 37.517467, 127.125023], [/올림픽홀/, 37.515154, 127.127099],
    [/벨로드롬/, 37.517498, 127.123861], [/소마미술관/, 37.516819, 127.118666],
    [/한성백제박물관/, 37.515572, 127.120615], [/평화의\s*광장/, 37.518447, 127.116531], [/만남의\s*광장/, 37.516885, 127.129675],
  ];
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
    'subway':            { color: '#1e5aa8', emoji: '🚇' },
    'bus':               { color: '#2f9e44', emoji: '🚌' },
    'taxi':              { color: '#e8a400', emoji: '🚕' },
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
  // distOf(화장실) → { m: 거리(m), path: 걷는 길 기준이면 true }. 없으면 직선거리로 잰다.
  // [팀원1 수정] 길안내와 같은 숫자가 나오도록 recompute()에서 '걷는 길 거리'를 넘겨준다.
  function computeRecommendations(toilets, origin, profiles, filters, now, distOf) {
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
      const dist = distOf ? distOf(t) : { m: haversine(origin.lat, origin.lng, t.lat, t.lng), path: false };
      const meters = dist.m;
      const minutes = walkMinutes(meters, profiles);
      list.push({
        name: t.name,
        rawScore: stalls / (minutes + 1),
        walkMin: Math.max(1, Math.round(minutes)),
        walkM: Math.round(meters),
        pathBased: !!dist.path,
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
      walkM: r.walkM, pathBased: r.pathBased, // [팀원1 추가] 걷는 거리(m), 걷는 길 기준인지
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
    if (!st.destination) st.destination = 'all';   // 가고 싶은 곳 (추가). 'all'이면 예전처럼 전부 보여 준다
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
    destEntries: [],     // 가고 싶은 곳 목록에 들어간 마커들
    destTarget: null,    // 목록에서 직접 고른 목적지 ('위도,경도'). 없으면 1순위로 길안내
    lastDest: 'all',
    walk: null,          // 걷는 길 그래프 (불러오면 길안내 선이 길을 따라간다. 없으면 직선)
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

    // 교통: 지하철역(보임), 버스정류장·택시 타기 좋은 곳(처음엔 숨김 → '역·버스·택시'를 고르면 보임)
    const tr = data.transit;
    if (tr) {
      addLayer('subway', '지하철역', 'subway', true);
      (tr.stations || []).forEach((s) => { s.ttype = 'subway'; count(addEntry('subway', 'transit', 'subway', s, s.name + '역')); });
      addLayer('bus', '버스정류장', 'bus', false);
      (tr.bus_stops || []).forEach((b) => { b.ttype = 'bus'; count(addEntry('bus', 'transit', 'bus', b, b.name + ' 정류장')); });
      addLayer('taxi', '택시 타기 좋은 곳', 'taxi', false);
      (tr.taxi || []).forEach((t) => { t.ttype = 'taxi'; count(addEntry('taxi', 'transit', 'taxi', t, '택시 · ' + t.name)); });
    }

    if (skipped) console.warn('[map.js] 좌표가 없거나 잘못된 항목 ' + skipped + '개는 지도에서 뺐어요.');

    S.map.addControl(new LayerControl(), 'top-left');
  }

  function setLayerVisible(key, visible) {
    const layer = S.layers[key];
    if (!layer) return;
    layer.visible = !!visible;
    layer.entries.forEach((e) => { e.el.style.display = entryShown(e) ? '' : 'none'; });
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
    div.className = 'maplibregl-ctrl op-panel is-collapsed';   // 지도를 가리지 않게 처음엔 접어 둔다(누르면 펼침)
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
      '<div><b>동선 선은 OpenStreetMap 걷는 길을 따라가요(경사·공사 미반영). 화장실 연결선은 직선이에요.</b></div>' +
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
    const d = distFromOrigin(item, st.profiles);   // [팀원1 수정] 걷는 길 거리(길을 못 찾으면 직선)
    const min = Math.max(1, Math.round(walkMinutes(d.m, st.profiles)));
    return (d.path ? '걸어서 약 ' : '직선 약 ') + Math.round(d.m).toLocaleString() + 'm · 도보 약 ' + min + '분 (분당 ' + walkSpeed(st.profiles) + 'm 가정' +
      (d.path ? ')' : ', 직선거리 기준)');
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
        if (aedUnsure(it)) h += noteHtml('설치위치 설명과 지도 좌표가 맞지 않아 실제 위치와 다를 수 있어요. 설치위치 설명을 확인하세요.');
        break;
      case 'transit':
        if (entry.kind === 'subway') {
          h += headHtml('subway', '지하철역 · ' + (it.lines || []).join('·'), it.name + '역');
          h += rowsHtml([['출구', (it.exits || []).length ? it.exits.join(', ') + '번' : null],
            ['엘리베이터', stationElevatorText(it)], ['거리', distanceText(it)]]);
        } else if (entry.kind === 'bus') {
          h += headHtml('bus', '버스정류장', it.name);
          h += rowsHtml([['버스', (it.routes || []).length ? it.routes.join(', ') : '노선 정보 없음'], ['거리', distanceText(it)]]);
          h += noteHtml('버스 노선은 OpenStreetMap 기준이라 빠진 노선이 있을 수 있어요.');
        } else {
          h += headHtml('taxi', '택시 타기 좋은 곳', it.name);
          h += rowsHtml([['도로', it.road], ['이유', it.why], ['거리', distanceText(it)]]);
          h += noteHtml('공식 택시 승강장이 아니라, 큰길과 바로 이어지는 출입구를 추천한 곳이에요.');
        }
        break;
      default: // facility
        h += headHtml('facility', '편의시설 · ' + (it.type || '기타'), it.place || it.type);
        h += rowsHtml([['상세 위치', it.detail], ['비고', it.note], ['거리', distanceText(it)]]);
    }
    // 현장 제보: 폼 주소가 정해졌을 때만 버튼을 보여 준다 [팀원1 추가]
    if (REPORT_FORM_URL) {
      h += '<p class="pop-report"><a class="pop-report-btn" href="' + esc(REPORT_FORM_URL) + '" target="_blank" rel="noopener">정보가 달라요</a></p>';
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

  // key: 출발지 버튼 이름(gps, olympic-stn …), 지도에서 직접 고르면 'custom'
  function setOrigin(lat, lng, label, key) {
    S.origin = { lat: lat, lng: lng };
    S.originLabel = label;
    S.originKey = key || 'custom';
    ensureAppState().userLocation = { lat: lat, lng: lng };
    if (!S.meMarker) {
      const p = makePinElement('me', '기준 위치');
      S.meMarker = new maplibregl.Marker({ element: p.wrap, anchor: 'bottom', draggable: true, pitchAlignment: 'viewport', rotationAlignment: 'viewport' })
        .setLngLat(ll(lat, lng))
        .addTo(S.map);
      onActivate(p.wrap, openMePopup);
      S.meMarker.on('dragend', () => {
        const q = S.meMarker.getLngLat();
        setOrigin(q.lat, q.lng, '직접 옮긴 위치', 'custom');
      });
    } else {
      S.meMarker.setLngLat(ll(lat, lng));
    }
    recompute();
    document.dispatchEvent(new CustomEvent('originchange', { detail: { key: S.originKey, label: label, lat: lat, lng: lng } }));
  }

  // ───── 10-1. 출발지 빠르게 고르기 [팀원1 추가] ─────
  // 지하철역은 data의 지하철 엘리베이터 좌표 중 공원 중심에서 가장 가까운 곳을 쓴다.
  // 평화의문·남2문 주차장·북2문 좌표는 OpenStreetMap에서 가져왔다(북2문은 같은 이름 버스정류장 위치라 '근처').
  const ORIGIN_PRESETS = {
    'olympic-stn': { label: '올림픽공원역', station: /올림픽공원/ },
    'mongchon-stn': { label: '몽촌토성역', station: /몽촌토성/ },
    'hanseong-stn': { label: '한성백제역', station: /한성백제/ },
    'peace-gate': { label: '평화의문(정문)', lat: 37.518313, lng: 127.115394 },
    's2-parking': { label: '남2문 주차장', lat: 37.514912, lng: 127.124215 },
    'n2-gate': { label: '북2문 근처', lat: 37.524095, lng: 127.128041 },
    center: { label: '공원 중심' },
  };

  function presetPoint(key) {
    const p = ORIGIN_PRESETS[key];
    if (!p) return null;
    if (key === 'center') { const c = parkCenter(); return { lat: c.lat, lng: c.lng, label: p.label }; }
    if (p.station) {
      const c = parkCenter();
      const els = (S.data.subway_elevators || []).filter((e) => validPoint(e) && p.station.test(String(e.station || '')));
      if (!els.length) return null;
      els.sort((a, b) => haversine(c.lat, c.lng, a.lat, a.lng) - haversine(c.lat, c.lng, b.lat, b.lng));
      return { lat: Number(els[0].lat), lng: Number(els[0].lng), label: p.label + ' 엘리베이터' };
    }
    return { lat: p.lat, lng: p.lng, label: p.label };
  }

  function pickOrigin(key) {
    if (!S.data) return;
    if (key === 'gps') { locateMe(true); return; }
    const p = presetPoint(key);
    if (!p) { tempNotice('그 출발지 위치 정보를 찾지 못했어요.', 'warn'); return; }
    setOrigin(p.lat, p.lng, p.label, key);
    // 길안내가 있으면 updateOverlays가 출발지~목적지가 보이게 맞춘다. 없으면 출발지로 이동
    const plan = window.routePlan;
    if (!(plan && plan.stops && plan.stops.length)) {
      S.map.flyTo({ center: ll(p.lat, p.lng), zoom: Math.max(S.map.getZoom(), 16.3), duration: reducedMotion() ? 0 : 900, essential: false });
    }
  }

  // 휴대폰 위치. fromButton이면 공원 밖일 때 안내만 하고 출발지는 그대로 둔다
  function locateMe(fromButton) {
    const keep = () => document.dispatchEvent(new CustomEvent('originchange', {
      detail: { key: S.originKey, label: S.originLabel, lat: S.origin.lat, lng: S.origin.lng } }));
    if (!('geolocation' in navigator)) {
      tempNotice('이 브라우저는 위치 기능이 없어요. 출발지 버튼이나 지도를 눌러 고르세요.');
      if (fromButton) keep();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        if (isInsidePark(lat, lng)) {
          setOrigin(lat, lng, '내 위치', 'gps');
          if (fromButton) S.map.flyTo({ center: ll(lat, lng), zoom: Math.max(S.map.getZoom(), 16.5), duration: reducedMotion() ? 0 : 900 });
        } else {
          tempNotice('지금 공원 밖에 계셔서 내 위치를 쓸 수 없어요. 출발지 버튼(역·정문·주차장)을 골라 주세요.');
          if (fromButton) keep();
        }
      },
      () => {
        tempNotice('위치 정보를 쓸 수 없어요. 출발지 버튼(역·정문·주차장)이나 지도를 눌러 고르세요.');
        if (fromButton) keep();
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }

  // 공유 주소의 출발지: #wheelchair-toilet-from-peacegate 처럼 'from' 다음 낱말 (ui.js의 HASH_ORIGIN과 같은 이름)
  const HASH_ORIGIN = {
    olympicstation: 'olympic-stn', mongchonstation: 'mongchon-stn', hanseongstation: 'hanseong-stn',
    peacegate: 'peace-gate', southparking: 's2-parking', northgate: 'n2-gate',
  };
  function originFromHash(hash) {
    const t = String(hash || '').replace(/^#/, '').toLowerCase().split('-');
    const i = t.indexOf('from');
    return i > -1 && HASH_ORIGIN[t[i + 1]] ? HASH_ORIGIN[t[i + 1]] : null;
  }

  function initLocation() {
    // 공유 주소로 열었으면(#…-from-출발지) 그 출발지에서 시작하고 휴대폰 위치는 묻지 않는다
    // (ui.js가 출발지가 바뀔 때 주소를 고쳐 쓰므로, 기본 출발지를 정하기 전에 먼저 읽어 둔다)
    let want = null;
    try { want = originFromHash(location.hash); } catch (e) { want = null; }
    const c = parkCenter();
    setOrigin(c.lat, c.lng, '공원 중심 (기본값)', 'center');
    if (want && ORIGIN_PRESETS[want]) {
      const p = presetPoint(want);
      if (p) { setOrigin(p.lat, p.lng, p.label, want); return; }
    }
    if (!('geolocation' in navigator)) {
      tempNotice('이 브라우저는 위치 기능이 없어 공원 중심을 기준으로 계산해요.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        if (isInsidePark(lat, lng)) {
          setOrigin(lat, lng, '내 위치', 'gps');
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
    const facType = facTypeOf;
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
      case 'rest': return E.filter((e) => ((e.cat === 'heat' || e.cat === 'cold') && notClosed(shelterStatus(e, now)) && !membersOnly(e)) ||
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
    if (e.cat === 'transit') {
      if (e.kind === 'subway') return e.item.name + '역';
      if (e.kind === 'bus') return e.item.name + ' 정류장';
      return e.item.name;
    }
    return e.item.name || e.title || '';
  }

  function computeRoutePlan(now) {
    const st = ensureAppState();
    const profiles = st.profiles || [];
    S.routeEntries = [];
    if (!S.origin) return null;
    if (currentDest() !== 'all') return computeGuidance(now);   // 가고 싶은 곳을 골랐으면 그곳까지 길안내
    if (!profiles.length) return null;
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
    const basis = (S.walk ? '걷는 길(OpenStreetMap) 기준' : '직선거리 기준') + ' · 분당 ' + speed + 'm 가정';
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
    // 날씨에 맞는 경유지(물 마실 곳·더위/추위/비 피할 곳)를 덜 돌아가는 자리에 끼워 넣는다
    const wx = weatherRouteInfo(profiles, now);
    const path = best.stops.map((s) => ({ e: s.e, need: s.g.need, label: s.g.label }));
    insertWeatherStop(path, wx, profiles);
    return buildPlan(path, {
      profiles: profiles, speed: speed, missing: missing, basis: basis,
      title: '추천 동선', weather: wx,
    });
  }

  // 들를 곳 목록(path: [{e, need, label}]) → window.routePlan 형식. 다리 거리는 앞 장소(첫 곳은 기준 위치)에서 잰다
  function buildPlan(path, o) {
    let pos = S.origin;
    let total = 0;
    const geometry = [[S.origin.lat, S.origin.lng]];
    let allPath = path.length > 0;
    let stepsUsed = false;
    const stops = path.map((x, i) => {
      // 걷는 길 그래프가 있으면 길을 따라 재고, 없거나 길에서 너무 멀면 직선으로 잰다
      const leg = walkLeg(pos, x.e.item, o.profiles);
      const d = leg ? leg.meters : haversine(pos.lat, pos.lng, x.e.item.lat, x.e.item.lng);
      if (leg) {
        leg.coords.slice(1).forEach((c) => geometry.push(c));
        if (leg.steps) stepsUsed = true;
      } else {
        allPath = false;
        geometry.push([x.e.item.lat, x.e.item.lng]);
      }
      total += d;
      pos = x.e.item;
      return {
        step: i + 1, need: x.need, label: x.label, name: entryName(x.e),
        lat: x.e.item.lat, lng: x.e.item.lng, legM: Math.round(d), legMin: Math.max(1, Math.round(d / o.speed)),
        legPath: !!leg,       // true: 걷는 길 기준, false: 직선
      };
    });
    S.routeEntries = path.map((x) => x.e);
    const wx = o.weather || {};
    const pathNotes = [];
    const avoid = stepsMode(o.profiles) === 'avoid';
    if (stepsUsed && avoid) pathNotes.push('계단 없는 길을 찾지 못해 계단이 있는 구간이 들어갔어요. 현장 안내를 확인하세요.');
    if (stops.some((x) => x.legPath) && !allPath) pathNotes.push('일부 구간은 길 데이터가 없어 직선으로 표시했어요.');
    return {
      profiles: o.profiles.slice(),
      title: o.title,                 // '추천 동선' 또는 '길안내' (ui.js가 제목으로 씀)
      dest: o.dest || 'all',
      stops: stops,
      totalM: Math.round(total),
      totalMin: Math.max(1, Math.round(total / o.speed)),
      speed: o.speed,
      missing: o.missing,   // 들르지 못해 뺀 곳. 예: '전동휠체어 충전기 (지금 운영 안 함)'
      basis: o.basis,
      weatherKind: wx.kind || null,   // 'hot' | 'cold' | 'rain' | null
      weatherNotes: wx.notes || [],   // 날씨 때문에 바꾼 점·주의할 점
      pathBased: allPath,             // true면 모든 구간이 걷는 길(OpenStreetMap) 기준
      geometry: geometry,             // 지도에 그릴 선 [[위도, 경도], ...]
      pathNotes: pathNotes,           // 길 관련 주의(계단 등)
      stepsAvoided: avoid && !stepsUsed,
    };
  }

  // ───────────────────── 10-5. 교통 브리핑: 가까운 역·버스·택시 [팀원1 추가] ─────────────────────
  // 종류마다 가까운 곳 2개씩(버스는 같은 이름 정류장은 하나만) 골라 가까운 순으로 보여 주고,
  // 맨 위에 '가장 가까운 역/버스/택시'를 걸어서 몇 분인지 한 줄씩 요약한다(걷는 길 그래프가 있으면 걷는 길 기준).
  function computeTransitList(st) {
    const o = S.origin;
    const pick = (kind, n) => {
      const seen = new Set();
      return S.entries.filter((e) => e.cat === 'transit' && e.kind === kind)
        .map((e) => { const d = distFromOrigin(e.item, st.profiles); return { e: e, m: d.m, path: d.path }; })   // [팀원1 수정] 걷는 길 거리
        .sort((a, b) => a.m - b.m)
        .filter((r) => { const k = r.e.item.name; if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, n);
    };
    const groups = { subway: pick('subway', 2), bus: pick('bus', 2), taxi: pick('taxi', 2) };
    const rows = groups.subway.concat(groups.bus, groups.taxi).sort((a, b) => a.m - b.m);
    S.destEntries = rows.map((r) => r.e);
    const walkText = (r) => {
      const leg = walkLeg(o, r.e.item, st.profiles);
      const m = leg ? leg.meters : r.m;
      return (leg ? '걸어서 ' : '직선 ') + Math.round(m).toLocaleString() + 'm · 약 ' + Math.max(1, Math.round(m / walkSpeed(st.profiles))) + '분';
    };
    const brief = [];
    if (groups.subway[0]) {
      const s = groups.subway[0].e.item;
      brief.push({ icon: '🚇', kind: 'subway', lat: s.lat, lng: s.lng,
        text: '가장 가까운 역: ' + s.name + '역(' + (s.lines || []).join('·') + ') · ' + walkText(groups.subway[0]) +
          (/있음/.test(stationElevatorText(s)) ? ' · 엘리베이터 있음' : '') });
    }
    if (groups.bus[0]) {
      const b = groups.bus[0].e.item;
      brief.push({ icon: '🚌', kind: 'bus', lat: b.lat, lng: b.lng,
        text: '버스: ' + b.name + ' 정류장 · ' + walkText(groups.bus[0]) +
          ((b.routes || []).length ? ' · ' + b.routes.slice(0, 5).join(', ') + '번' : '') });
    }
    if (groups.taxi[0]) {
      const t = groups.taxi[0].e.item;
      brief.push({ icon: '🚕', kind: 'taxi', lat: t.lat, lng: t.lng,
        text: '택시: ' + t.name + '(' + t.road + ') · ' + walkText(groups.taxi[0]) });
    }
    return {
      dest: 'transit',
      label: DESTS.transit.label,
      total: rows.length,
      brief: brief,
      briefNote: '버스 노선은 OpenStreetMap 기준이고, 택시는 공식 승강장이 아니라 큰길과 이어지는 출입구를 추천한 곳이에요.',
      items: rows.map((r) => ({
        name: entryName(r.e),
        lat: r.e.item.lat,
        lng: r.e.item.lng,
        meters: Math.round(r.m),
        pathBased: r.path,        // true: 걷는 길 기준, false: 직선거리 기준 [팀원1 추가]
        walkMin: Math.max(1, Math.round(walkMinutes(r.m, st.profiles))),
        status: null,
        facts: destFacts(r.e, new Date()),
      })),
    };
  }

  // ───────────────────── 12-2. 지도 색 테마: 밝게 / 어둡게 [팀원1 추가] ─────────────────────
  // OpenFreeMap(liberty) 층 이름에 맞춰 색을 바꾼다. 처음 바꾸기 전 원래 값을 기억해 두고, 밝은 테마에서 쓸 값이 없으면 원래 값으로 되돌린다.
  // [층 이름 규칙, 속성, 밝은 값, 어두운 값]
  const MAP_THEME_RULES = [
    [/^background$/, 'background-color', '#f4f1ea', '#121a16'],
    [/^park$/, 'fill-color', '#cfe7c1', '#1b2e22'],
    [/^park_outline$/, 'line-color', '#b9dba6', '#24402e'],
    [/^landcover_grass$/, 'fill-color', '#c2e2ab', '#1d3324'],
    [/^landcover_wood$/, 'fill-color', '#a9d690', '#1a3322'],
    [/^landuse_residential$/, 'fill-color', null, '#191f1c'],
    [/^landuse_(pitch|track|school|cemetery|hospital)$/, 'fill-color', null, '#1e2622'],
    [/^water$/, 'fill-color', '#a7d0f7', '#173450'],
    [/^waterway_/, 'line-color', '#93c3f0', '#1f4a70'],
    [/^(road|bridge|tunnel)_(minor|service_track|street)$/, 'line-color', '#ffffff', '#2b3530'],
    [/^(road|bridge|tunnel)_(minor|service_track|street)_casing$/, 'line-color', '#ded7cc', '#1a201d'],
    [/^(road|bridge|tunnel)_(secondary_tertiary|trunk_primary|link)$/, 'line-color', '#ffefc7', '#4a4330'],
    [/^(road|bridge|tunnel)_(secondary_tertiary|trunk_primary|link|motorway|motorway_link)_casing$/, 'line-color', '#efcf98', '#2a261b'],
    [/^(road|bridge|tunnel)_(motorway|motorway_link)$/, 'line-color', '#ffd9a0', '#5a4a2c'],
    [/^(road|bridge|tunnel)_path_pedestrian$/, 'line-color', '#fffbf2', '#3b4b42'],
    [/^bridge_path_pedestrian_casing$/, 'line-color', null, '#1a201d'],
    [/^(road|bridge|tunnel)_(major|transit)_rail(_hatching)?$/, 'line-color', null, '#4b524e'],
    [/^building$/, 'fill-color', null, '#232a26'],
    [/^road_area_pattern$/, 'fill-opacity', null, 0.12],
    [/^highway-shield/, 'icon-opacity', null, 0.55],
  ];

  function rememberPaint(id, prop) {
    S.origPaint = S.origPaint || {};
    const k = id + '|' + prop;
    if (!(k in S.origPaint)) {
      try { S.origPaint[k] = S.map.getPaintProperty(id, prop); } catch (e) { S.origPaint[k] = undefined; }
    }
    return S.origPaint[k];
  }

  function setPaint(id, prop, value) {
    const orig = rememberPaint(id, prop);
    const v = value === null ? orig : value;
    // 원래 값이 없던 속성은 null로 되돌린다(기본값)
    try { S.map.setPaintProperty(id, prop, v === undefined ? null : v); } catch (e) { /* 그 속성이 없는 층은 건너뛴다 */ }
  }

  function applyMapTheme(dark) {
    if (!S.map || !S.map.getStyle()) return;
    S.dark = !!dark;
    const layers = S.map.getStyle().layers || [];
    const hasOMT = !!(S.map.getStyle().sources || {}).openmaptiles;
    if (!hasOMT) {
      // 대체 2D 타일(래스터)일 때는 밝기만 낮춘다
      layers.filter((l) => l.type === 'raster').forEach((l) => {
        setPaint(l.id, 'raster-brightness-max', dark ? 0.62 : 1);
        setPaint(l.id, 'raster-saturation', dark ? -0.35 : 0);
      });
    } else {
      layers.forEach((l) => {
        MAP_THEME_RULES.forEach(([re, prop, light, darkV]) => {
          if (re.test(l.id)) setPaint(l.id, prop, dark ? darkV : light);
        });
        // 자잘한 가게 이름은 숨겨서 지도를 덜 복잡하게(우리 시설 핀이 잘 보이게)
        if (/^poi_r(7|20)$/.test(l.id)) { try { S.map.setLayoutProperty(l.id, 'visibility', 'none'); } catch (e) { /* 무시 */ } }
        if (l.type === 'symbol') {
          setPaint(l.id, 'text-color', dark ? '#cfe0d6' : null);
          setPaint(l.id, 'text-halo-color', dark ? 'rgba(10, 16, 13, 0.92)' : null);
        }
      });
      (S.extrusionLayers || []).forEach((id) => {
        setPaint(id, 'fill-extrusion-color', dark
          ? ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#29312d', 40, '#323b36', 150, '#3d4742']
          : ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#ece7df', 20, '#e2dbd0', 60, '#d3cabd', 150, '#c4b9aa']);
        setPaint(id, 'fill-extrusion-opacity', dark ? 0.88 : 0.92);
      });
      ['op-park-fill'].forEach((id) => { if (S.map.getLayer(id)) setPaint(id, 'fill-opacity', dark ? 0.12 : 0.07); });
      ['op-park-line'].forEach((id) => { if (S.map.getLayer(id)) setPaint(id, 'line-color', dark ? '#2f9e5b' : '#16a34a'); });
    }
    if (S.map.getLayer('op-route-casing')) setPaint('op-route-casing', 'line-color', dark ? '#0f1512' : '#ffffff');
    if (S.map.getLayer('op-rec-casing')) setPaint('op-rec-casing', 'line-color', dark ? '#0f1512' : '#ffffff');
    try {
      S.map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: dark ? 0.22 : 0.38, position: [1.4, 210, 35] });
      S.map.setSky(dark ? {
        'sky-color': '#0b1622', 'horizon-color': '#1b2b3a', 'fog-color': '#121a16',
        'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0.4,
      } : {
        'sky-color': '#9fd0ff', 'horizon-color': '#e6f2ff', 'fog-color': '#eef3f7',
        'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0.6,
      });
    } catch (e) { /* 하늘 표현을 못 하는 환경이면 건너뛴다 */ }
  }

  function isDarkTheme() { return document.documentElement.getAttribute('data-theme') === 'dark'; }

  // ───────────────────── 10-4. 걷는 길 따라 길찾기 [팀원1 추가] ─────────────────────
  // data/walk_graph.json: OpenStreetMap의 보도·산책로·계단·다리를 점(n)과 선(e)으로 만든 그래프.
  // 시설 위치에서 가장 가까운 길 위의 점으로 붙인 뒤 A* 알고리즘으로 가장 짧은 길을 찾는다.
  // 휠체어·유아차는 계단을 피하고, 오래 못 걷는 동행·임산부는 계단을 3배 길게 쳐서 되도록 피한다.
  const SNAP_MAX_M = 200;      // 시설에서 이보다 먼 길밖에 없으면 그 구간은 직선으로 (가정값)
  const STEP_SLOW_FACTOR = 3;

  function stepsMode(profiles) {
    profiles = profiles || [];
    if (profiles.includes('wheelchair') || profiles.includes('stroller')) return 'avoid';
    if (profiles.includes('elderly') || profiles.includes('pregnant')) return 'slow';
    return 'normal';
  }

  function buildWalkGraph(j) {
    const N = j.n.length / 2;
    const lat = new Float64Array(N);
    const lng = new Float64Array(N);
    for (let i = 0; i < N; i++) { lat[i] = j.n[2 * i] / 1e6; lng[i] = j.n[2 * i + 1] / 1e6; }
    const deg = new Int32Array(N + 1);
    j.e.forEach((e) => { deg[e[0] + 1]++; deg[e[1] + 1]++; });
    for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
    const M = deg[N];
    const to = new Int32Array(M);
    const len = new Float32Array(M);
    const step = new Uint8Array(M);
    const fill = deg.slice(0, N);
    j.e.forEach((e) => {
      const a = e[0], b = e[1], st = e[2] === 1 ? 1 : 0;
      const m = haversine(lat[a], lng[a], lat[b], lng[b]);
      let k = fill[a]++; to[k] = b; len[k] = m; step[k] = st;
      k = fill[b]++; to[k] = a; len[k] = m; step[k] = st;
    });
    return { N: N, lat: lat, lng: lng, off: deg, to: to, len: len, step: step, snapCache: new Map(), legCache: new Map() };
  }

  function loadWalkGraph() {
    fetch(WALK_GRAPH_URL, { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((j) => {
        S.walk = buildWalkGraph(j);
        if (S.data && S.origin) recompute();
      })
      .catch((err) => console.warn('[map.js] 걷는 길 데이터를 못 불러와 길안내를 직선으로 보여 줘요:', err));
  }

  // 가장 가까운 길 위의 점
  function snapNode(p) {
    const W = S.walk;
    const key = p.lat + ',' + p.lng;
    if (W.snapCache.has(key)) return W.snapCache.get(key);
    let best = -1;
    let bestD = Infinity;
    const cosLat = Math.cos(p.lat * Math.PI / 180);
    for (let i = 0; i < W.N; i++) {
      const dy = W.lat[i] - p.lat;
      const dx = (W.lng[i] - p.lng) * cosLat;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    const res = best < 0 ? null : { i: best, m: haversine(p.lat, p.lng, W.lat[best], W.lng[best]) };
    W.snapCache.set(key, res);
    return res;
  }

  // A* 가장 짧은 길. stepFactor: Infinity면 계단 못 지나감
  function astar(s, t, stepFactor) {
    const W = S.walk;
    const g = new Float64Array(W.N).fill(Infinity);
    const prev = new Int32Array(W.N).fill(-1);
    const done = new Uint8Array(W.N);
    const h = (i) => haversine(W.lat[i], W.lng[i], W.lat[t], W.lng[t]);
    const heap = [];     // [f, node]
    const push = (f, n) => {
      heap.push([f, n]);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    g[s] = 0;
    push(h(s), s);
    while (heap.length) {
      const u = pop()[1];
      if (done[u]) continue;
      done[u] = 1;
      if (u === t) break;
      for (let k = W.off[u]; k < W.off[u + 1]; k++) {
        const v = W.to[k];
        if (done[v]) continue;
        const w = W.step[k] ? W.len[k] * stepFactor : W.len[k];
        if (!isFinite(w)) continue;
        const nd = g[u] + w;
        if (nd < g[v]) { g[v] = nd; prev[v] = u; push(nd + h(v), v); }
      }
    }
    if (!isFinite(g[t])) return null;
    const nodes = [];
    for (let v = t; v !== -1; v = prev[v]) nodes.push(v);
    nodes.reverse();
    let meters = 0;
    let steps = false;
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1], b = nodes[i];
      for (let k = W.off[a]; k < W.off[a + 1]; k++) {
        if (W.to[k] === b) { meters += W.len[k]; if (W.step[k]) steps = true; break; }
      }
    }
    return { nodes: nodes, meters: meters, steps: steps };
  }

  // 두 지점 사이 걷는 길: { coords: [[위도, 경도], ...], meters, steps } 또는 null(그래프 없음·길에서 너무 멂·이어진 길 없음)
  function walkLeg(a, b, profiles) {
    if (!S.walk) return null;
    const mode = stepsMode(profiles);
    const ck = a.lat + ',' + a.lng + '>' + b.lat + ',' + b.lng + '|' + mode;
    if (S.walk.legCache.has(ck)) return S.walk.legCache.get(ck);
    const res = walkLegRaw(a, b, mode);
    if (S.walk.legCache.size > 2000) S.walk.legCache.clear();
    S.walk.legCache.set(ck, res);
    return res;
  }

  function walkLegRaw(a, b, mode) {
    const sa = snapNode(a);
    const sb = snapNode(b);
    if (!sa || !sb || sa.m > SNAP_MAX_M || sb.m > SNAP_MAX_M) return null;
    let r = astar(sa.i, sb.i, mode === 'avoid' ? Infinity : mode === 'slow' ? STEP_SLOW_FACTOR : 1);
    if (!r && mode === 'avoid') r = astar(sa.i, sb.i, STEP_SLOW_FACTOR);   // 계단 없는 길이 없으면 계단 포함
    if (!r) return null;
    const W = S.walk;
    const coords = [[a.lat, a.lng]].concat(r.nodes.map((i) => [W.lat[i], W.lng[i]]), [[b.lat, b.lng]]);
    return { coords: coords, meters: sa.m + r.meters + sb.m, steps: r.steps };
  }

  // ───── 10-4-1. 한 곳에서 여러 곳까지 걷는 거리 한꺼번에 재기 [팀원1 추가] ─────
  // 추천 목록·가까운 곳 목록·팝업의 거리도 길안내와 같은 '걷는 길' 기준으로 맞추려고 쓴다.
  // 시작점에서 길 위 모든 점까지 가장 짧은 거리를 한 번에 구하고(다익스트라), 시설마다 꺼내 쓴다.
  // 계단 규칙은 walkLegRaw와 같다(휠체어·유아차는 계단 피함, 계단 없는 길이 없으면 계단 포함 길).
  function makeHeap() {
    const h = [];   // [값, 점 번호]
    return {
      size: () => h.length,
      push(f, n) {
        h.push([f, n]);
        let i = h.length - 1;
        while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; }
      },
      pop() {
        const top = h[0];
        const last = h.pop();
        if (h.length) {
          h[0] = last;
          let i = 0;
          for (;;) {
            const l = 2 * i + 1, r = l + 1;
            let m = i;
            if (l < h.length && h[l][0] < h[m][0]) m = l;
            if (r < h.length && h[r][0] < h[m][0]) m = r;
            if (m === i) break;
            [h[m], h[i]] = [h[i], h[m]]; i = m;
          }
        }
        return top;
      },
    };
  }

  // 결과: 점마다 실제 걷는 거리(m). 길 고르기는 계단 가중치(stepFactor)를 넣어서 한다
  function dijkstra(s, stepFactor) {
    const W = S.walk;
    const cost = new Float64Array(W.N).fill(Infinity);
    const meters = new Float64Array(W.N).fill(Infinity);
    const done = new Uint8Array(W.N);
    const heap = makeHeap();
    cost[s] = 0;
    meters[s] = 0;
    heap.push(0, s);
    while (heap.size()) {
      const u = heap.pop()[1];
      if (done[u]) continue;
      done[u] = 1;
      for (let k = W.off[u]; k < W.off[u + 1]; k++) {
        const v = W.to[k];
        if (done[v]) continue;
        const w = W.step[k] ? W.len[k] * stepFactor : W.len[k];
        if (!isFinite(w)) continue;
        const nd = cost[u] + w;
        if (nd < cost[v]) { cost[v] = nd; meters[v] = meters[u] + W.len[k]; heap.push(nd, v); }
      }
    }
    return meters;
  }

  // from에서 p까지 걷는 거리(m)를 돌려주는 함수. 길 데이터가 없거나 from이 길에서 너무 멀면 null
  function walkDistFrom(from, profiles) {
    if (!S.walk || !from) return null;
    const W = S.walk;
    const mode = stepsMode(profiles);
    const key = from.lat + ',' + from.lng + '|' + mode;
    if (!W.distCache) W.distCache = new Map();
    if (W.distCache.has(key)) return W.distCache.get(key);
    const so = snapNode(from);
    let fn = null;
    if (so && so.m <= SNAP_MAX_M) {
      const main = dijkstra(so.i, mode === 'avoid' ? Infinity : mode === 'slow' ? STEP_SLOW_FACTOR : 1);
      let backup = null;   // 계단 없이 못 가는 곳만 계단 포함 길로 다시 잰다(필요할 때 한 번만)
      fn = (p) => {
        const sp = snapNode({ lat: Number(p.lat), lng: Number(p.lng) });
        if (!sp || sp.m > SNAP_MAX_M) return null;
        let m = main[sp.i];
        if (!isFinite(m) && mode === 'avoid') {
          if (!backup) backup = dijkstra(so.i, STEP_SLOW_FACTOR);
          m = backup[sp.i];
        }
        return isFinite(m) ? so.m + m + sp.m : null;
      };
    }
    if (W.distCache.size > 12) W.distCache.clear();
    W.distCache.set(key, fn);
    return fn;
  }

  // 기준 위치(또는 from)에서 p까지: { m: 거리(m), path: true(걷는 길) | false(길을 못 찾아 직선거리) }
  function distFromOrigin(p, profiles, from) {
    const o = from || S.origin;
    const f = walkDistFrom(o, profiles);
    const m = f ? f(p) : null;
    if (m !== null) return { m: m, path: true };
    return { m: haversine(o.lat, o.lng, Number(p.lat), Number(p.lng)), path: false };
  }

  // ───────────────────── 10-3. 가고 싶은 곳 + 날씨 맞춤 길안내 [팀원1 추가] ─────────────────────
  // 1) 상황을 고른 뒤 '어디 가요?'에서 시설 종류를 고르면, 지도에는 그 종류만 남기고
  //    목록에는 가까운 순으로 필요한 정보만 보여 준다(window.destList). 화장실은 원래 추천 목록을 그대로 쓴다.
  // 2) 1순위(또는 목록에서 누른 곳)까지 길안내(window.routePlan)를 만든다.
  // 3) 날씨에 따라 가는 길에 들를 곳을 하나 넣는다(덜 돌아가는 곳만). 모두 직선거리 기준이다.
  //    - 비: 비 피할 실내 시설  - 체감 33° 이상: 음수대·무더위쉼터·실내 매점  - 체감 0° 이하: 한파쉼터·실내 매점
  //    - 자외선 6 이상: 경유지를 늘리지 않고 짧은 길을 쓴다(그늘 정보는 데이터에 없음)
  const INDOOR_SHOP_RE = /편의점|매점|식음|카페|스낵/;
  const WATER_RE = /음수/;
  const DEST_LIST_MAX = 5;
  const WEATHER_ROUTE = {
    hotFeelsLike: 33,       // rules.json의 더위 기준과 같게
    coldFeelsLike: 0,       // rules.json의 추위 기준과 같게
    uvHigh: 6,              // rules.json의 자외선 기준과 같게
    maxDetourM: 400,        // 경유지 때문에 더 걷는 거리 최대(가정값)
    minDetourM: 150,        // 가까운 목적지라도 이만큼은 돌아가도 된다고 본다(가정값)
    detourRatio: 0.6,       // 원래 거리의 60%까지 더 걸어도 된다고 본다(가정값)
  };

  function facTypeOf(e) { return String((e.item && e.item.type) || ''); }

  const DESTS = {
    toilet: { label: '화장실', match: (e) => e.cat === 'toilet' },
    rest: { label: '쉴 곳(쉼터)', match: (e) => restKinds().includes(e.cat) },
    shop: { label: '매점·자판기', match: (e) => e.cat === 'facility' && CONCERT_FACILITY_RE.test(facTypeOf(e)) },
    water: { label: '음수대', match: (e) => e.cat === 'facility' && WATER_RE.test(facTypeOf(e)) },
    charger: { label: '전동휠체어 충전기', match: (e) => e.cat === 'charger' },
    elevator: { label: '지하철 엘리베이터', match: (e) => e.cat === 'elevator' },
    aed: { label: 'AED(자동심장충격기)', match: (e) => e.cat === 'aed' },
    transit: { label: '역·버스·택시', match: (e) => e.cat === 'transit' },
  };

  const TRANSIT_TYPE_LABEL = { subway: '지하철역', bus: '버스정류장', taxi: '택시 타기 좋은 곳' };

  // 지하철역 근처(300m)에 엘리베이터 데이터가 있는지
  function stationElevatorText(st) {
    const els = (S.data.subway_elevators || []).filter((e) => validPoint(e) &&
      String(e.station || '').indexOf(st.name) > -1 && haversine(st.lat, st.lng, Number(e.lat), Number(e.lng)) < 300);
    return els.length ? '있음 (' + els.length + '곳)' : '데이터 없음';
  }

  // 한파쉼터 중 '특정인'(회원만) 이용하는 곳
  function membersOnly(e) { return e.cat === 'cold' && /특정/.test(String(e.item.who || '')); }

  // '쉴 곳'에서 보여 줄 쉼터: 더운 날은 무더위쉼터, 추운 날은 한파쉼터, 그 사이면 둘 다
  function restKinds() {
    const w = (window.conditionInfo || {}).weather || {};
    const fl = num(w.feelsLike);
    if (fl !== null && fl >= 25) return ['heat'];
    if (fl !== null && fl <= 10) return ['cold'];
    return ['heat', 'cold'];
  }

  function currentDest() {
    const d = ensureAppState().destination;
    return DESTS[d] ? d : 'all';
  }

  // 지도에 보일지: 레이어가 켜져 있고, 가고 싶은 곳 종류이거나 길안내에 들어간 곳
  function entryShown(e) {
    const layer = S.layers[e.layerKey];
    if (!layer || !layer.visible) return false;
    const d = currentDest();
    if (d === 'all') return true;
    if (d === 'transit') {
      // 버스정류장이 많아서, 브리핑에 든 곳·길안내 경유지·지하철역만 보여 준다
      return (S.destEntries || []).includes(e) || (S.routeEntries || []).includes(e) || e.kind === 'subway';
    }
    return DESTS[d].match(e) || (S.routeEntries || []).includes(e);
  }

  function applyVisibility() {
    S.entries.forEach((e) => {
      const show = entryShown(e);
      const disp = show ? '' : 'none';
      if (e.el.style.display !== disp) e.el.style.display = disp;
      if (!show && S.popupEntry === e && S.popup && S.popup.isOpen()) S.popup.remove();
    });
  }

  // 가고 싶은 곳을 새로 골랐을 때: 그 종류가 든 레이어를 켜고(쉼터·AED는 처음에 꺼져 있음) 직접 고른 목적지는 지운다
  function onDestinationChange() {
    const d = currentDest();
    if (d !== S.lastDest) S.destTarget = null;
    S.lastDest = d;
    if (d !== 'all') {
      Object.keys(S.layers).forEach((k) => {
        if (S.layers[k].entries.some((e) => DESTS[d].match(e))) showLayer(k);
      });
    }
    recompute();
  }

  // true(운영 중) / false(운영 안 함) / null(모름) / undefined(운영시간이 없는 종류)
  function entryOpenStatus(e, now) {
    switch (e.cat) {
      case 'toilet': return toiletOpenNow(e.item, now);
      case 'heat': case 'cold': return shelterStatus(e, now);
      case 'charger': return chargerOpenNow(e.item, now);
      default: return undefined;
    }
  }

  // 목록에 보여 줄 '필요한 정보'만 짧게
  function destFacts(e, now) {
    const it = e.item;
    const f = [];
    const add = (v) => { if (v !== null && v !== undefined && String(v).trim()) f.push(String(v).trim()); };
    switch (e.cat) {
      case 'heat':
        add('무더위쉼터' + (it.facility ? ' · ' + it.facility : ''));
        add([it.days, hoursToText(it.hours)].filter(Boolean).join(' '));
        break;
      case 'cold':
        add('한파쉼터' + (it.facility ? ' · ' + it.facility : ''));
        if (it.who) add(/누구나/.test(it.who) ? '누구나 이용' : '이용 대상: ' + it.who);
        if (/경보/.test(String(it.note || ''))) add('한파 경보 때만 운영');
        break;
      case 'charger':
        add(it.detail);
        add((isHolidayLike(now) ? '오늘(휴일) ' + hoursToText(it.holiday) : '오늘(평일) ' + hoursToText(it.weekday)));
        if (num(it.slots) !== null) add('동시 ' + num(it.slots) + '대');
        break;
      case 'elevator':
        add((it.station || '지하철역') + ' 엘리베이터');
        break;
      case 'aed':
        add(it.detail);
        if (aedUnsure(it)) add('지도 위치가 실제와 다를 수 있음');
        break;
      case 'transit':
        if (e.kind === 'subway') {
          add('🚇 ' + (it.lines || []).join('·'));
          if (/있음/.test(stationElevatorText(it))) add('엘리베이터 있음');
          if ((it.exits || []).length) add('출구 ' + it.exits.join(',') + '번');
        } else if (e.kind === 'bus') {
          add('🚌 버스정류장');
          add((it.routes || []).length ? it.routes.slice(0, 6).join(', ') + (it.routes.length > 6 ? ' 외' : '') : '노선 정보 없음');
        } else {
          add('🚕 택시 타기 좋은 곳');
          add(it.road);
          add(it.why);
        }
        break;
      default:
        add(it.type);
        add(it.detail);
    }
    const pd = num(it.dist_from_park_m);
    if (pd !== null && pd > OUTSIDE_PARK_M / 3) add('공원 밖 약 ' + Math.round(pd).toLocaleString() + 'm');
    return f;
  }

  // 화장실이 아닌 곳: 가까운 순(운영 안 하는 곳은 뒤로) 최대 5곳
  function computeDestList(now) {
    const d = currentDest();
    S.destEntries = [];
    if (d === 'all') return null;
    const st = ensureAppState();
    if (d === 'toilet') {
      const keys = new Set((window.recommendations || []).map((r) => r.lat + ',' + r.lng));
      S.destEntries = S.entries.filter((e) => e.cat === 'toilet' && keys.has(e.item.lat + ',' + e.item.lng));
      return { dest: d, label: DESTS[d].label, items: null };  // 목록은 ui.js가 window.recommendations로 그린다
    }
    if (d === 'transit') return computeTransitList(st);
    const rows = S.entries.filter((e) => DESTS[d].match(e)).map((e) => {
      const dist = distFromOrigin(e.item, st.profiles);   // [팀원1 수정] 걷는 길 거리(길을 못 찾으면 직선)
      return { e: e, m: dist.m, path: dist.path, status: entryOpenStatus(e, now) };
    });
    // 운영 안 하는 곳, 회원만 이용하는 쉼터, 좌표가 의심스러운 AED는 뒤로
    const later = (r) => (r.status === false ? 2 : 0) + (membersOnly(r.e) ? 1 : 0) + (r.e.cat === 'aed' && aedUnsure(r.e.item) ? 1 : 0);
    rows.sort((a, b) => later(a) - later(b) || a.m - b.m);
    const top = rows.slice(0, DEST_LIST_MAX);
    // 응급 화면 등에서 직접 고른 목적지가 목록 밖이면 끝에 붙여 길안내가 되게 한다
    if (S.destTarget && !top.some((r) => r.e.item.lat + ',' + r.e.item.lng === S.destTarget)) {
      const extra = rows.find((r) => r.e.item.lat + ',' + r.e.item.lng === S.destTarget);
      if (extra) top.push(extra);
    }
    S.destEntries = top.map((r) => r.e);
    return {
      dest: d,
      label: DESTS[d].label,
      total: rows.length,
      items: top.map((r) => ({
        name: entryName(r.e),
        lat: r.e.item.lat,
        lng: r.e.item.lng,
        meters: Math.round(r.m),
        pathBased: r.path,        // true: 걷는 길 기준, false: 직선거리 기준 [팀원1 추가]
        walkMin: Math.max(1, Math.round(walkMinutes(r.m, st.profiles))),
        status: r.status === true ? 'open' : r.status === false ? 'closed' : r.status === null ? 'unknown' : null,
        facts: destFacts(r.e, now),
      })),
    };
  }

  // 오늘 날씨에 맞는 경유지 후보와 안내 문구
  function weatherRouteInfo(profiles, now) {
    const ci = window.conditionInfo || {};
    const w = ci.weather || {};
    const fl = num(w.feelsLike);
    const uv = num(w.uv);
    const rain = w.rain === true;
    const notOff = (e) => entryOpenStatus(e, now) !== false;
    const isShop = (e) => e.cat === 'facility' && INDOOR_SHOP_RE.test(facTypeOf(e));
    const info = { kind: null, cands: [], labelOf: null, notes: [] };
    if (!ci.weather) return info;
    if (rain) {
      info.kind = 'rain';
      info.cands = S.entries.filter((e) => isShop(e) || ((e.cat === 'heat' || e.cat === 'cold') && notOff(e) && !membersOnly(e)));
      info.labelOf = (e) => (isShop(e) ? '비 피할 곳(매점)' : '비 피할 곳(쉼터 건물)');
      info.notes.push('비 소식이 있어요. 가는 길에 잠깐 비를 피할 수 있는 매점·쉼터를 넣었어요.');
      if (profiles.some((p) => p === 'wheelchair' || p === 'stroller')) info.notes.push('젖은 경사로·내리막은 미끄러울 수 있어요. 천천히 이동하세요.');
    } else if (fl !== null && fl >= WEATHER_ROUTE.hotFeelsLike) {
      info.kind = 'hot';
      info.cands = S.entries.filter((e) => (e.cat === 'facility' && WATER_RE.test(facTypeOf(e))) || isShop(e) ||
        (e.cat === 'heat' && notOff(e)));
      info.labelOf = (e) => (WATER_RE.test(facTypeOf(e)) ? '물 마실 곳(음수대)' :
        e.cat === 'heat' ? '더위 피할 곳(무더위쉼터)' : '시원한 음료 살 곳(매점)');
      info.notes.push('체감 ' + Math.round(fl) + '°로 더워요. 가는 길에 물 마시거나 더위를 피할 곳을 넣었어요.');
    } else if (fl !== null && fl <= WEATHER_ROUTE.coldFeelsLike) {
      info.kind = 'cold';
      info.cands = S.entries.filter((e) => isShop(e) || (e.cat === 'cold' && !membersOnly(e)));
      info.labelOf = (e) => (e.cat === 'cold' ? '몸 녹일 곳(한파쉼터)' : '따뜻한 음료 살 곳(매점)');
      info.notes.push('체감 ' + Math.round(fl) + '°로 추워요. 가는 길에 몸을 녹이거나 따뜻한 음료를 살 곳을 넣었어요.');
    }
    if (!rain && uv !== null && uv >= WEATHER_ROUTE.uvHigh) {
      info.notes.push('자외선이 강해요(지수 ' + uv + '). 햇빛 아래 오래 걷지 않게 덜 돌아가는 길로 골랐어요. 그늘 정보는 데이터에 없어요.');
    }
    if (!info.kind && !info.notes.length) {
      const parts = [];
      if (fl !== null) parts.push('체감 ' + Math.round(fl) + '°');
      parts.push('비 소식 없음');
      info.notes.push('오늘 날씨(' + parts.join(', ') + ')로는 따로 들를 곳이 없어요.');
    }
    return info;
  }

  // 경유지 하나를 '덜 돌아가는 자리'에 넣는다. 너무 많이 돌아가야 하면 넣지 않고 안내만 남긴다
  function insertWeatherStop(path, wx, profiles) {
    if (!wx.kind || !path.length) return;
    const used = new Set(path.map((x) => x.e));
    const pts = [S.origin].concat(path.map((x) => x.e.item));
    const limitOf = (direct) => Math.min(WEATHER_ROUTE.maxDetourM, Math.max(WEATHER_ROUTE.minDetourM, direct * WEATHER_ROUTE.detourRatio));
    // 1) 직선으로 덜 돌아가는 후보를 먼저 고르고
    const near = [];
    wx.cands.forEach((e) => {
      if (used.has(e)) return;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const direct = haversine(a.lat, a.lng, b.lat, b.lng);
        const extra = haversine(a.lat, a.lng, e.item.lat, e.item.lng) + haversine(e.item.lat, e.item.lng, b.lat, b.lng) - direct;
        if (extra <= limitOf(direct)) near.push({ e: e, at: i, extra: extra });
      }
    });
    near.sort((x, y) => x.extra - y.extra);
    // 2) 걷는 길이 있으면 실제로 걸어서 덜 돌아가는지 다시 잰다 (강·호수 건너편 후보를 거른다)
    let best = null;
    if (S.walk) {
      const legM = (a, b) => { const l = walkLeg(a, b, profiles); return l ? l.meters : null; };
      near.slice(0, 8).forEach((c) => {
        const a = pts[c.at];
        const b = pts[c.at + 1];
        const direct = legM(a, b);
        const viaA = legM(a, c.e.item);
        const viaB = legM(c.e.item, b);
        if (direct === null || viaA === null || viaB === null) return;
        const extra = viaA + viaB - direct;
        if (extra <= limitOf(direct) && (!best || extra < best.extra)) best = { e: c.e, at: c.at, extra: extra };
      });
    } else {
      best = near[0] || null;
    }
    if (!best) {
      wx.notes.push('가는 길 가까이에 들를 만한 곳이 없어 경유지는 넣지 않았어요.');
      return;
    }
    path.splice(best.at, 0, { e: best.e, need: 'weather', label: wx.labelOf(best.e) });
    if (best.extra >= 30) wx.notes.push('경유지 때문에 약 ' + Math.round(best.extra).toLocaleString() + 'm 더 걸어요.');
  }

  // 가고 싶은 곳까지 길안내: 목록에서 누른 곳, 없으면 1순위
  function computeGuidance(now) {
    const st = ensureAppState();
    const profiles = st.profiles || [];
    const d = currentDest();
    const speed = walkSpeed(profiles);
    const basis = (S.walk ? '걷는 길(OpenStreetMap) 기준' : '직선거리 기준') + ' · 분당 ' + speed + 'm 가정';
    const key = (e) => e.item.lat + ',' + e.item.lng;
    const pool = S.destEntries || [];
    let target = S.destTarget ? pool.find((e) => key(e) === S.destTarget) : null;
    if (!target && d === 'toilet') {
      const r0 = (window.recommendations || [])[0];
      if (r0) target = pool.find((e) => key(e) === r0.lat + ',' + r0.lng) || null;
    }
    if (!target) target = pool.find((e) => entryOpenStatus(e, now) !== false && !membersOnly(e)) ||
      pool.find((e) => entryOpenStatus(e, now) !== false) || null;
    const label = d === 'toilet' ? toiletNeedLabel(profiles) : d === 'transit' ? TRANSIT_TYPE_LABEL[target ? target.kind : 'subway'] : DESTS[d].label;
    const wx = weatherRouteInfo(profiles, now);
    if (!target) {
      return buildPlan([], {
        profiles: profiles, speed: speed, basis: basis, title: '길안내', dest: d, weather: { kind: null, notes: [] },
        missing: [label + (pool.length ? ' (지금 운영 안 함)' : ' (조건에 맞는 곳 없음)')],
      });
    }
    const path = [{ e: target, need: 'dest', label: label }];
    // AED는 급하게 가는 곳이라 날씨 경유지(음수대·쉼터)를 넣지 않는다 [팀원1 추가]
    if (d !== 'aed') insertWeatherStop(path, wx, profiles);
    else wx.notes = [];
    return buildPlan(path, { profiles: profiles, speed: speed, missing: [], basis: basis, title: '길안내', dest: d, weather: wx });
  }

  // ───────────────────── 10-6. 응급 화면: 지금 위치 설명 + 가까운 AED [팀원1 추가] ─────────────────────
  // ui.js가 응급 버튼을 누르면 'emergencyopen'을 보낸다. 여기서 휴대폰 위치(GPS)를 새로 받아
  //   window.emergencyInfo = { status, lat, lng, accuracy, placeText, far, basis, aeds:[{ name, detail, lat, lng, meters, walkMin, pathBased, count }] }
  // 를 채우고 'emergencyready'를 보낸다. status: 'locating'(위치 받는 중) | 'ok' | 'nogps'(위치 못 받음) | 'nodata'(시설 데이터 전)
  // 위치를 받기 전에도 지금 기준 위치로 AED를 먼저 찾아 한 번 보낸다(기다리지 않게).
  // 기준점 좌표: 출입문·역은 출발지 버튼·transit.json(OpenStreetMap)과 같은 값,
  //             경기장·광장은 KSPO 편의시설 데이터에서 그 장소 이름이 붙은 지점들의 평균 위치.
  const EMERGENCY_LANDMARKS = [
    { name: '평화의문(정문)', kind: 'gate', lat: 37.518313, lng: 127.115394 },
    { name: '남2문', kind: 'gate', lat: 37.51449, lng: 127.12197 },
    { name: '북2문', kind: 'gate', lat: 37.524095, lng: 127.128041 },
    { name: '올림픽공원역', kind: 'station', lat: 37.516148, lng: 127.13093 },
    { name: '몽촌토성역', kind: 'station', lat: 37.517533, lng: 127.11267 },
    { name: '한성백제역', kind: 'station', lat: 37.51667, lng: 127.116213 },
    { name: 'KSPO DOME(체조경기장)', kind: 'place', lat: 37.51932, lng: 127.127041 },
    { name: 'SK핸드볼경기장', kind: 'place', lat: 37.517703, lng: 127.126494 },
    { name: '올림픽홀', kind: 'place', lat: 37.515154, lng: 127.127099 },
    { name: '우리금융아트홀', kind: 'place', lat: 37.517467, lng: 127.125023 },
    { name: '올림픽수영경기장', kind: 'place', lat: 37.520654, lng: 127.126685 },
    { name: '올림픽테니스장', kind: 'place', lat: 37.514955, lng: 127.128647 },
    { name: '벨로드롬(사이클경기장)', kind: 'place', lat: 37.517498, lng: 127.123861 },
    { name: '소마미술관', kind: 'place', lat: 37.516819, lng: 127.118666 },
    { name: '한성백제박물관', kind: 'place', lat: 37.515572, lng: 127.120615 },
    { name: '평화의 광장', kind: 'place', lat: 37.518447, lng: 127.116531 },
    { name: '88호수', kind: 'place', lat: 37.520612, lng: 127.125612 },
    { name: '88마당', kind: 'place', lat: 37.518674, lng: 127.125067 },
    { name: '나홀로나무', kind: 'place', lat: 37.522295, lng: 127.119424 },
    { name: '몽촌역사관', kind: 'place', lat: 37.524139, lng: 127.124125 },
    { name: '만남의광장', kind: 'place', lat: 37.516885, lng: 127.129675 },
    { name: '장미광장', kind: 'place', lat: 37.512982, lng: 127.127438 },
    { name: '가족놀이동산', kind: 'place', lat: 37.523186, lng: 127.1229 },
    { name: '몽촌해자', kind: 'place', lat: 37.519794, lng: 127.116541 },
  ];
  const DIR_WORDS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
  const LANDMARK_RIGHT_HERE_M = 60;   // 이보다 가까우면 '바로 앞'
  const LANDMARK_NEAR_M = 250;        // 이보다 가까운 경기장·광장은 '○○ 근처'로 덧붙인다
  const LANDMARK_FAR_M = 1500;        // 가장 가까운 기준점도 이보다 멀면 공원 밖으로 본다

  function aedUnsure(it) {
    if (AED_UNSURE_COORDS.includes(Number(it.lat) + ',' + Number(it.lng))) return true;
    const text = String(it.name || '') + ' ' + String(it.detail || '');
    return AED_PLACE_CHECK.some(([re, lat, lng]) => re.test(text) && haversine(Number(it.lat), Number(it.lng), lat, lng) > AED_PLACE_MISMATCH_M);
  }

  function roughMeters(m) {
    if (m >= 1000) return (Math.round(m / 100) / 10) + 'km';
    if (m < 100) return Math.max(10, Math.round(m / 10) * 10) + 'm';
    return Math.round(m / 50) * 50 + 'm';
  }

  // 기준점에서 본 방향(8방위)
  function dirWord(from, to) {
    const dy = to.lat - from.lat;
    const dx = (to.lng - from.lng) * Math.cos(from.lat * Math.PI / 180);
    const deg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    return DIR_WORDS[Math.round(deg / 45) % 8];
  }

  // "평화의문(정문)에서 북동쪽으로 약 200m, 소마미술관 근처" 같은 문장
  function describeLocation(lat, lng) {
    const me = { lat: lat, lng: lng };
    const rows = EMERGENCY_LANDMARKS.map((l) => ({ l: l, d: haversine(lat, lng, l.lat, l.lng) })).sort((a, b) => a.d - b.d);
    if (!rows.length) return { text: '', far: true };
    if (rows[0].d > LANDMARK_FAR_M) {
      return { text: '올림픽공원에서 떨어진 곳이에요(가장 가까운 ' + rows[0].l.name + '에서 약 ' + roughMeters(rows[0].d) + '). 주변 큰 건물이나 도로 이름을 함께 알려 주세요.', far: true };
    }
    const anchor = rows.find((r) => r.l.kind !== 'place');
    const place = rows.find((r) => r.l.kind === 'place');
    const parts = [];
    if (anchor.d <= LANDMARK_RIGHT_HERE_M) parts.push(anchor.l.name + ' 바로 앞');
    else parts.push(anchor.l.name + '에서 ' + dirWord(anchor.l, me) + '쪽으로 약 ' + roughMeters(anchor.d));
    if (place && place.d <= LANDMARK_NEAR_M) parts.push(place.l.name + (place.d <= LANDMARK_RIGHT_HERE_M ? ' 바로 앞' : ' 근처'));
    const text = parts.join(', ');
    return { text: /^올림픽공원/.test(text) ? text : '올림픽공원 ' + text, far: false };
  }

  // 가까운 AED: 같은 좌표(같은 건물)는 한 곳으로 묶고, 좌표가 의심스러운 곳은 뺀다. 거리는 걷는 길(계단 포함) 기준
  function nearestAeds(from) {
    const groups = new Map();
    (S.data.aed || []).filter(validPoint).forEach((a) => {
      if (aedUnsure(a)) return;
      const k = Number(a.lat) + ',' + Number(a.lng);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    });
    const rows = [];
    groups.forEach((list) => {
      const a = list[0];
      const dist = distFromOrigin(a, [], from);
      rows.push({
        name: a.name || 'AED',
        detail: String(a.detail || '').replace(/\s+/g, ' ').trim() + (list.length > 1 ? ' 외 같은 건물에 ' + (list.length - 1) + '대 더' : ''),
        lat: Number(a.lat), lng: Number(a.lng),
        meters: Math.round(dist.m), pathBased: dist.path,
        walkMin: Math.max(1, Math.round(dist.m / SPEED_NORMAL)),
        count: list.length,
      });
    });
    rows.sort((x, y) => x.meters - y.meters);
    return rows.slice(0, EMERGENCY_AED_COUNT);
  }

  function sendEmergency(info) {
    window.emergencyInfo = info;
    document.dispatchEvent(new CustomEvent('emergencyready', { detail: { emergencyInfo: info } }));
  }

  function emergencyFromOrigin(status) {
    const label = (S.originLabel || '공원 중심').replace(/\s*\(기본값\)/, '');
    return {
      status: status,
      basis: '출발 위치(' + label + ') 기준',
      aeds: S.data && S.origin ? nearestAeds(S.origin) : [],
    };
  }

  function onEmergencyOpen() {
    S.emergencyWanted = true;
    if (!S.data || !S.origin) { sendEmergency({ status: 'nodata', aeds: [] }); return; }   // 데이터가 오면 다시 부른다
    S.emergencyWanted = false;
    sendEmergency(emergencyFromOrigin('locating'));
    if (!('geolocation' in navigator)) { sendEmergency(emergencyFromOrigin('nogps')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const where = describeLocation(lat, lng);
        S.emergencyGps = { lat: lat, lng: lng };
        sendEmergency({
          status: 'ok', lat: lat, lng: lng, accuracy: Math.round(pos.coords.accuracy || 0),
          placeText: where.text, far: where.far,
          basis: '내 위치 기준',
          aeds: nearestAeds({ lat: lat, lng: lng }),
        });
      },
      () => { S.emergencyGps = null; sendEmergency(emergencyFromOrigin('nogps')); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  // 응급 화면에서 'AED까지 길 보기': 내 위치(받았으면)에서 그 AED까지 길안내. ui.js가 먼저 목적지를 'AED'로 바꾼다
  function onEmergencyRoute(lat, lng) {
    if (!S.data) return;
    const k = Number(lat) + ',' + Number(lng);
    S.destTarget = k;
    S.lastDest = 'aed';
    const g = S.emergencyGps;
    if (g) setOrigin(g.lat, g.lng, '내 위치', 'gps');   // 안에서 recompute()
    else recompute();
    const target = S.entries.find((e) => e.cat === 'aed' && e.item.lat + ',' + e.item.lng === k);
    if (target) openEntryPopup(target, true);
  }

  // ───────────────────── 11. 추천 + 강조 다시 계산 ─────────────────────
  function recompute() {
    if (!S.data || !S.origin) return;
    const st = ensureAppState();
    const now = new Date();

    // (1) 화장실 추천
    window.recommendations = computeRecommendations(S.data.toilets, S.origin, st.profiles, st.filters, now,
      (t) => distFromOrigin(t, st.profiles));   // [팀원1 수정] 걷는 길 거리로 점수·도보 시간 계산
    // (1-1) 가고 싶은 곳 목록 (화장실이 아니면 가까운 순, 필요한 정보만)
    window.destList = computeDestList(now);
    // (1-2) 추천 동선(들를 곳 순서) 또는 가고 싶은 곳까지 길안내. 상황도 목적지도 없으면 null
    window.routePlan = computeRoutePlan(now);
    applyVisibility();
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

    // 가고 싶은 곳을 골랐으면: 목록에 든 곳과 길안내 경유지만 강조하고 같은 종류의 나머지는 흐리게
    const destMode = currentDest() !== 'all';
    const hiSet = destMode ? new Set((S.destEntries || []).concat(S.routeEntries || [])) : hi;

    // 아이콘 클래스 적용: 강조 'mk-highlight', 프로필이 있을 때 나머지는 'mk-dim' (팀원3 style.css 약속)
    S.entries.forEach((e) => {
      const state = hiSet.has(e) ? 'mk-highlight' : (profiles.length || destMode) ? 'mk-dim' : '';
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
    // 추천 동선·길안내 선: 은은한 빛 + 흰 테두리 + 출발(파랑)→도착(분홍) 색이 이어지는 선
    S.map.addSource('op-route', { type: 'geojson', data: emptyFC(), lineMetrics: true });
    S.map.addLayer({ id: 'op-route-glow', type: 'line', source: 'op-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ROUTE_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 18], 'line-opacity': 0.18, 'line-blur': 6 } }, before);
    S.map.addLayer({ id: 'op-route-casing', type: 'line', source: 'op-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 6, 18, 11], 'line-opacity': 0.95 } }, before);
    S.map.addLayer({ id: 'op-route-line', type: 'line', source: 'op-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 3.5, 18, 6.5],
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#2563eb', 0.5, '#9333ea', 1, ROUTE_COLOR] } }, before);
    S.overlayReady = true;
    applyMapTheme(isDarkTheme());
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
    // 걷는 길 그래프가 있으면 길을 따라 그린 선(plan.geometry), 없으면 들를 곳을 잇는 직선
    const routeCoords = hasRoute ? (plan.geometry && plan.geometry.length > 1 ? plan.geometry.map((c) => ll(c[0], c[1]))
      : [ll(S.origin.lat, S.origin.lng)].concat(plan.stops.map((x) => ll(x.lat, x.lng)))) : [];
    S.map.getSource('op-route').setData(hasRoute ? {
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: routeCoords },
    } : emptyFC());
    // 동선이 있으면 화장실 연결선은 숨겨 지도를 덜 복잡하게
    const dNow = currentDest();
    const hideRecLines = hasRoute || (dNow !== 'all' && dNow !== 'toilet');
    ['op-rec-casing', 'op-rec-line'].forEach((id) => S.map.setLayoutProperty(id, 'visibility', hideRecLines ? 'none' : 'visible'));
    // 들를 곳이 바뀌었을 때만, 기준 위치와 들를 곳이 모두 보이게 지도를 맞춘다
    const routeKey = hasRoute ? S.origin.lat + ',' + S.origin.lng + '>' + plan.stops.map((x) => x.lat + ',' + x.lng).join('|') + (plan.pathBased ? '|p' : '') : '';
    if (hasRoute && routeKey !== S.lastRouteKey) {
      const b = new maplibregl.LngLatBounds(ll(S.origin.lat, S.origin.lng), ll(S.origin.lat, S.origin.lng));
      routeCoords.forEach((c) => b.extend(c));
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
  // 가고 싶은 곳을 고른 상태에서 목록의 다른 곳을 누르면, 그곳을 목적지로 길안내를 다시 만든다
  function onFocusPlace(lat, lng) {
    const d = currentDest();
    const k = Number(lat) + ',' + Number(lng);
    const target = d !== 'all' ? (S.destEntries || []).find((e) => e.item.lat + ',' + e.item.lng === k) : null;
    const curTarget = (S.routeEntries || []).slice(-1)[0];
    if (target && target !== curTarget) {
      S.destTarget = k;
      recompute();                       // 새 길안내에 맞게 지도를 맞춘다(fitBounds)
      openEntryPopup(target, true);
      return;
    }
    focusPlace(lat, lng);
  }

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
    const d = await res.json();
    // 교통 데이터는 없어도 지도는 동작한다
    d.transit = await fetch(TRANSIT_URL, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    return d;
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
    // 날씨가 오면 길안내 경유지도 바뀌므로 전부 다시 계산한다(데이터 전이면 recompute가 그냥 돌아간다)
    document.addEventListener('conditionready', () => { if (S.data && S.origin) recompute(); });
    document.addEventListener('destinationchange', () => { if (S.data && S.origin) onDestinationChange(); });
    document.addEventListener('originpick', (e) => { const d = (e && e.detail) || {}; if (S.data && S.origin) pickOrigin(d.key); });
    document.addEventListener('themechange', (e) => { const d = (e && e.detail) || {}; if (S.overlayReady) applyMapTheme(d.theme === 'dark'); });
    document.addEventListener('focusplace', (e) => { const d = (e && e.detail) || {}; if (S.data) onFocusPlace(d.lat, d.lng); });
    document.addEventListener('emergencyopen', onEmergencyOpen);                       // [팀원1 추가] 응급 화면
    document.addEventListener('emergencyroute', (e) => { const d = (e && e.detail) || {}; onEmergencyRoute(d.lat, d.lng); });

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
    loadWalkGraph();   // 걷는 길 그래프는 따로 불러온다(늦게 와도 오면 다시 계산)
    if (isDemo() && S.data && S.data.meta && S.data.meta.is_mock) {
      setNotice('demo', '미리보기용 가상 데이터예요. 실제 시설 위치·정보가 아니에요.', 'demo');
    }

    buildLayers(S.data);

    // 지도(빈 곳)를 누르면 기준 위치를 옮긴다. 핀을 누른 경우는 빼고.
    S.map.on('click', (e) => {
      const t = e.originalEvent && e.originalEvent.target;
      if (t && t.closest && t.closest('.maplibregl-marker')) return;
      setOrigin(e.lngLat.lat, e.lngLat.lng, '지도에서 고른 위치', 'custom');
    });
    initLocation(); // 안에서 recompute()가 불린다
    if (S.emergencyWanted) onEmergencyOpen();   // 데이터가 오기 전에 응급 화면을 열었으면 지금 다시 찾는다
    // 공유 링크로 '가고 싶은 곳'이 정해져 왔으면 그 종류 레이어를 켜고 길안내를 만든다
    if (currentDest() !== 'all') onDestinationChange();

    // '직접 찾아가기' 게임 모드(game.js)는 지도·데이터가 준비된 뒤 불러온다. 없거나 실패해도 지도는 그대로 동작
    loadScript('game.js').catch((err) => console.warn('[map.js] game.js를 불러오지 못했어요(게임 모드만 빠져요):', err));

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
