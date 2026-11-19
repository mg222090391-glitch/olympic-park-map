/* =====================================================================
 * map.js — 팀원1(지도·추천 기능 담당)
 * 올림픽공원 편의시설 지도: 지도, 레이어, 팝업, 기준 위치,
 * 거리·추천 계산, "지금 운영 중" 판단
 *
 * 팀 약속(프롬프트 4번 계산 규칙, 7번 연결 약속)을 그대로 따른다.
 *  - 읽는 것 : window.appState (ui.js가 만듦), window.conditionInfo (weather.js가 만듦)
 *  - 채우는 것: window.appState.userLocation, window.recommendations
 *  - 듣는 이벤트 : profilechange, filterchange, conditionready, focusplace
 *  - 보내는 이벤트: recommendready
 *  - 마커 아이콘 : L.divIcon({ className: 'mk mk-종류' })
 *      강조 상태에는 'is-highlight', 흐린 상태에는 'is-dim' 클래스를 덧붙인다(팀원3과 맞춘 이름).
 *  - #map 상태 클래스: 불러오는 중 'is-loading', 실패 'is-error'
 *  - recommendations 항목에는 약속된 6개 값에 더해 stallsType('total'|'female'|'accessible')을 넣는다.
 * ===================================================================== */
(function () {
  'use strict';

  // ───────────────────── 1. 설정값 ─────────────────────
  const DATA_URL = 'data/olympic_park_data.json';
  const DEFAULT_CENTER = [37.5189, 127.1239]; // JSON의 meta.park_center가 있으면 그 값을 쓴다
  const DEFAULT_ZOOM = 16;
  const FOCUS_ZOOM = 18;
  const ICON_SIZE = [28, 28];                  // 마커 크기(px). 팀원3 디자인에 맞춰 바꿔도 된다
  const OUTSIDE_PARK_M = 300;                  // 가장 가까운 공원 시설에서 이보다 멀면 '공원 밖'으로 본다(가정값)
  const SPEED_NORMAL = 67;                     // 분당 m (가정): 일반·공연 대기
  const SPEED_SLOW = 50;                       // 분당 m (가정): 휠체어·유아차·오래 못 걷는 동행·임산부
  const SLOW_PROFILES = ['wheelchair', 'stroller', 'elderly', 'pregnant'];
  const MAX_RECOMMEND = 3;
  const ELDERLY_NEAR_COUNT = 3;                // 'elderly'일 때 강조할 가까운 화장실 수
  const CONCERT_FACILITY_RE = /자판기|편의점|매점|스낵|카페|식음/; // 공연 대기 때 강조할 편의시설 종류
  const REFRESH_MS = 5 * 60 * 1000;            // "지금 열림" 판단을 5분마다 다시 한다

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
    layers: {},          // key → { group, label }
    entries: [],         // 모든 마커 정보 { marker, kind, cat, item, layerKey, iconState }
    meMarker: null,
    origin: null,
    prevProfiles: [],
    noticeEl: null,
    tempNoticeTimer: null,
  };

  // ───────────────────── 6. 마커와 아이콘 ─────────────────────
  function makeIcon(kind, extraClass) {
    return L.divIcon({
      className: 'mk mk-' + kind + (extraClass ? ' ' + extraClass : ''),
      iconSize: ICON_SIZE,
      iconAnchor: [ICON_SIZE[0] / 2, ICON_SIZE[1] / 2],
      popupAnchor: [0, -ICON_SIZE[1] / 2],
    });
  }

  function validPoint(item) {
    return item && Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng));
  }

  function addLayer(key, label, visible) {
    const group = L.layerGroup();
    S.layers[key] = { group: group, label: label };
    if (visible) group.addTo(S.map);
    return group;
  }

  function addEntry(layerKey, cat, kind, item, title) {
    if (!validPoint(item)) return null;
    item.lat = Number(item.lat);
    item.lng = Number(item.lng);
    const entry = { cat: cat, kind: kind, item: item, layerKey: layerKey, iconState: '' };
    entry.marker = L.marker([item.lat, item.lng], {
      icon: makeIcon(kind),
      title: title || '',
      alt: title || '',
      keyboard: true,
    });
    entry.marker.bindPopup(() => popupHtml(entry), { maxWidth: 280 });
    entry.marker.addTo(S.layers[layerKey].group);
    S.entries.push(entry);
    return entry;
  }

  function buildLayers(data) {
    let skipped = 0;
    const count = (e) => { if (!e) skipped++; };

    addLayer('toilets', '화장실', true);
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
      addLayer(key, '편의시설 · ' + type, true);
      types[type].forEach((f) => count(addEntry(key, 'facility', 'facility', f, type + ' ' + (f.place || ''))));
    });

    addLayer('heat', '무더위쉼터', false);
    (data.heat_shelters || []).forEach((s) => count(addEntry('heat', 'heat', 'heat', s, s.name)));

    addLayer('cold', '한파쉼터', false);
    (data.cold_shelters || []).forEach((s) => count(addEntry('cold', 'cold', 'cold', s, s.name)));

    addLayer('charger', '전동휠체어 충전기', true);
    (data.wheelchair_chargers || []).forEach((c) => count(addEntry('charger', 'charger', 'charger', c, c.name)));

    addLayer('elevator', '지하철 엘리베이터', true);
    (data.subway_elevators || []).forEach((e) => count(addEntry('elevator', 'elevator', 'elevator', e, (e.station || '') + ' 엘리베이터')));

    addLayer('aed', 'AED(자동심장충격기)', false);
    (data.aed || []).forEach((a) => count(addEntry('aed', 'aed', 'aed', a, 'AED ' + (a.name || ''))));

    if (skipped) console.warn('[map.js] 좌표가 없거나 잘못된 항목 ' + skipped + '개는 지도에서 뺐어요.');

    const overlays = {};
    Object.keys(S.layers).forEach((k) => { overlays[S.layers[k].label] = S.layers[k].group; });
    L.control.layers(null, overlays, { collapsed: true }).addTo(S.map);
  }

  function showLayer(key) {
    const layer = S.layers[key];
    if (layer && !S.map.hasLayer(layer.group)) layer.group.addTo(S.map);
  }

  // ───────────────────── 7. 팝업 내용 ─────────────────────
  // 팝업 HTML 구조 (팀원3과 맞춘 클래스 이름)
  //  <div class="pop pop-종류">
  //    <p class="pop-type">종류</p> <h3 class="pop-name">이름</h3>
  //    <p class="pop-state is-open|is-closed|is-unknown">상태</p>
  //    <ul class="pop-stalls"><li>여성 <b>4</b>칸</li>…</ul>   (칸 수가 없으면 <p class="pop-stalls is-empty">)
  //    <ul class="pop-tags"><li class="yes">…</li><li class="no">…</li></ul>
  //    <dl class="pop-info"><dt>항목</dt><dd>값</dd>…</dl>
  //    <p class="pop-dist">기준 위치에서 거리</p> <p class="pop-src">출처·참고</p>
  //  </div>
  function stateHtml(status, openText, closedText, unknownText) {
    const cls = status === true ? 'is-open' : status === false ? 'is-closed' : 'is-unknown';
    const txt = status === true ? openText : status === false ? closedText : unknownText;
    return '<p class="pop-state ' + cls + '">' + esc(txt) + '</p>';
  }

  function headHtml(type, name) {
    return '<p class="pop-type">' + esc(type) + '</p><h3 class="pop-name">' + esc(name || type) + '</h3>';
  }

  // [이름, 값] → 값이 true면 li.yes, false면 li.no, 정보 없으면 뺀다
  function tagsHtml(pairs) {
    const li = pairs
      .map(([label, v]) => [label, yesNo(v)])
      .filter(([, b]) => b !== null)
      .map(([label, b]) => '<li class="' + (b ? 'yes' : 'no') + '">' + esc(label) + (b ? ' 있음' : ' 없음') + '</li>')
      .join('');
    return li ? '<ul class="pop-tags">' + li + '</ul>' : '';
  }

  function infoHtml(pairs) {
    const body = pairs
      .filter((p) => p[1] !== null && p[1] !== undefined && String(p[1]).trim() !== '')
      .map((p) => '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>')
      .join('');
    return body ? '<dl class="pop-info">' + body + '</dl>' : '';
  }

  function stallsHtml(it) {
    if (num(it.total) === null) return '<p class="pop-stalls is-empty">칸 수 정보 없음</p>';
    const li = [['여성', it.female_stalls, '칸'], ['남성 변기', it.male_fixtures, '개'], ['장애인', it.accessible_stalls, '칸']]
      .filter(([, v]) => num(v) !== null)
      .map(([label, v, unit]) => '<li>' + esc(label) + ' <b>' + num(v) + '</b>' + unit + '</li>')
      .join('');
    return '<ul class="pop-stalls">' + li + '</ul>';
  }

  function distanceHtml(item) {
    if (!S.origin) return '';
    const st = ensureAppState();
    const m = haversine(S.origin.lat, S.origin.lng, item.lat, item.lng);
    const min = Math.max(1, Math.round(walkMinutes(m, st.profiles)));
    return '<p class="pop-dist">기준 위치에서 약 ' + Math.round(m).toLocaleString() + 'm · 도보 약 ' + min +
      '분 (분당 ' + walkSpeed(st.profiles) + 'm로 가정)</p>';
  }

  function srcHtml(text) {
    return text ? '<p class="pop-src">' + esc(text) + '</p>' : '';
  }

  function parkDist(item) {
    const d = num(item.dist_from_park_m);
    return d === null ? null : '약 ' + Math.round(d).toLocaleString() + 'm';
  }

  function popupHtml(entry) {
    const it = entry.item;
    const now = new Date();
    let h = '';
    switch (entry.cat) {
      case 'toilet':
        h += headHtml('화장실', it.name);
        h += stateHtml(toiletOpenNow(it, now), '지금 열림', '지금 닫힘', '개방시간 확인 필요');
        h += stallsHtml(it);
        h += tagsHtml([['기저귀 교환대', it.diaper_table], ['비상벨', it.emergency_bell]]);
        h += infoHtml([['개방시간', [it.open, it.open_detail].filter((x) => x && String(x).trim()).join(' / ') || '정보 없음']]);
        h += distanceHtml(it);
        h += srcHtml(it.source ? '정보 출처: ' + it.source : '');
        break;
      case 'heat':
        h += headHtml('무더위쉼터', it.name);
        h += stateHtml(heatShelterOpenNow(it, now), '지금 운영 중', '지금 운영 안 함', '운영 여부 확인 필요');
        h += infoHtml([
          ['구분', it.kind], ['시설', it.facility], ['운영 요일', it.days], ['운영 시간', hoursToText(it.hours)],
          ['추가 운영', yesNo(it.weekend_extra) === null ? null : (yesNo(it.weekend_extra) ? '있음' : '없음')],
          ['공원에서 거리', parkDist(it)],
        ]);
        h += distanceHtml(it);
        h += srcHtml('공휴일 운영 여부는 반영하지 않았어요.');
        break;
      case 'cold':
        h += headHtml('한파쉼터', it.name);
        h += stateHtml(coldShelterOpenNow(it, now), '지금 운영 중', '지금 운영 안 함', '운영시간 정보 없음 (방문 전 확인 필요)');
        h += infoHtml([['구분', it.kind], ['시설', it.facility], ['이용 대상', it.who], ['비고', it.note], ['공원에서 거리', parkDist(it)]]);
        h += distanceHtml(it);
        break;
      case 'charger':
        h += headHtml('전동휠체어 충전기', it.name);
        h += stateHtml(chargerOpenNow(it, now), '지금 운영 중', '지금 운영 안 함', '운영 여부 확인 필요');
        h += infoHtml([
          ['설치 위치', it.detail], ['평일 운영', hoursToText(it.weekday)], ['휴일 운영', hoursToText(it.holiday)],
          ['동시 사용', num(it.slots) === null ? it.slots : num(it.slots) + '대'], ['공원에서 거리', parkDist(it)],
        ]);
        h += distanceHtml(it);
        h += srcHtml('토·일요일은 휴일 시간으로 계산했어요(공휴일 미반영).');
        break;
      case 'elevator':
        h += headHtml('지하철 엘리베이터', (it.station || '지하철역') + ' 엘리베이터');
        h += distanceHtml(it);
        break;
      case 'aed':
        h += headHtml('자동심장충격기(AED)', it.name || 'AED');
        h += infoHtml([['설치기관', it.name], ['설치위치', it.detail]]);
        h += distanceHtml(it);
        break;
      default: // facility
        h += headHtml('편의시설 · ' + (it.type || '기타'), it.place || it.type);
        h += infoHtml([['상세 위치', it.detail], ['비고', it.note]]);
        h += distanceHtml(it);
    }
    return '<div class="pop pop-' + entry.cat + '">' + h + '</div>';
  }

  // ───────────────────── 8. 지도 위 안내 문구 ─────────────────────
  function buildNotice() {
    const Ctl = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'map-notice');
        div.setAttribute('role', 'status');
        div.setAttribute('aria-live', 'polite');
        div.innerHTML = '<div class="map-notice-temp"></div><div class="map-notice-shelter"></div>';
        L.DomEvent.disableClickPropagation(div);
        return div;
      },
    });
    const ctl = new Ctl();
    ctl.addTo(S.map);
    S.noticeEl = ctl.getContainer();
  }

  function setNotice(slot, text, level) {
    if (!S.noticeEl) return;
    const el = S.noticeEl.querySelector('.map-notice-' + slot);
    el.className = 'map-notice-' + slot + (text ? ' map-notice-item map-notice-' + (level || 'info') : '');
    el.textContent = text || '';
  }

  function tempNotice(text, level) {
    setNotice('temp', text, level);
    clearTimeout(S.tempNoticeTimer);
    S.tempNoticeTimer = setTimeout(() => setNotice('temp', ''), 7000);
  }

  // ───────────────────── 9. 기준 위치 ─────────────────────
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
    ensureAppState().userLocation = { lat: lat, lng: lng };
    if (!S.meMarker) {
      S.meMarker = L.marker([lat, lng], { icon: makeIcon('me'), zIndexOffset: 1000, title: '기준 위치', alt: '기준 위치' }).addTo(S.map);
    } else {
      S.meMarker.setLatLng([lat, lng]);
    }
    S.meMarker.bindPopup('<div class="pop pop-me"><h3 class="pop-title">기준 위치</h3><p>' + esc(label) +
      '</p><p class="pop-src">지도를 누르면 기준 위치를 바꿀 수 있어요.</p></div>');
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

  // ───────────────────── 10. 추천 + 강조 다시 계산 ─────────────────────
  function recompute() {
    if (!S.data || !S.origin) return;
    const st = ensureAppState();
    const now = new Date();

    // (1) 화장실 추천
    window.recommendations = computeRecommendations(S.data.toilets, S.origin, st.profiles, st.filters, now);
    document.dispatchEvent(new CustomEvent('recommendready', { detail: { recommendations: window.recommendations } }));

    // (2) 강조/흐리게
    refreshEmphasis(now);
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

    // 아이콘 클래스 적용: 강조 'is-highlight', 프로필이 있을 때 나머지는 'is-dim'
    S.entries.forEach((e) => {
      const state = hi.has(e) ? 'is-highlight' : profiles.length ? 'is-dim' : '';
      if (state !== e.iconState) {
        e.iconState = state;
        e.marker.setIcon(makeIcon(e.kind, state));
        e.marker.setZIndexOffset(state === 'is-highlight' ? 500 : 0);
      }
    });
  }

  // ───────────────────── 11. 추천 목록 클릭 → 지도 이동 ─────────────────────
  function focusPlace(lat, lng) {
    lat = Number(lat);
    lng = Number(lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const near = (e) => Math.abs(e.item.lat - lat) < 1e-6 && Math.abs(e.item.lng - lng) < 1e-6;
    const entry = S.entries.find((e) => e.cat === 'toilet' && near(e)) || S.entries.find(near);
    S.map.setView([lat, lng], Math.max(S.map.getZoom(), FOCUS_ZOOM));
    if (entry) {
      showLayer(entry.layerKey);
      entry.marker.openPopup();
    } else {
      L.popup().setLatLng([lat, lng]).setContent('<div class="pop"><p>선택한 위치</p></div>').openOn(S.map);
    }
  }

  // ───────────────────── 12. 데이터 점검 도구 (11-4번 작업용) ─────────────────────
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
  };

  // ───────────────────── 13. 시작 ─────────────────────
  async function loadData() {
    // 테스트용: 서버 없이 열 때는 mock_data.js가 window.__PARK_DATA__를 미리 넣어 둔다
    if (window.__PARK_DATA__) return window.__PARK_DATA__;
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function init() {
    if (typeof L === 'undefined') {
      console.error('[map.js] Leaflet이 없어요. index.html에서 Leaflet CDN이 map.js보다 먼저 있어야 해요.');
      return;
    }
    const el = document.getElementById('map');
    if (!el) {
      console.error('[map.js] #map 영역이 없어요.');
      return;
    }
    ensureAppState();

    S.map = L.map(el, { zoomControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(S.map);
    buildNotice();

    // 이벤트는 데이터가 오기 전에도 받아 두고, 데이터가 오면 계산한다
    document.addEventListener('profilechange', recompute);
    document.addEventListener('filterchange', recompute);
    document.addEventListener('conditionready', () => refreshEmphasis(new Date()));
    document.addEventListener('focusplace', (e) => { const d = (e && e.detail) || {}; if (S.data) focusPlace(d.lat, d.lng); });

    el.classList.add('is-loading');
    try {
      S.data = await loadData();
      el.classList.remove('is-loading');
    } catch (err) {
      el.classList.remove('is-loading');
      el.classList.add('is-error');
      console.error('[map.js] 시설 데이터를 불러오지 못했어요:', err);
      setNotice('temp', '시설 데이터를 불러오지 못했어요. 잠시 뒤 새로고침해 주세요.', 'warn');
      document.dispatchEvent(new CustomEvent('mapdataerror', { detail: { error: String(err) } }));
      return;
    }

    const c = parkCenter();
    S.map.setView([c.lat, c.lng], DEFAULT_ZOOM);
    buildLayers(S.data);

    S.map.on('click', (e) => setOrigin(e.latlng.lat, e.latlng.lng, '지도에서 고른 위치'));
    initLocation(); // 안에서 recompute()가 불린다

    setInterval(recompute, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
