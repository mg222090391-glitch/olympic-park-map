// =====================================================================
// parking.js - 주차 화면: 언제·어디에 세울지 고르기
// 담당: 팀원2(은혜)
//
// 하는 일 (그래프는 뺐다)
//   1. data/parking.json을 불러온다. (tools에서 공공데이터 CSV로 만든 파일)
//   2. '언제 도착해요?'(요일·시각)로 공원 전체 주차 붐빔을 '여유 / 보통 / 붐빔'으로 알려 주고,
//      같은 날 더 여유로운 시각을 추천한다.
//   3. '어디 가요?' · '몇 시간 있어요?' · '할인'을 고르면 주차장 순위 1·2·3위를 보여 준다.
//      탭: 가까운 순(가려는 곳까지 걷는 거리) / 싼 순(예상 요금) / 면 많은 순(주차면 수)
//   4. 주차장 카드: 걷는 시간, 예상 요금, 면수, 운영시간(도착 시각에 운영하는지), 높이 제한, 카카오맵 길안내
//   5. '지도에서 주차장만 보기': map.js에 'parkingmap' 이벤트를 보내고 지도 화면으로 바꾼다.
//   6. 주정차 금지 구간, 공원 주차 이용 패턴, 데이터 출처·한계를 보여 준다.
//
// 데이터 한계 (화면에도 적는다)
//   - 입출차 기록에 주차장 구분 칸이 없어 '주차장별' 붐빔은 알 수 없다 → 공원 전체 붐빔만.
//   - 공원 안 동2문·남2문·북2문 주차장은 전국주차장정보표준데이터에 없어 요금·면수를 알 수 없다.
//   - 실시간 빈자리 정보가 없어 '면 많은 순'은 '덜 붐비는 순'이 아니다.
//
// 연결
//   - 걷는 거리: window.mapUtils.walkMetersBetween (map.js, 걷는 길 그래프). 없으면 직선거리.
//   - 걸음 속도: window.mapUtils.walkSpeed(appState.profiles)
//   - 다시 그리기: profilechange, recommendready(걷는 길 그래프를 다 불러온 뒤 map.js가 보냄)
// =====================================================================

(function () {
  "use strict";

  const DATA_URL = "data/parking.json";
  const DOW = "일월화수목금토";            // Date.getDay() 순서
  const DOW_KEY = ["일", "월", "화", "수", "목", "금", "토"];
  const LEVEL = [                            // 그 시각 평균 차량 수 ÷ 한 주 중 가장 붐비는 시각의 평균
    { max: 0.4, key: "free", label: "여유" },
    { max: 0.7, key: "normal", label: "보통" },
    { max: Infinity, key: "busy", label: "붐빔" },
  ];
  const STAY_OPTIONS = [1, 2, 3, 4];        // 시간
  const DISCOUNTS = [
    { key: "", label: "할인 없음" },
    { key: "disabled", label: "장애인 자가운전" },
    { key: "compact", label: "경차" },
    { key: "multichild3", label: "다둥이(3자녀)" },
  ];
  // 가려는 곳 (좌표는 map.js의 장소 좌표와 같은 값)
  const DESTS = [
    { key: "dome", name: "KSPO DOME(체조경기장)", lat: 37.51932, lng: 127.127041 },
    { key: "handball", name: "핸드볼경기장", lat: 37.517703, lng: 127.126494 },
    { key: "olympichall", name: "올림픽홀", lat: 37.515154, lng: 127.127099 },
    { key: "artshall", name: "우리금융아트홀", lat: 37.517467, lng: 127.125023 },
    { key: "tennis", name: "테니스경기장", lat: 37.514955, lng: 127.128647 },
    { key: "swim", name: "올림픽수영장", lat: 37.520654, lng: 127.126685 },
    { key: "velodrome", name: "벨로드롬", lat: 37.517498, lng: 127.123861 },
    { key: "peacegate", name: "평화의문(정문)", lat: 37.518313, lng: 127.115394 },
    { key: "peacesq", name: "평화의광장", lat: 37.518447, lng: 127.116531 },
    { key: "soma", name: "소마미술관", lat: 37.516819, lng: 127.118666 },
    { key: "museum", name: "한성백제박물관", lat: 37.515572, lng: 127.120615 },
    { key: "meet", name: "만남의광장", lat: 37.516885, lng: 127.129675 },
  ];

  const state = {
    data: null,
    day: null,          // 0(일)~6(토)
    hour: null,         // 0~23
    dest: DESTS[0].key,
    stay: 2,
    discount: "",
    tab: "near",        // near | cheap | big
  };

  // ---------- 작은 도구 ----------
  function esc(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function won(n) { return Math.round(n).toLocaleString() + "원"; }
  function hourText(h) {
    if (h === 0) return "밤 12시";
    if (h < 12) return "오전 " + h + "시";
    if (h === 12) return "낮 12시";
    return "오후 " + (h - 12) + "시";
  }
  function nowInSeoul() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul", weekday: "short", hour: "numeric", hour12: false,
    }).formatToParts(new Date());
    const wd = parts.find((p) => p.type === "weekday").value;
    const hour = Number(parts.find((p) => p.type === "hour").value) % 24;
    return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd), hour: hour };
  }
  function profiles() {
    return (window.appState && Array.isArray(window.appState.profiles)) ? window.appState.profiles : [];
  }
  function speed() {
    const mu = window.mapUtils;
    return mu && mu.walkSpeed ? mu.walkSpeed(profiles()) : 67;
  }
  function destObj() { return DESTS.find((d) => d.key === state.dest) || DESTS[0]; }

  // ---------- 붐빔 ----------
  function levelOf(ratio) { return LEVEL.find((l) => ratio < l.max) || LEVEL[2]; }
  function presentAt(day, hour) {
    const p = state.data.pattern;
    const arr = p.present_by_dow[DOW_KEY[day]];
    return arr ? arr[hour] : null;
  }
  function busyInfo(day, hour) {
    const p = state.data.pattern;
    const cars = presentAt(day, hour);
    const ratio = cars / p.peak_present;
    const arrivals = (p.arrivals_by_dow[DOW_KEY[day]] || [])[hour];
    return { cars: cars, ratio: ratio, level: levelOf(ratio), arrivals: arrivals };
  }
  // 같은 날 07~21시 중 '여유'인 시각을 도착 시각 가까운 순으로
  function freeHours(day, hour) {
    const out = [];
    for (let h = 7; h <= 21; h++) {
      if (busyInfo(day, h).level.key === "free") out.push(h);
    }
    return out.sort((a, b) => Math.abs(a - hour) - Math.abs(b - hour)).slice(0, 3).sort((a, b) => a - b);
  }

  // ---------- 운영시간 · 요금 ----------
  function hoursFor(lot, day) {
    if (!lot.hours) return null;
    if (day === 6) return lot.hours.sat;
    if (day === 0) return lot.hours.holiday;   // 일요일은 공휴일 운영시간으로 본다
    return lot.hours.weekday;
  }
  function toMin(t) { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
  function openAt(lot, day, hour) {
    const h = hoursFor(lot, day);
    if (!h) return null;
    const a = toMin(h[0]), b = toMin(h[1]);
    if (a === null || b === null) return null;
    const t = hour * 60;
    return t >= a && t < (b === 23 * 60 + 59 ? 24 * 60 : b);
  }
  function hoursText(lot, day) {
    const h = hoursFor(lot, day);
    if (!h) return "정보 없음";
    if (h[0] === "00:00" && (h[1] === "23:59" || h[1] === "24:00")) return "24시간";
    return h[0] + "~" + h[1];
  }
  // 머무는 시간(분)에 대한 예상 요금. null이면 계산할 수 없음
  function feeFor(lot, minutes) {
    if (!lot.paid) return { fee: 0, note: "무료" };
    const f = lot.fee || {};
    if (!f.baseMin || f.base === null || f.base === undefined) return null;
    let fee = f.base;
    if (minutes > f.baseMin) {
      if (!f.addMin || f.add === null || f.add === undefined) return null;
      fee += Math.ceil((minutes - f.baseMin) / f.addMin) * f.add;
    }
    if (f.dayPass && fee > f.dayPass) fee = f.dayPass;
    let note = "";
    if (state.discount) {
      const pct = (lot.discounts || {})[state.discount];
      if (pct) { fee = Math.round((fee * (100 - pct) / 100) / 10) * 10; note = pct + "% 할인 적용"; }
      else note = "이 주차장은 고른 할인 정보가 없어요";
    }
    return { fee: fee, note: note };
  }

  // ---------- 주차장 목록 만들기 ----------
  function allLots() {
    const d = state.data;
    const dest = destObj();
    const mu = window.mapUtils;
    const sp = speed();
    const walk = (p) => {
      const r = mu && mu.walkMetersBetween ? mu.walkMetersBetween(p, dest, profiles())
        : { m: haversine(p.lat, p.lng, dest.lat, dest.lng), path: false };
      return { m: r.m, path: r.path, min: Math.max(1, Math.round(r.m / sp)) };
    };
    const lots = d.lots.map((l) => Object.assign({}, l, { inPark: false, walk: walk(l) }));
    const inPark = d.inPark.map((l) => Object.assign({}, l, { inPark: true, walk: walk(l) }));
    return { lots: lots, inPark: inPark };
  }
  function haversine(a, b, c, e) {
    const R = 6371000, r = (x) => x * Math.PI / 180;
    const x = r(c - a), y = r(e - b);
    const h = Math.sin(x / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(y / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function inParkOpen(l, day, hour) {
    if (l.note && /월요일\s*휴무/.test(l.note) && day === 1) return false;
    if (!l.hours || !l.hours.length) return null;
    // 여러 출입구 중 가장 늦게까지 여는 시간으로 본다
    let open = false;
    l.hours.forEach((t) => {
      const m = /(\d{2}):(\d{2})~(\d{2}):(\d{2})/.exec(t);
      if (!m) return;
      const a = Number(m[1]) * 60 + Number(m[2]), b = Number(m[3]) * 60 + Number(m[4]);
      if (hour * 60 >= a && hour * 60 < b) open = true;
    });
    return open;
  }

  function ranked() {
    const { lots, inPark } = allLots();
    const minutes = state.stay * 60;
    if (state.tab === "near") {
      return lots.concat(inPark).sort((a, b) => a.walk.m - b.walk.m).slice(0, 3);
    }
    if (state.tab === "cheap") {
      return lots.map((l) => Object.assign(l, { feeInfo: feeFor(l, minutes) }))
        .filter((l) => l.feeInfo)
        .sort((a, b) => a.feeInfo.fee - b.feeInfo.fee || a.walk.m - b.walk.m).slice(0, 3);
    }
    return lots.filter((l) => l.spaces).sort((a, b) => b.spaces - a.spaces).slice(0, 3);
  }

  // ---------- 그리기 ----------
  function kakaoLink(l) {
    return "https://map.kakao.com/link/to/" + encodeURIComponent(l.name) + "," + l.lat + "," + l.lng;
  }

  function lotCard(l, rank) {
    const day = state.day, hour = state.hour;
    const fi = l.inPark ? null : (l.feeInfo || feeFor(l, state.stay * 60));
    const open = l.inPark ? inParkOpen(l, day, hour) : openAt(l, day, hour);
    const rows = [];
    rows.push("<li><b>걸어서</b> " + esc(destObj().name) + "까지 약 " + l.walk.min + "분 (" +
      Math.round(l.walk.m).toLocaleString() + "m" + (l.walk.path ? "" : ", 직선거리") + ")</li>");
    if (l.inPark) {
      rows.push("<li><b>요금·면수</b> 공공데이터에 없어요</li>");
      if (l.heightLimitM) rows.push('<li class="pk-warn"><b>높이 제한</b> ' + l.heightLimitM + "m — 이보다 높은 차(승합차 등)는 못 들어가요</li>");
      rows.push("<li><b>출입 시간</b> " + esc((l.hours || []).join(", ") || "정보 없음") + (l.note ? " · " + esc(l.note) : "") + "</li>");
    } else {
      rows.push("<li><b>예상 요금</b> " + (fi ? won(fi.fee) + " (" + state.stay + "시간" + (fi.note ? ", " + esc(fi.note) : "") + ")" : "계산할 수 없어요") + "</li>");
      rows.push("<li><b>주차면</b> " + (l.spaces ? l.spaces.toLocaleString() + "면" : "정보 없음") + " · " + esc(l.kind || "") + " 주차장" +
        (l.accessible ? " · 장애인 전용 구역 있음" : "") + "</li>");
      rows.push("<li><b>운영</b> " + esc(hoursText(l, day)) + " (" + esc(l.manager || "") + ")</li>");
    }
    const openTag = open === true ? '<span class="pk-tag is-open">도착 시각에 운영</span>'
      : open === false ? '<span class="pk-tag is-closed">도착 시각엔 운영 안 함</span>' : "";
    return '<li class="pk-card">' +
      '<div class="pk-card-head"><span class="pk-rank-num" aria-label="' + rank + '위">' + rank + "</span>" +
      '<div class="pk-card-title"><h4>' + esc(l.name) + "</h4>" +
      '<p class="pk-tags">' + (l.inPark ? '<span class="pk-tag is-inpark">공원 안</span>' : '<span class="pk-tag">공영</span>') + openTag + "</p></div></div>" +
      '<ul class="pk-rows">' + rows.join("") + "</ul>" +
      '<div class="pk-actions">' +
      '<a class="btn btn-primary pk-nav" href="' + kakaoLink(l) + '" target="_blank" rel="noopener">카카오맵 길안내</a>' +
      '<button type="button" class="btn pk-show" data-pk-show="' + esc(l.name) + '">지도에서 보기</button>' +
      "</div></li>";
  }

  function popupHtml(l) {
    return '<div class="pop"><p class="pop-type">' + (l.inPark ? "공원 안 주차장" : "공영주차장") + "</p>" +
      '<h3 class="pop-title">' + esc(l.name) + "</h3>" +
      '<p class="pop-row"><b>걸어서</b> ' + esc(destObj().name) + "까지 약 " + l.walk.min + "분</p>" +
      (l.inPark ? (l.heightLimitM ? '<p class="pop-row"><b>높이 제한</b> ' + l.heightLimitM + "m</p>" : "")
        : '<p class="pop-row"><b>주차면</b> ' + (l.spaces || "?") + "면 · " + esc(hoursText(l, state.day)) + "</p>") +
      '<p class="pop-row"><a href="' + kakaoLink(l) + '" target="_blank" rel="noopener">카카오맵 길안내</a></p></div>';
  }

  function render() {
    const box = document.querySelector('[data-role="pk-body"]');
    if (!box || !state.data) return;
    const d = state.data;
    const b = busyInfo(state.day, state.hour);
    const free = freeHours(state.day, state.hour);
    const when = DOW[state.day] + "요일 " + hourText(state.hour);

    // 1) 붐빔
    let html = '<section class="pk-block pk-busy is-' + b.level.key + '" aria-live="polite">' +
      '<p class="pk-busy-when">' + esc(when) + " 도착</p>" +
      '<p class="pk-busy-level"><span class="pk-level">' + b.level.label + "</span> 공원 주차장</p>" +
      '<p class="pk-busy-desc">평소 이 시각엔 공원 주차장에 약 ' + Math.round(b.cars).toLocaleString() + "대가 있어요. 한 주 중 가장 붐비는 시각(" + esc((d.pattern.peak_at || {}).dow || "") + "요일 " + hourText((d.pattern.peak_at || {}).hour || 0) + ", 약 " +
      Math.round(d.pattern.peak_present).toLocaleString() + "대)의 " + Math.round(b.ratio * 100) + "% 수준이에요." +
      (b.arrivals ? " 이 시각 1시간 동안 평균 약 " + Math.round(b.arrivals).toLocaleString() + "대가 들어와요." : "") + "</p>";
    if (b.level.key !== "free") {
      html += '<p class="pk-busy-tip">' + (free.length ? "같은 날 더 여유로운 시각: <b>" + free.map(hourText).join(", ") + "</b>. " : "") +
        (b.level.key === "busy" ? "공원 밖 공영주차장이나 지하철(올림픽공원역·몽촌토성역·한성백제역)도 생각해 보세요." : "") + "</p>";
    }
    html += "</section>";

    // 2) 순위
    const list = ranked();
    html += '<section class="pk-block"><div class="pk-tabs" role="group" aria-label="주차장 순위 기준">' +
      [["near", "가까운 순"], ["cheap", "싼 순"], ["big", "면 많은 순"]].map(function (t) {
        return '<button type="button" class="pk-tab" data-pk-tab="' + t[0] + '" aria-pressed="' + (state.tab === t[0]) + '">' + t[1] + "</button>";
      }).join("") + "</div>" +
      '<p class="pk-tab-desc">' + (state.tab === "near" ? esc(destObj().name) + "까지 걷는 거리가 짧은 순이에요. 공원 안 시설 주차장도 함께 봐요."
        : state.tab === "cheap" ? state.stay + "시간 머물 때 예상 요금이 싼 순이에요. 공원 안 주차장은 요금 정보가 없어 빠져요."
          : "주차면이 많아 자리 찾기 쉬운 순이에요. 실시간 빈자리가 아니라 면수 기준이에요.") + "</p>" +
      '<ol class="pk-list">' + list.map(function (l, i) { return lotCard(l, i + 1); }).join("") + "</ol>" +
      '<button type="button" class="btn pk-map-all" data-pk-show="__all">지도에서 주차장만 보기</button></section>';

    // 3) 주정차 금지
    if (d.noParking && d.noParking.length) {
      html += '<section class="pk-block pk-nopark"><h3>길가에 세우지 마세요</h3><ul>' +
        d.noParking.map(function (z) {
          return "<li><b>" + esc(z.road) + " " + esc(z.where) + "</b> 앞 약 " + Math.round(z.lengthKm * 1000) + "m · " +
            (z.weekday && z.weekday[0] === "00:00" ? "하루 종일" : esc((z.weekday || []).join("~"))) + " 주정차 금지</li>";
        }).join("") + "</ul></section>";
    }

    // 4) 이용 패턴
    const p = d.pattern;
    html += '<section class="pk-block pk-facts"><h3>공원 주차, 이렇게 쓰여요</h3><ul>' +
      "<li>하루 평균 약 <b>" + p.daily_avg.toLocaleString() + "대</b>가 공원 주차장을 써요.</li>" +
      "<li>머문 시간(가운데 값)은 평일 <b>" + p.stay_median_min.weekday + "분</b>, 주말 <b>" + p.stay_median_min.weekend + "분</b>이에요.</li>" +
      "<li>10대 중 약 <b>" + Math.round(p.stay_share.le30 * 10) + "대</b>는 30분 안에 나가요.</li>" +
      "<li>주말에는 오후 1~4시에 차가 가장 많이 들어와요. 그 전에 오면 자리 찾기가 쉬워요.</li>" +
      "</ul></section>";

    // 5) 데이터 안내
    html += '<details class="pk-block pk-data"><summary>데이터 출처와 한계</summary><ul>' +
      "<li>붐빔: " + esc(p.source) + ". " + esc(p.note) + "</li>" +
      "<li>공영주차장: " + esc(d.lots_source) + ". 요금은 기본요금·추가요금으로 계산한 예상값이에요.</li>" +
      "<li>공원 안 시설 주차장: " + esc(d.inPark_source) + " (출입구 위치·높이 제한·출입 시간).</li>" +
      "<li>주정차 금지: " + esc(d.noParking_source) + ".</li>" +
      "<li>공원 안 동2문·남2문·북2문 주차장의 요금·면수와 주차장별 혼잡은 공공데이터에 없어 보여 드릴 수 없어요.</li>" +
      "<li>걷는 거리는 OpenStreetMap 걷는 길 기준이고, 길로 이어지지 않으면 직선거리로 적었어요.</li>" +
      "</ul></details>";

    box.innerHTML = html;
  }

  function showOnMap(name) {
    const { lots, inPark } = allLots();
    let pick = lots.concat(inPark);
    if (name !== "__all") {
      const one = pick.find((l) => l.name === name);
      pick = one ? [one] : pick;
    }
    const listNow = ranked().map((l) => l.name);
    // 지도 화면을 먼저 연 다음(크기가 정해진 뒤) 주차장을 보여 준다
    const tab = document.querySelector('.tabbar [data-go="map"]');
    if (tab) tab.click();
    setTimeout(function () { sendParkingMap(pick, listNow); }, 80);
  }

  function sendParkingMap(pick, listNow) {
    document.dispatchEvent(new CustomEvent("parkingmap", {
      detail: {
        on: true,
        dest: { name: destObj().name, lat: destObj().lat, lng: destObj().lng },
        lots: pick.map(function (l) {
          const r = listNow.indexOf(l.name);
          return { name: l.name, lat: l.lat, lng: l.lng, inPark: l.inPark, rank: r > -1 ? String(r + 1) : "", html: popupHtml(l) };
        }),
      },
    }));
  }

  // ---------- 입력 칸 ----------
  function buildControls(section) {
    const c = section.querySelector('[data-role="pk-controls"]');
    if (!c) return;
    const dayOpts = [0, 1, 2, 3, 4, 5, 6].map(function (i) {
      return '<option value="' + i + '"' + (i === state.day ? " selected" : "") + ">" + DOW[i] + "요일" + (i === nowInSeoul().day ? " (오늘)" : "") + "</option>";
    }).join("");
    const hourOpts = Array.from({ length: 24 }, function (_, h) {
      return '<option value="' + h + '"' + (h === state.hour ? " selected" : "") + ">" + hourText(h) + "</option>";
    }).join("");
    c.innerHTML =
      '<div class="pk-field"><label for="pk-day">언제 도착해요?</label><div class="pk-row">' +
      '<select id="pk-day" data-pk="day">' + dayOpts + "</select>" +
      '<select id="pk-hour" data-pk="hour" aria-label="도착 시각">' + hourOpts + "</select>" +
      '<button type="button" class="btn pk-now" data-pk-now>지금</button></div></div>' +
      '<div class="pk-field"><label for="pk-dest">어디 가요?</label>' +
      '<select id="pk-dest" data-pk="dest">' + DESTS.map(function (d) {
        return '<option value="' + d.key + '"' + (d.key === state.dest ? " selected" : "") + ">" + esc(d.name) + "</option>";
      }).join("") + "</select></div>" +
      '<div class="pk-field"><span class="pk-label" id="pk-stay-label">몇 시간 있어요?</span>' +
      '<div class="pk-chips" role="group" aria-labelledby="pk-stay-label">' + STAY_OPTIONS.map(function (h) {
        return '<button type="button" class="pk-chip" data-pk-stay="' + h + '" aria-pressed="' + (h === state.stay) + '">' + h + "시간</button>";
      }).join("") + "</div></div>" +
      '<div class="pk-field"><label for="pk-disc">요금 할인</label>' +
      '<select id="pk-disc" data-pk="discount">' + DISCOUNTS.map(function (d) {
        return '<option value="' + d.key + '"' + (d.key === state.discount ? " selected" : "") + ">" + d.label + "</option>";
      }).join("") + "</select></div>";
  }

  function onChange(e) {
    const t = e.target;
    const k = t.getAttribute("data-pk");
    if (!k) return;
    if (k === "day" || k === "hour") state[k] = Number(t.value);
    else state[k] = t.value;
    render();
  }

  function onClick(e) {
    const t = e.target.closest("[data-pk-tab],[data-pk-stay],[data-pk-show],[data-pk-now]");
    if (!t) return;
    if (t.hasAttribute("data-pk-tab")) {
      state.tab = t.getAttribute("data-pk-tab");
      render();
    } else if (t.hasAttribute("data-pk-stay")) {
      state.stay = Number(t.getAttribute("data-pk-stay"));
      t.parentNode.querySelectorAll("[data-pk-stay]").forEach(function (b) { b.setAttribute("aria-pressed", String(b === t)); });
      render();
    } else if (t.hasAttribute("data-pk-now")) {
      const n = nowInSeoul();
      state.day = n.day; state.hour = n.hour;
      const sd = document.getElementById("pk-day"), sh = document.getElementById("pk-hour");
      if (sd) sd.value = String(n.day);
      if (sh) sh.value = String(n.hour);
      render();
    } else {
      showOnMap(t.getAttribute("data-pk-show"));
    }
  }

  async function init() {
    const section = document.getElementById("parking-section");
    if (!section) return;
    const body = section.querySelector('[data-role="pk-body"]');
    const n = nowInSeoul();
    state.day = n.day;
    state.hour = n.hour;
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      state.data = await res.json();
    } catch (err) {
      console.warn("[parking.js] 주차 데이터를 불러오지 못했어요:", err);
      if (body) body.innerHTML = '<p class="status is-error">주차 정보를 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.</p>';
      return;
    }
    buildControls(section);
    section.addEventListener("change", onChange);
    section.addEventListener("click", onClick);
    render();
    // 상황(걸음 속도·계단)이 바뀌거나, 걷는 길 그래프를 다 불러와 추천이 다시 계산되면 거리도 다시 잰다
    document.addEventListener("profilechange", render);
    document.addEventListener("recommendready", render);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
