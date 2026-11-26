/* =====================================================================
   올림픽공원 편의시설 지도 - ui.js (팀원3 담당)
   ---------------------------------------------------------------------
   하는 일
   1) window.appState(공유 상태)를 만든다
   2) 상황 체크박스 5개 → appState.profiles 갱신 → 'profilechange' 보냄
   3) 키워드 검색 → 맞는 상황 체크박스 자동으로 켜기
   4) 필터 버튼 4개 → appState.filters 갱신 → 'filterchange' 보냄
   5) 'conditionready' 들으면 → #condition-card 그리기
   6) 'recommendready' 들으면 → #recommend-list 그리기
   6-2) 'routeready' 들으면 → #recommend-list 맨 위에 '추천 동선(들를 곳 순서)' 그리기 [팀원1 추가]
   7) 추천 목록 항목 누르면 → 'focusplace' 보냄 (detail: { lat, lng })
   8) '어디 가요?' 버튼 → appState.destination 갱신 → 'destinationchange' 보냄 [팀원1 추가]
   9) 출발지 버튼 → 'originpick' 보냄, map.js의 'originchange'를 들으면 눌린 버튼·문구를 맞춘다 [팀원1 추가]
  10) 어두운 화면(다크모드) 버튼 → <html data-theme> 바꾸고 'themechange' 보냄 [팀원1 추가]
  11) 음성 안내: 길안내·교통 브리핑을 브라우저 음성(한국어)으로 읽어 준다 [팀원1 추가]
      화장실이 아닌 곳을 고르면 #recommend-list에 window.destList(가까운 순, 필요한 정보만)를 그린다
   ※ 이벤트는 모두 document에서 보내고 듣는다 (팀 약속 7번)
   ===================================================================== */

(function () {
  'use strict';

  /* ---------- 1. 공유 상태 (팀 약속 7번 형식 그대로) ---------- */
  // map.js보다 먼저 실행되므로, 여기서 바로 만들어 둔다.
  window.appState = {
    profiles: [],
    filters: { diaper: false, bell: false, openNow: false, femaleStalls: false },
    userLocation: null,
    destination: 'all'   // 가고 싶은 곳 [팀원1 추가]: all | toilet | rest | shop | water | charger | elevator | aed
  };

  /* ---------- 2. 프로필 정보 (팀 약속 4번) ---------- */
  var PROFILE_ORDER = ['wheelchair', 'stroller', 'elderly', 'pregnant', 'concert'];

  var PROFILE_LABEL = {
    wheelchair: '휠체어',
    stroller: '유아차',
    elderly: '오래 못 걷는 동행',
    pregnant: '임산부',
    concert: '공연 대기'
  };

  var PROFILE_KEYWORDS = {
    wheelchair: ['휠체어', '전동휠체어'],
    stroller: ['유아차', '유모차', '아기', '아이'],
    elderly: ['할머니', '할아버지', '어르신', '부모님', '노인'],
    pregnant: ['임신', '임산부'],
    concert: ['공연', '콘서트', '대기', '굿즈']
  };

  // 가고 싶은 곳 [팀원1 추가]
  var DEST_ORDER = ['all', 'toilet', 'rest', 'shop', 'water', 'charger', 'transit', 'elevator', 'aed'];
  var DEST_LABEL = {
    all: '전체', toilet: '화장실', rest: '쉴 곳(쉼터)', shop: '매점·자판기', water: '음수대',
    charger: '전동휠체어 충전기', elevator: '지하철 엘리베이터', aed: 'AED(자동심장충격기)', transit: '역·버스·택시'
  };
  var DEST_ICON = { all: '🗺️', toilet: '🚻', rest: '🪑', shop: '🛒', water: '🚰', charger: '🔌', elevator: '🛗', aed: '💓', transit: '🚉' };
  // 상황별로 '추천' 표시를 붙일 곳
  var DEST_FOR_PROFILE = {
    wheelchair: ['toilet', 'charger', 'elevator'],
    stroller: ['toilet', 'elevator', 'rest'],
    elderly: ['rest', 'toilet'],
    pregnant: ['toilet', 'rest'],
    concert: ['toilet', 'shop', 'water', 'transit']
  };
  var DEST_KEYWORDS = {
    toilet: ['화장실', '볼일', '소변'],
    rest: ['쉼터', '쉬고', '쉴곳', '쉴데', '휴식', '앉고'],
    shop: ['매점', '편의점', '자판기', '음료', '간식', '먹을'],
    water: ['음수대', '물마', '목말'],
    charger: ['충전'],
    transit: ['택시', '버스', '지하철', '정류장', '교통', '역까지', '집에'],
    elevator: ['엘리베이터', '승강기'],
    aed: ['aed', '심장', '제세동', '쓰러']
  };
  var WEATHER_ICON = { hot: '☀️', cold: '❄️', rain: '☔' };

  // 도보 속도 (분당 m, 가정값). 여러 개 고르면 가장 느린 속도.
  var SLOW_PROFILES = ['wheelchair', 'stroller', 'elderly', 'pregnant'];
  var SPEED_NORMAL = 67;
  var SPEED_SLOW = 50;

  // 이 시간(밀리초) 안에 이벤트가 안 오면 "불러오지 못했어요"를 보여준다.
  var WAIT_LIMIT_MS = 15000;

  /* ---------- 3. 작은 도우미 함수들 ---------- */

  // 이벤트 보내기
  function send(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  // 글자를 HTML에 안전하게 넣기 (<, > 같은 기호가 태그로 바뀌지 않게)
  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isEmpty(v) {
    return v === null || v === undefined || v === '';
  }

  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
    return NaN;
  }

  function $(selector) {
    return document.querySelector(selector);
  }

  /* ---------- 4. 날씨 값 → 화면 글자 ---------- */
  // 팀원2의 값 형식이 숫자/글자 어느 쪽이어도 깨지지 않게 처리한다.

  function formatTemp(v) {
    var n = toNumber(v);
    if (isNaN(n)) return isEmpty(v) ? '–' : esc(v);
    return Math.round(n) + '°';
  }

  // rain: true/false (규칙표와 같은 형식) 또는 글자, 숫자(mm)
  function formatRain(v) {
    if (v === true) return '비 소식 있음';
    if (v === false) return '없음';
    if (isEmpty(v)) return '정보 없음';
    var n = toNumber(v);
    if (!isNaN(n)) return n === 0 ? '없음' : n + 'mm';
    return esc(v);
  }

  // sky: 글자("맑음") 또는 기상청 하늘상태 코드(1 맑음, 3 구름많음, 4 흐림)
  function formatSky(v) {
    var codes = { 1: '맑음', 3: '구름많음', 4: '흐림' };
    if (isEmpty(v)) return '정보 없음';
    var n = toNumber(v);
    if (!isNaN(n) && codes[n]) return codes[n];
    return esc(v);
  }

  function skyIcon(text, rain) {
    if (rain === true) return '☔';
    if (text.indexOf('맑') > -1) return '☀️';
    if (text.indexOf('구름') > -1) return '⛅';
    if (text.indexOf('흐') > -1) return '☁️';
    return '🌤️';
  }

  // uv: 숫자(자외선지수) 또는 글자("보통")
  // 기상청 단계: 0~2 낮음, 3~5 보통, 6~7 높음, 8~10 매우높음, 11 이상 위험
  function formatUv(v) {
    if (isEmpty(v)) return '정보 없음';
    var n = toNumber(v);
    if (isNaN(n)) return esc(v);
    var level = n >= 11 ? '위험' : n >= 8 ? '매우높음' : n >= 6 ? '높음' : n >= 3 ? '보통' : '낮음';
    return level + ' (' + n + ')';
  }

  // baseTime: "1400" → "14:00", "202611251400" → "11월 25일 14:00", 그 외는 그대로
  function formatBaseTime(v) {
    if (isEmpty(v)) return '';
    var s = String(v).trim();
    if (/^\d{3,4}$/.test(s)) {
      s = s.padStart(4, '0');
      return s.slice(0, 2) + ':' + s.slice(2);
    }
    if (/^\d{12}$/.test(s)) {
      return Number(s.slice(4, 6)) + '월 ' + Number(s.slice(6, 8)) + '일 ' +
             s.slice(8, 10) + ':' + s.slice(10, 12);
    }
    return esc(s);
  }

  /* ---------- 5. 상황 선택 (체크박스 + 키워드 검색) ---------- */

  function getProfileBoxes() {
    return Array.prototype.slice.call(
      document.querySelectorAll('#profile-select input[name="profile"]')
    );
  }

  // 체크박스 상태를 읽어서 appState.profiles를 만든다 (항상 같은 순서)
  function readProfiles() {
    var checked = getProfileBoxes()
      .filter(function (box) { return box.checked; })
      .map(function (box) { return box.value; });
    return PROFILE_ORDER.filter(function (id) { return checked.indexOf(id) > -1; });
  }

  // 체크된 칸 모양(.is-checked) 맞추기
  function syncChipStyle() {
    getProfileBoxes().forEach(function (box) {
      var chip = box.closest('.chip');
      if (chip) chip.classList.toggle('is-checked', box.checked);
    });
  }

  // 프로필이 바뀌었을 때 할 일을 한곳에 모음
  function applyProfiles() {
    window.appState.profiles = readProfiles();
    syncChipStyle();
    updateFemaleButton();
    updateRecommendBasis();
    updateConcertSuggest();
    updateDestBadges();
    send('profilechange', { profiles: window.appState.profiles.slice() });
  }

  // 문장에서 키워드를 찾아 프로필 ID 목록을 돌려준다
  function findProfilesInText(text) {
    var compact = text.replace(/\s+/g, ''); // "전동 휠체어"처럼 띄어 써도 찾도록
    return PROFILE_ORDER.filter(function (id) {
      return PROFILE_KEYWORDS[id].some(function (word) {
        return compact.indexOf(word) > -1;
      });
    });
  }

  function handleKeywordSubmit(event) {
    event.preventDefault();
    var input = $('#keyword-input');
    var result = $('[data-role="keyword-result"]');
    var text = input.value.trim();

    result.classList.remove('is-ok', 'is-none');

    if (!text) {
      result.textContent = '내 상황을 짧게 적어 주세요. 예: 할머니랑 유모차 끌고 왔어요';
      result.classList.add('is-none');
      input.focus();
      return;
    }

    var found = findProfilesInText(text);
    var foundDest = findDestInText(text);

    if (found.length === 0 && !foundDest) {
      result.textContent = '알아들은 상황이 없어요. 아래에서 직접 골라 주세요.';
      result.classList.add('is-none');
      return;
    }

    // 찾은 상황의 체크박스를 켠다 (이미 켜진 다른 상황은 그대로 둔다)
    var changed = false;
    getProfileBoxes().forEach(function (box) {
      if (found.indexOf(box.value) > -1 && !box.checked) {
        box.checked = true;
        changed = true;
      }
    });

    var labels = found.map(function (id) { return PROFILE_LABEL[id]; });
    var parts = [];
    if (labels.length) parts.push(labels.join(', '));
    if (foundDest) parts.push('가고 싶은 곳: ' + DEST_LABEL[foundDest]);
    result.textContent = '이렇게 이해했어요: ' + parts.join(' · ');
    result.classList.add('is-ok');

    if (changed) applyProfiles();
    if (foundDest) setDestination(foundDest);
  }

  /* ---------- 5-2. 가고 싶은 곳 [팀원1 추가] ---------- */

  function findDestInText(text) {
    var compact = text.replace(/\s+/g, '').toLowerCase();
    for (var i = 0; i < DEST_ORDER.length; i++) {
      var id = DEST_ORDER[i];
      var words = DEST_KEYWORDS[id] || [];
      for (var j = 0; j < words.length; j++) {
        if (compact.indexOf(words[j]) > -1) return id;
      }
    }
    return null;
  }

  function getDestButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('#dest-select .dest-btn'));
  }

  function currentDest() {
    var d = window.appState.destination;
    return DEST_LABEL[d] ? d : 'all';
  }

  // 화장실 필터·여성 칸 안내는 '전체' 또는 '화장실'일 때만 필요하다
  function isToiletView() {
    var d = currentDest();
    return d === 'all' || d === 'toilet';
  }

  function setDestination(dest) {
    if (!DEST_LABEL[dest]) dest = 'all';
    window.appState.destination = dest;
    syncDestUI();
    send('destinationchange', { destination: dest });
  }

  function handleDestClick(event) {
    var btn = event.target.closest('.dest-btn');
    if (!btn) return;
    var d = btn.getAttribute('data-dest');
    // 이미 고른 곳을 다시 누르면 '전체'로 돌아간다
    setDestination(d === currentDest() && d !== 'all' ? 'all' : d);
  }

  // 상황에 맞는 곳에 '추천' 표시
  function updateDestBadges() {
    var rec = {};
    window.appState.profiles.forEach(function (p) {
      (DEST_FOR_PROFILE[p] || []).forEach(function (d) { rec[d] = true; });
    });
    getDestButtons().forEach(function (btn) {
      var d = btn.getAttribute('data-dest');
      var badge = btn.querySelector('.dest-badge');
      if (rec[d] && !badge) {
        badge = document.createElement('span');
        badge.className = 'dest-badge';
        badge.textContent = '추천';
        btn.appendChild(badge);
      } else if (!rec[d] && badge) {
        badge.remove();
      }
      btn.classList.toggle('is-recommended', !!rec[d]);
    });
  }

  var defaultRecTitle = null;

  function syncDestUI() {
    var d = currentDest();
    getDestButtons().forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-dest') === d ? 'true' : 'false');
    });

    // 화장실과 상관없는 곳이면 화장실 필터를 숨긴다 (필요한 정보만)
    var bar = document.getElementById('filter-bar');
    if (bar) bar.hidden = !isToiletView();
    updateFemaleButton();

    var title = document.getElementById('recommend-title');
    if (title) {
      if (defaultRecTitle === null) defaultRecTitle = title.innerHTML;
      title.innerHTML = isToiletView() ? defaultRecTitle :
        '<span class="title-icon" aria-hidden="true">' + DEST_ICON[d] + '</span>가까운 ' + esc(DEST_LABEL[d]) +
        ' <span class="sub">가까운 순</span>';
    }
    var hint = $('[data-role="recommend-hint"]');
    if (hint) hint.hidden = !isToiletView();

    updateRecommendBasis();
    renderRecommendations();
  }

  /* ---------- 6. 필터 버튼 ---------- */

  function getFilterButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('#filter-bar .filter-btn'));
  }

  function handleFilterClick(event) {
    var btn = event.target.closest('.filter-btn');
    if (!btn || btn.disabled) return;
    var key = btn.getAttribute('data-filter');
    if (!(key in window.appState.filters)) return;

    var on = !window.appState.filters[key];
    window.appState.filters[key] = on;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    send('filterchange', { filters: Object.assign({}, window.appState.filters) });
  }

  // '여성 칸 기준'은 공연 대기를 골랐을 때만 쓸 수 있다 (규칙 4번: 공연 대기에만 적용)
  function updateFemaleButton() {
    var btn = $('#filter-bar .filter-btn[data-filter="femaleStalls"]');
    var hint = $('[data-role="female-hint"]');
    if (!btn) return;

    var concertOn = window.appState.profiles.indexOf('concert') > -1;
    btn.disabled = !concertOn;
    if (hint) hint.hidden = concertOn || !isToiletView();

    // 공연 대기를 끄면 여성 칸 기준도 같이 끈다
    if (!concertOn && window.appState.filters.femaleStalls) {
      window.appState.filters.femaleStalls = false;
      btn.setAttribute('aria-pressed', 'false');
      send('filterchange', { filters: Object.assign({}, window.appState.filters) });
    }
  }

  /* ---------- 7. 오늘의 컨디션 카드 ---------- */

  // 카드 색 테마: rain | hot | cold | mild
  function weatherKind(w) {
    if (w.rain === true) return 'rain';
    var f = toNumber(w.feelsLike);
    if (isNaN(f)) f = toNumber(w.temp);
    if (!isNaN(f) && f >= 28) return 'hot';
    if (!isNaN(f) && f <= 5) return 'cold';
    return 'mild';
  }

  var conditionTimer = null;

  function renderCondition() {
    var info = window.conditionInfo;
    var body = $('[data-role="condition-body"]');
    var badges = $('[data-role="condition-badges"]');
    if (!body || !info) return;

    clearTimeout(conditionTimer);

    var w = info.weather || {};
    var skyText = formatSky(w.sky);

    // 카드 색을 날씨에 맞춘다 (style.css의 #condition-card[data-wx])
    var card = document.getElementById('condition-card');
    if (card) card.setAttribute('data-wx', weatherKind(w));
    var messages = Array.isArray(info.messages) ? info.messages : [];

    // 위쪽 배지: 예시 데이터 / 오늘 공연 있음
    var badgeHtml = '';
    if (info.source === 'sample') {
      badgeHtml += '<span class="badge badge-sample">예시 날씨 데이터</span>';
    }
    if (info.concertToday) {
      badgeHtml += '<span class="badge badge-concert"><span aria-hidden="true">🎤</span> 오늘 공연 있음</span>';
    }
    badges.innerHTML = badgeHtml;

    var html = '';

    html += '<div class="temps">' +
              '<p class="temp temp-main"><span class="label">기온</span><span class="value">' + formatTemp(w.temp) + '</span></p>' +
              '<p class="temp temp-feel"><span class="label">체감</span><span class="value">' + formatTemp(w.feelsLike) + '</span></p>' +
            '</div>';

    html += '<ul class="weather-items">' +
              '<li><span class="w-icon" aria-hidden="true">' + skyIcon(skyText, w.rain) + '</span><span class="w-label">하늘</span><b>' + skyText + '</b></li>' +
              '<li><span class="w-icon" aria-hidden="true">☂️</span><span class="w-label">강수</span><b>' + formatRain(w.rain) + '</b></li>' +
              '<li><span class="w-icon" aria-hidden="true">🔆</span><span class="w-label">자외선</span><b>' + formatUv(w.uv) + '</b></li>' +
            '</ul>';

    if (messages.length > 0) {
      html += '<ul class="messages">' +
                messages.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') +
              '</ul>';
    } else {
      html += '<ul class="messages"><li>오늘은 특별히 챙길 것이 없어요.</li></ul>';
    }

    // 오늘 공연이 있는데 '공연 대기'를 안 골랐으면 제안한다
    html += '<div class="concert-suggest" data-role="concert-suggest" hidden>' +
              '<span>오늘 공연이 있어요. 공연 대기에 맞춰 볼까요?</span>' +
              '<button type="button" class="btn" data-role="concert-on">공연 대기로 보기</button>' +
            '</div>';

    var baseTime = formatBaseTime(w.baseTime);
    if (baseTime) {
      html += '<p class="base-time">기준 시각 ' + baseTime + (info.source === 'sample' ? ' · 예시 데이터라 실제 날씨와 달라요' : '') + '</p>';
    } else if (info.source === 'sample') {
      html += '<p class="base-time">예시 데이터라 실제 날씨와 달라요</p>';
    }

    body.innerHTML = html;
    updateConcertSuggest();
  }

  function updateConcertSuggest() {
    var box = $('[data-role="concert-suggest"]');
    if (!box) return;
    var info = window.conditionInfo;
    var show = !!(info && info.concertToday) && window.appState.profiles.indexOf('concert') === -1;
    box.hidden = !show;
  }

  function turnOnConcert() {
    var box = $('#profile-select input[value="concert"]');
    if (box && !box.checked) {
      box.checked = true;
      applyProfiles();
    }
  }

  function showConditionError() {
    var body = $('[data-role="condition-body"]');
    if (!body || window.conditionInfo) return;
    body.innerHTML = '<p class="status is-error">날씨 정보를 불러오지 못했어요. 잠시 후 새로고침해 주세요.</p>';
  }

  /* ---------- 8. 추천 화장실 목록 ---------- */

  var recommendTimer = null;

  function currentSpeed() {
    var slow = window.appState.profiles.some(function (id) {
      return SLOW_PROFILES.indexOf(id) > -1;
    });
    return slow ? SPEED_SLOW : SPEED_NORMAL;
  }

  // 목록 위의 "기준: ○○ · 걸음 속도 분당 ○m 가정" 문구
  function updateRecommendBasis() {
    var el = $('[data-role="recommend-basis"]');
    if (!el) return;
    var p = window.appState.profiles;
    var who = p.length ? p.map(function (id) { return PROFILE_LABEL[id]; }).join(' · ') : '일반';
    var order = isToiletView() ? '' : ' · 가까운 순(직선거리)';
    el.textContent = '기준: ' + who + order + ' · 걸음 속도 분당 ' + currentSpeed() + 'm 가정';
  }

  // 칸 수 앞에 붙일 말.
  // map.js가 stallsType('total' | 'female' | 'accessible')을 주면 그 값을 쓰고,
  // 없으면 규칙 4번에 정해진 '한 가지 상황'일 때만 구체적으로 쓴다.
  var STALL_TYPE_LABEL = { total: '칸 수', female: '여성 칸', accessible: '장애인 칸' };

  function stallLabel(item) {
    if (item && STALL_TYPE_LABEL[item.stallsType]) return STALL_TYPE_LABEL[item.stallsType];
    var p = window.appState.profiles;
    if (p.length === 1 && p[0] === 'wheelchair') return '장애인 칸';
    if (p.length === 1 && p[0] === 'concert' && window.appState.filters.femaleStalls) return '여성 칸';
    return '칸 수';
  }

  function formatWalk(min) {
    var n = toNumber(min);
    if (isNaN(n)) return '도보 시간 정보 없음';
    if (n < 1) return '도보 1분 이내';
    return '도보 약 ' + Math.round(n) + '분';
  }

  function renderRecommendations() {
    var body = $('[data-role="recommend-body"]');
    if (!body) return;
    if (!isToiletView()) { renderDestList(body); return; }
    if (!Array.isArray(window.recommendations)) return;   // 아직 계산 전이면 '계산 중' 문구를 그대로 둔다
    clearTimeout(recommendTimer);
    updateRecommendBasis();

    var list = Array.isArray(window.recommendations) ? window.recommendations.slice(0, 3) : [];

    if (list.length === 0) {
      var f = window.appState.filters;
      var anyFilter = f.diaper || f.bell || f.openNow || f.femaleStalls;
      body.innerHTML =
        '<div class="rec-empty">' +
          '<b>조건에 맞는 화장실이 없어요.</b>' +
          (anyFilter
            ? '위의 필터를 하나씩 꺼 보세요.'
            : '고른 상황을 줄이거나 지도에서 가까운 화장실을 직접 확인해 주세요.') +
        '</div>';
      return;
    }

    var html = '<ol class="rec-list">';
    list.forEach(function (item, i) {
      var stalls = toNumber(item.stalls);
      var stallText = isNaN(stalls) ? '' : ' · ' + stallLabel(item) + ' ' + stalls + '칸';
      html +=
        '<li>' +
          '<button type="button" class="rec-item" data-lat="' + esc(item.lat) + '" data-lng="' + esc(item.lng) + '">' +
            '<span class="rec-rank" aria-label="' + (i + 1) + '위">' + (i + 1) + '</span>' +
            '<span>' +
              '<span class="rec-name">' + esc(item.name) + '</span>' +
              '<span class="rec-meta">' + formatWalk(item.walkMin) + stallText + '</span>' +
            '</span>' +
          '</button>' +
        '</li>';
    });
    html += '</ol>';
    body.innerHTML = html;
    markGuideTarget();
  }

  function handleRecommendClick(event) {
    var btn = event.target.closest('.rec-item');
    if (!btn) return;
    var lat = Number(btn.getAttribute('data-lat'));
    var lng = Number(btn.getAttribute('data-lng'));
    if (isNaN(lat) || isNaN(lng)) return;

    send('focusplace', { lat: lat, lng: lng });

    // 지도가 화면 밖에 있으면 지도가 보이도록 스크롤
    var map = document.getElementById('map');
    if (map) {
      var r = map.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) {
        var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        map.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      }
    }
  }

  function showRecommendError() {
    var body = $('[data-role="recommend-body"]');
    if (!body || Array.isArray(window.recommendations)) return;
    body.innerHTML = '<p class="status is-error">추천 목록을 아직 만들지 못했어요. 잠시 후 새로고침해 주세요.</p>';
  }

  /* ---------- 5-3. 출발지 고르기 [팀원1 추가] ---------- */
  function handleOriginClick(event) {
    var btn = event.target.closest('.origin-btn');
    if (!btn) return;
    btn.classList.add('is-busy');
    send('originpick', { key: btn.getAttribute('data-origin') });
  }

  function renderOrigin(event) {
    var d = (event && event.detail) || {};
    Array.prototype.forEach.call(document.querySelectorAll('.origin-btn'), function (btn) {
      btn.classList.remove('is-busy');
      btn.setAttribute('aria-pressed', btn.getAttribute('data-origin') === d.key ? 'true' : 'false');
    });
    var now = $('[data-role="origin-now"]');
    if (now && d.label) {
      now.textContent = '지금 출발 위치: ' + d.label;
    }
  }

  /* ---------- 8-1. 가고 싶은 곳 목록 [팀원1 추가] ---------- */
  // 지금 길안내 중인 목적지를 목록에서 표시 (aria-current)
  function markGuideTarget() {
    var plan = window.routePlan;
    var last = plan && plan.dest && plan.dest !== 'all' && plan.stops && plan.stops.length ? plan.stops[plan.stops.length - 1] : null;
    var items = document.querySelectorAll('[data-role="recommend-body"] .rec-item');
    Array.prototype.forEach.call(items, function (btn) {
      var on = !!last && Number(btn.getAttribute('data-lat')) === Number(last.lat) && Number(btn.getAttribute('data-lng')) === Number(last.lng);
      if (on) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    });
  }

  // map.js가 window.destList = { dest, label, total, items:[{ name, lat, lng, meters, walkMin, status, facts:[] }] } 를 채운다
  var STATUS_TEXT = { open: '지금 운영 중', closed: '지금 운영 안 함', unknown: '운영 확인 필요' };

  function renderDestList(body) {
    var list = window.destList;
    var d = currentDest();
    if (!list || list.dest !== d || !Array.isArray(list.items)) {
      body.innerHTML = '<p class="status is-loading">가까운 ' + esc(DEST_LABEL[d]) + '을(를) 찾는 중이에요…</p>';
      return;
    }
    clearTimeout(recommendTimer);
    if (!list.items.length) {
      body.innerHTML = '<div class="rec-empty"><b>가까운 ' + esc(list.label) + ' 정보가 없어요.</b>다른 곳을 골라 보세요.</div>';
      return;
    }
    var html = '';
    // 교통 브리핑(역·버스·택시를 골랐을 때)
    if (list.brief && list.brief.length) {
      html += '<div class="brief">' +
        '<div class="brief-head"><b>교통 브리핑</b>' + speakButtonHtml('brief') + '</div><ul>' +
        list.brief.map(function (b) {
          return '<li><span class="brief-icon" aria-hidden="true">' + b.icon + '</span>' + esc(b.text) + '</li>';
        }).join('') + '</ul>' +
        (list.briefNote ? '<p class="brief-note">' + esc(list.briefNote) + '</p>' : '') + '</div>';
    }
    html += '<ol class="rec-list dest-list">';
    list.items.forEach(function (it, i) {
      var facts = '';
      if (it.status && STATUS_TEXT[it.status]) facts += '<span class="fact st-' + it.status + '">' + STATUS_TEXT[it.status] + '</span>';
      (it.facts || []).forEach(function (f) { facts += '<span class="fact">' + esc(f) + '</span>'; });
      html +=
        '<li>' +
          '<button type="button" class="rec-item" data-lat="' + esc(it.lat) + '" data-lng="' + esc(it.lng) + '">' +
            '<span class="rec-rank dest-rank" aria-label="' + (i + 1) + '번째로 가까움">' + (i + 1) + '</span>' +
            '<span>' +
              '<span class="rec-name">' + esc(it.name) + '</span>' +
              '<span class="rec-meta">도보 약 ' + it.walkMin + '분 · 직선 ' + Number(it.meters).toLocaleString() + 'm</span>' +
              (facts ? '<span class="rec-facts">' + facts + '</span>' : '') +
            '</span>' +
          '</button>' +
        '</li>';
    });
    html += '</ol>';
    if (list.total > list.items.length) {
      html += '<p class="hint">가까운 ' + list.items.length + '곳만 보여요. 나머지 ' + (list.total - list.items.length) + '곳은 지도에서 볼 수 있어요.</p>';
    }
    body.innerHTML = html;
    markGuideTarget();
  }

  /* ---------- 8-3. 음성 안내 [팀원1 추가] ---------- */
  // 브라우저에 들어 있는 음성 합성(Web Speech API)을 쓴다. 지원하지 않는 브라우저에서는 버튼이 안 보인다.
  var speakingKey = null;

  function canSpeak() {
    return 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined';
  }

  function speakButtonHtml(key) {
    if (!canSpeak()) return '';
    var on = speakingKey === key && window.speechSynthesis.speaking;
    return '<button type="button" class="speak-btn" data-speak="' + key + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      (on ? '<span aria-hidden="true">⏹</span> 멈춤' : '<span aria-hidden="true">🔊</span> 듣기') + '</button>';
  }

  function syncSpeakButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('.speak-btn'), function (b) {
      var on = speakingKey === b.getAttribute('data-speak') && window.speechSynthesis.speaking;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.innerHTML = on ? '<span aria-hidden="true">⏹</span> 멈춤' : '<span aria-hidden="true">🔊</span> 듣기';
    });
  }

  // 읽기 좋게: 괄호·가운뎃점을 쉼표로
  function speechClean(t) {
    return String(t).replace(/°/g, '도').replace(/\(/g, ', ').replace(/\)/g, '').replace(/·/g, ', ')
      .replace(/\s+,/g, ',').replace(/,(\s*,)+/g, ',').replace(/,\s*\./g, '.').replace(/\s+/g, ' ').trim();
  }

  function routeSpeech(plan) {
    var who = plan.profiles.length ? plan.profiles.map(function (id) { return PROFILE_LABEL[id]; }).join(', ') : '일반';
    var guide = plan.dest && plan.dest !== 'all';
    var parts = [];
    parts.push(guide ? who + ' 기준으로 ' + (DEST_LABEL[plan.dest] || '목적지') + '까지 길안내를 시작할게요.'
      : who + ' 기준 추천 동선을 안내할게요.');
    (plan.weatherNotes || []).forEach(function (n) { parts.push(n); });
    plan.stops.forEach(function (s) {
      var nth = ['첫', '두', '세', '네', '다섯', '여섯'][s.step - 1] || String(s.step);
      parts.push(nth + ' 번째, ' + s.label + '. ' + s.name + '까지 ' + (s.legPath ? '걸어서 ' : '직선으로 ') +
        s.legM + '미터, 약 ' + s.legMin + '분이에요.');
    });
    if (plan.stops.length) parts.push((guide ? '도착까지' : '모두 들르면') + ' 약 ' + plan.totalM + '미터, ' + plan.totalMin + '분 걸려요.');
    if (plan.stepsAvoided) parts.push('계단 없는 길로 골랐어요.');
    (plan.pathNotes || []).forEach(function (n) { parts.push(n); });
    return speechClean(parts.join(' '));
  }

  function briefSpeech(list) {
    var parts = ['교통 브리핑이에요.'];
    (list.brief || []).forEach(function (b) { parts.push(b.text.replace(/(\d[\d,]*)m/g, '$1미터') + '.'); });
    return speechClean(parts.join(' '));
  }

  function speak(key, text) {
    if (!canSpeak() || !text) return;
    var synth = window.speechSynthesis;
    if (speakingKey === key && synth.speaking) {   // 읽는 중에 다시 누르면 멈춤
      synth.cancel();
      speakingKey = null;
      syncSpeakButtons();
      return;
    }
    synth.cancel();
    var u = new window.SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = 1;
    var ko = (synth.getVoices() || []).filter(function (v) { return /^ko/i.test(v.lang); })[0];
    if (ko) u.voice = ko;
    u.onend = u.onerror = function () {
      if (speakingKey === key) speakingKey = null;
      syncSpeakButtons();
    };
    speakingKey = key;
    synth.speak(u);
    syncSpeakButtons();
  }

  function handleSpeakClick(event) {
    var btn = event.target.closest('.speak-btn');
    if (!btn) return;
    event.stopPropagation();
    var key = btn.getAttribute('data-speak');
    if (key === 'route' && window.routePlan) speak('route', routeSpeech(window.routePlan));
    if (key === 'brief' && window.destList) speak('brief', briefSpeech(window.destList));
  }

  /* ---------- 8-4. 어두운 화면 [팀원1 추가] ---------- */
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function syncThemeButton() {
    var btn = $('[data-role="theme-toggle"]');
    if (!btn) return;
    var dark = currentTheme() === 'dark';
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    btn.setAttribute('aria-label', dark ? '밝은 화면으로 보기' : '어두운 화면으로 보기');
    btn.innerHTML = dark ? '<span aria-hidden="true">☀️</span><span class="theme-text">밝게</span>'
      : '<span aria-hidden="true">🌙</span><span class="theme-text">어둡게</span>';
  }

  // 주차 그래프(Chart.js) 글자·눈금 색도 테마에 맞춘다
  function syncChartTheme() {
    if (typeof window.Chart === 'undefined') return;
    var dark = currentTheme() === 'dark';
    window.Chart.defaults.color = dark ? '#c9d6cf' : '#55605a';
    window.Chart.defaults.borderColor = dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.1)';
    var all = window.Chart.instances ? Object.keys(window.Chart.instances).map(function (k) { return window.Chart.instances[k]; }) : [];
    all.forEach(function (c) {
      ['x', 'y'].forEach(function (ax) {
        var sc = c.options.scales && c.options.scales[ax];
        if (!sc) return;
        if (sc.ticks) sc.ticks.color = window.Chart.defaults.color;
        if (sc.title) sc.title.color = window.Chart.defaults.color;
        if (sc.grid) sc.grid.color = window.Chart.defaults.borderColor;
      });
      if (c.options.plugins && c.options.plugins.legend && c.options.plugins.legend.labels) c.options.plugins.legend.labels.color = window.Chart.defaults.color;
      c.update('none');
    });
  }

  function setTheme(theme, save) {
    document.documentElement.setAttribute('data-theme', theme);
    if (save) { try { localStorage.setItem('opm-theme', theme); } catch (e) { /* 저장 못 해도 괜찮다 */ } }
    syncThemeButton();
    syncChartTheme();
    send('themechange', { theme: theme });
  }

  /* ---------- 8-2. 추천 동선: 들를 곳 순서 [팀원1 추가] ---------- */
  // map.js가 window.routePlan을 채우고 'routeready'를 보낸다. 상황을 안 고르면 routePlan은 null → 숨김.
  // routePlan = { stops:[{step, label, name, lat, lng, legM, legMin}], totalM, totalMin, missing:[], basis }
  // 항목은 추천 목록과 같은 .rec-item 버튼이라, 누르면 handleRecommendClick이 'focusplace'를 보낸다.

  function getRoutePlanBox() {
    var box = $('[data-role="route-plan"]');
    if (box) return box;
    var rec = document.getElementById('recommend-list');
    if (!rec) return null;
    box = document.createElement('div');
    box.className = 'route-plan';
    box.setAttribute('data-role', 'route-plan');
    box.setAttribute('aria-live', 'polite');
    box.hidden = true;
    rec.insertBefore(box, rec.firstChild);
    return box;
  }

  function renderRoutePlan() {
    var box = getRoutePlanBox();
    if (!box) return;
    var plan = window.routePlan;
    if (!plan) { box.hidden = true; box.innerHTML = ''; return; }

    var who = plan.profiles.length ? plan.profiles.map(function (id) { return PROFILE_LABEL[id]; }).join(' · ') : '일반';
    var guide = plan.dest && plan.dest !== 'all';
    var title = plan.title || '추천 동선';
    var sub = guide ? who + ' · ' + (DEST_LABEL[plan.dest] || '') + '까지' : who + ' · 들를 곳 순서';
    var html = '<div class="route-head"><h3 class="recommend-title">' + (guide ? '<span class="title-icon" aria-hidden="true">🧭</span>' : '') +
      esc(title) + ' <span class="sub">' + esc(sub) + '</span></h3>' + speakButtonHtml('route') + '</div>';

    // 날씨 때문에 바꾼 점 (날씨 맞춤 길안내)
    if (plan.weatherNotes && plan.weatherNotes.length) {
      html += '<ul class="route-weather' + (plan.weatherKind ? ' is-' + plan.weatherKind : '') + '">' +
        plan.weatherNotes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    }

    if (!plan.stops.length) {
      html += '<div class="rec-empty"><b>' + (guide ? '갈 곳을 찾지 못했어요.' : '들를 곳을 찾지 못했어요.') + '</b>지도에서 가까운 시설을 직접 확인해 주세요.</div>';
    } else {
      html += '<ol class="rec-list route-steps">';
      plan.stops.forEach(function (s) {
        var isWx = s.need === 'weather';
        var icon = isWx ? (WEATHER_ICON[plan.weatherKind] || '') : '';
        html +=
          '<li>' +
            '<button type="button" class="rec-item' + (isWx ? ' is-weather-stop' : '') + '" data-lat="' + esc(s.lat) + '" data-lng="' + esc(s.lng) + '">' +
              '<span class="rec-rank route-rank' + (isWx ? ' is-weather is-' + esc(plan.weatherKind) : '') + '" aria-label="' + s.step + '번째">' + s.step + '</span>' +
              '<span>' +
                '<span class="rec-name">' + (icon ? '<span aria-hidden="true">' + icon + '</span> ' : '') + esc(s.label) +
                  (isWx ? ' <span class="stop-tag">날씨 경유지</span>' : '') + '</span>' +
                '<span class="rec-meta">' + esc(s.name) + ' · ' + (s.step === 1 ? '여기서' : '앞 장소에서') +
                  (s.legPath ? ' 걸어서 ' : ' 직선 ') + Number(s.legM).toLocaleString() + 'm, 도보 약 ' + s.legMin + '분</span>' +
              '</span>' +
            '</button>' +
          '</li>';
      });
      html += '</ol>';
      html += '<p class="route-total">' + (guide ? '도착까지' : '모두 들르면') + (plan.pathBased ? ' 걸어서 ' : ' 직선 ') +
        Number(plan.totalM).toLocaleString() + 'm · 도보 약 ' + plan.totalMin + '분' +
        (plan.stepsAvoided ? ' <span class="stop-tag">계단 없는 길</span>' : '') + '</p>';
    }
    if (guide && !isToiletView()) {
      html += '<p class="hint">아래 목록에서 다른 곳을 누르면 그곳으로 길안내를 바꿔요.</p>';
    } else if (guide) {
      html += '<p class="hint">아래 추천 화장실 중 다른 곳을 누르면 그곳으로 길안내를 바꿔요.</p>';
    }
    if (plan.missing && plan.missing.length) {
      html += '<p class="hint">동선에서 뺀 곳: ' + esc(plan.missing.join(', ')) + '</p>';
    }
    (plan.pathNotes || []).forEach(function (n) { html += '<p class="route-warn">' + esc(n) + '</p>'; });
    html += plan.pathBased
      ? '<p class="route-warn">OpenStreetMap 걷는 길 기준이에요. 경사·공사·통제 구간은 반영되지 않아요.</p>'
      : '<p class="route-warn">직선거리 기준이에요. 실제 길은 더 멀거나 계단이 있을 수 있어요.</p>';

    box.innerHTML = html;
    box.hidden = false;
    markGuideTarget();
  }

  /* ---------- 9. 다른 파일이 보내는 이벤트 듣기 ---------- */
  // ui.js가 가장 먼저 실행되므로 바로 등록해 둔다.
  document.addEventListener('conditionready', renderCondition);
  document.addEventListener('recommendready', renderRecommendations);
  document.addEventListener('routeready', renderRoutePlan);   // [팀원1 추가]
  document.addEventListener('originchange', renderOrigin);    // [팀원1 추가]

  // map.js가 시설 데이터를 못 불러오면 보내는 이벤트 → 15초 기다리지 않고 바로 안내
  document.addEventListener('mapdataerror', function () {
    clearTimeout(recommendTimer);
    var body = $('[data-role="recommend-body"]');
    if (body) body.innerHTML = '<p class="status is-error">시설 데이터를 불러오지 못해 추천을 만들 수 없어요. 잠시 후 새로고침해 주세요.</p>';
  });

  /* ---------- 10. 화면 준비되면 버튼 연결 ---------- */
  function init() {
    var form = $('[data-role="keyword-form"]');
    if (form) form.addEventListener('submit', handleKeywordSubmit);

    getProfileBoxes().forEach(function (box) {
      box.addEventListener('change', applyProfiles);
    });

    var bar = document.getElementById('filter-bar');
    if (bar) bar.addEventListener('click', handleFilterClick);

    var dests = $('#dest-select .dest-options');                 // [팀원1 추가]
    if (dests) dests.addEventListener('click', handleDestClick);
    var origins = $('.origin-options');                            // [팀원1 추가]
    if (origins) origins.addEventListener('click', handleOriginClick);
    var recList = document.getElementById('recommend-list');       // [팀원1 추가] 음성 안내 버튼
    if (recList) recList.addEventListener('click', handleSpeakClick, true);
    var themeBtn = $('[data-role="theme-toggle"]');                // [팀원1 추가] 어두운 화면
    if (themeBtn) themeBtn.addEventListener('click', function () { setTheme(currentTheme() === 'dark' ? 'light' : 'dark', true); });
    syncThemeButton();
    // 직접 고른 적이 없으면 기기 설정(밝게/어둡게)을 따라간다
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        var saved = null;
        try { saved = localStorage.getItem('opm-theme'); } catch (e) { /* 무시 */ }
        if (!saved) setTheme(mq.matches ? 'dark' : 'light', false);
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
    // 주차 그래프가 그려진 뒤 색 맞추기
    setTimeout(syncChartTheme, 1500);

    var rec = document.getElementById('recommend-list');
    if (rec) rec.addEventListener('click', handleRecommendClick);

    var card = document.getElementById('condition-card');
    if (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('[data-role="concert-on"]')) turnOnConcert();
      });
    }

    // 새로고침 뒤 브라우저가 체크 상태를 기억한 경우에도 상태를 맞춘다
    window.appState.profiles = readProfiles();
    syncChipStyle();
    updateFemaleButton();
    updateRecommendBasis();
    updateDestBadges();                                           // [팀원1 추가]

    // 이미 값이 있으면 바로 그리기 (혹시 이벤트가 먼저 지나간 경우 대비)
    if (window.conditionInfo) renderCondition();
    else conditionTimer = setTimeout(showConditionError, WAIT_LIMIT_MS);

    if (window.routePlan !== undefined) renderRoutePlan();     // [팀원1 추가]
    if (Array.isArray(window.recommendations)) renderRecommendations();
    else recommendTimer = setTimeout(showRecommendError, WAIT_LIMIT_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
