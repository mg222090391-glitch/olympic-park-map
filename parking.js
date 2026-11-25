// =====================================================================
// parking.js - 올림픽공원 주차 붐빔 시간 그래프
// 담당: 팀원2(은혜)
//
// 하는 일
//   1. data/olympic_park_data.json의 parking_pattern.hourly를 불러온다.
//   2. #parking-section 안에 Chart.js 선 그래프(평일·주말, 0~23시)를 그린다.
//   3. 오늘이 평일인지 주말인지와 지금 시각(한국 시간)을 보고,
//      그 시각 평균이 같은 유형 하루 최댓값의 70% 이상이면
//      "지금은 평소에 붐비는 시간대예요"라고 안내한다.
//   4. 그래프 아래에 데이터 기준을 적는다.
//
// 필요한 것: index.html에 #parking-section 영역, Chart.js CDN (parking.js보다 먼저)
//
// index.html과 맞물리는 방식
//   - #parking-section 안에 <canvas id="parking-chart">가 있으면 거기에 그린다.
//     이때 제목·설명·안내 문구는 index.html에 이미 있으므로 새로 만들지 않고,
//     "지금 붐비는지" 문구만 .chart-box 바로 위에 넣는다.
//   - canvas가 없으면(혼자 테스트할 때) 제목, 그래프, 안내 문구를 직접 만든다.
//
// 디자인: 색과 글자 크기는 style.css의 변수(--mk-toilet, --mk-heat, --fs-small)를 읽어서 쓴다.
//         변수가 없으면 아래 STYLE 값을 쓴다.
//         "지금 붐비는지" 문구의 class: parking-now (붐빌 때 parking-now busy)
// =====================================================================

(function () {
  "use strict";

  // ---------- 설정 ----------
  const DATA_URL = "data/olympic_park_data.json";
  const BUSY_RATIO = 0.7; // 하루 최댓값의 70% 이상이면 "붐비는 시간대"

  const STYLE = {
    weekdayColor: "#1d4ed8", // 평일 선 색 (style.css --mk-toilet이 있으면 그 값)
    weekendColor: "#c2410c", // 주말 선 색 (style.css --mk-heat이 있으면 그 값)
    fontSize: 15, // 그래프 글자 크기(px) (style.css --fs-small이 있으면 그 값)
    chartHeight: 260, // canvas를 직접 만들 때만 쓰는 높이(px)
  };

  // style.css의 변수 읽기 (없으면 기본값)
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function cssFontPx(name, fallback) {
    const v = cssVar(name, "");
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    if (v.endsWith("rem")) return parseFloat(v) * rootPx;
    if (v.endsWith("px")) return parseFloat(v);
    return fallback;
  }

  const TEXT = {
    title: "올림픽공원 주차장 붐비는 시간",
    busy: "지금은 평소에 붐비는 시간대예요.",
    notBusy: "지금은 평소에 붐비는 시간대가 아니에요.",
    note: "2024년 7월 기록 기준 평균 주차 차량 수이며, 점유율(%)이 아닙니다.",
    error: "주차 정보를 불러오지 못했어요.",
  };

  // ---------- 한국 시간으로 지금 요일과 시각 구하기 ----------
  function nowInSeoul() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const get = function (type) {
      const p = parts.find(function (x) { return x.type === type; });
      return p ? p.value : "";
    };
    const weekday = get("weekday"); // "Mon" ~ "Sun"
    const hour = parseInt(get("hour"), 10) % 24;
    return { isWeekend: weekday === "Sat" || weekday === "Sun", hour: hour };
  }

  // ---------- 안내 문구 판단 ----------
  // 같은 유형(평일 또는 주말)의 하루 최댓값과 비교한다.
  function judgeNow(hourly, now) {
    const values = now.isWeekend ? hourly.weekend : hourly.weekday;
    const max = Math.max.apply(null, values);
    const current = values[now.hour];
    return {
      busy: max > 0 && current >= max * BUSY_RATIO,
      current: current,
    };
  }

  // ---------- 화면 요소 만들기 ----------
  function makeElement(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  function isValidHourly(hourly) {
    function ok(arr) {
      return Array.isArray(arr) && arr.length === 24 && arr.every(function (v) { return typeof v === "number"; });
    }
    return hourly && ok(hourly.weekday) && ok(hourly.weekend);
  }

  function draw(section, hourly) {
    const now = nowInSeoul();
    const result = judgeNow(hourly, now);
    const weekdayColor = cssVar("--mk-toilet", STYLE.weekdayColor);
    const weekendColor = cssVar("--mk-heat", STYLE.weekendColor);
    const fontSize = cssFontPx("--fs-small", STYLE.fontSize);

    // "지금 붐비는지" 문구 (팀원3의 .messages 모양을 그대로 쓴다)
    const nowBox = makeElement("ul", "messages parking-now" + (result.busy ? " busy" : ""));
    nowBox.appendChild(makeElement("li", "", result.busy ? TEXT.busy : TEXT.notBusy));
    nowBox.style.marginBottom = "12px";

    let canvas = section.querySelector("#parking-chart");
    if (canvas) {
      // index.html에 자리가 있는 경우: 문구만 그래프 위에 넣는다
      const box = canvas.closest(".chart-box") || canvas.parentElement;
      box.parentElement.insertBefore(nowBox, box);
    } else {
      // 혼자 테스트하는 경우: 제목, 그래프 칸, 안내 문구를 직접 만든다
      const chartBox = makeElement("div", "chart-box");
      chartBox.style.position = "relative";
      chartBox.style.height = STYLE.chartHeight + "px";
      canvas = document.createElement("canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "평일과 주말의 시간대별 평균 주차 차량 수 그래프");
      chartBox.appendChild(canvas);
      section.appendChild(makeElement("h3", "parking-title", TEXT.title));
      section.appendChild(nowBox);
      section.appendChild(chartBox);
      section.appendChild(makeElement("p", "parking-note", TEXT.note));
    }

    const labels = [];
    for (let h = 0; h < 24; h++) labels.push(h + "시");

    // 지금 시각의 점만 크게 표시한다 (오늘 유형의 선에만).
    function pointSizes(isToday) {
      return labels.map(function (_, h) { return isToday && h === now.hour ? 7 : 2; });
    }

    new Chart(canvas, {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: "평일",
            data: hourly.weekday.map(function (v) { return Math.round(v); }),
            borderColor: weekdayColor,
            backgroundColor: weekdayColor,
            pointRadius: pointSizes(!now.isWeekend),
            tension: 0.3,
          },
          {
            label: "주말",
            data: hourly.weekend.map(function (v) { return Math.round(v); }),
            borderColor: weekendColor,
            backgroundColor: weekendColor,
            pointRadius: pointSizes(now.isWeekend),
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { font: { size: fontSize } } },
          tooltip: {
            callbacks: {
              label: function (ctx) { return ctx.dataset.label + ": 평균 약 " + ctx.parsed.y.toLocaleString() + "대"; },
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: "시각", font: { size: fontSize } },
            ticks: { font: { size: fontSize }, maxRotation: 0, autoSkip: true },
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: "평균 주차 차량 수(대)", font: { size: fontSize } },
            ticks: { font: { size: fontSize } },
          },
        },
      },
    });
  }

  function showError(section, message) {
    const err = makeElement("p", "status is-error parking-now", TEXT.error);
    const box = section.querySelector(".chart-box");
    if (box) box.parentElement.insertBefore(err, box);
    else section.appendChild(err);
    console.error("[parking.js] " + message);
  }

  // ---------- 시작 ----------
  async function init() {
    const section = document.getElementById("parking-section");
    if (!section) {
      console.error("[parking.js] #parking-section 영역이 없어요.");
      return;
    }
    if (typeof window.Chart === "undefined") {
      showError(section, "Chart.js가 불러와지지 않았어요. index.html의 CDN 순서를 확인하세요.");
      return;
    }
    try {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error(DATA_URL + " 응답 코드 " + res.status);
      const data = await res.json();
      const hourly = data && data.parking_pattern && data.parking_pattern.hourly;
      if (!isValidHourly(hourly)) throw new Error("parking_pattern.hourly 형식이 맞지 않아요 (weekday, weekend 각각 숫자 24개).");
      draw(section, hourly);
    } catch (e) {
      showError(section, e.message);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
