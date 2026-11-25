// =====================================================================
// weather.js - 날씨 불러오기와 규칙 판단
// 담당: 팀원2(은혜)
//
// 하는 일
//   1. 날씨 중계 서버(Cloudflare Worker)에서 날씨를 불러온다.
//      실패하면 data/weather_sample.json을 대신 쓴다.
//   2. data/rules.json을 불러와 지금 날씨와 사용자 상황(appState.profiles)에 맞는 규칙을 고른다.
//   3. window.conditionInfo를 채우고 document에 conditionready 이벤트를 보낸다.
//   4. profilechange 이벤트를 들으면 규칙을 다시 고르고 conditionready를 다시 보낸다.
//
// 화면에 그리는 일은 하지 않는다. (컨디션 카드는 팀원3의 ui.js, 쉼터 강조는 팀원1의 map.js)
//
// window.conditionInfo 형식 (팀 약속 7번)
//   {
//     weather: { temp, feelsLike, rain, sky, uv, baseTime },
//     messages: ["안내 문구", ...],
//     needHeatShelter: true/false,
//     needColdShelter: true/false,
//     source: "live" 또는 "sample"
//   }
//
// 시연용: 주소 뒤에 ?weather=sample 을 붙이면 Worker를 부르지 않고 샘플 날씨를 쓴다.
// =====================================================================

(function () {
  "use strict";

  // ---------- 설정 ----------
  // Cloudflare Worker 주소 (키가 아니라서 코드에 써도 괜찮다)
  const WORKER_URL = "https://olympic-weather.eunhyekim0814.workers.dev";
  const SAMPLE_URL = "data/weather_sample.json";
  const RULES_URL = "data/rules.json";
  const TIMEOUT_MS = 6000; // Worker가 이 시간 안에 답하지 않으면 샘플로 바꾼다

  // 지금 불러온 날씨와 규칙 (처음에는 비어 있음)
  let weather = null; // { temp, feelsLike, rain, sky, uv, baseTime }
  let source = null; // "live" 또는 "sample"
  let rules = [];
  let ready = false;

  // ---------- 공유 상태 준비 ----------
  // ui.js가 아직 없을 때(혼자 테스트할 때)를 위한 임시 appState
  if (!window.appState) {
    window.appState = {
      profiles: [],
      filters: { diaper: false, bell: false, openNow: false, femaleStalls: false },
      userLocation: null,
    };
  }

  // ---------- 불러오기 ----------
  async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
    try {
      const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!res.ok) throw new Error(url + " 응답 코드 " + res.status);
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 받은 날씨가 쓸 수 있는 형식인지 확인하고, 약속된 6개 칸만 남긴다.
  function cleanWeather(raw) {
    if (!raw || typeof raw.temp !== "number") return null;
    return {
      temp: raw.temp,
      feelsLike: typeof raw.feelsLike === "number" ? raw.feelsLike : raw.temp,
      rain: raw.rain === true,
      sky: typeof raw.sky === "string" ? raw.sky : null,
      uv: typeof raw.uv === "number" ? raw.uv : null,
      baseTime: typeof raw.baseTime === "string" ? raw.baseTime : null,
    };
  }

  function wantsSample() {
    try {
      return new URLSearchParams(window.location.search).get("weather") === "sample";
    } catch (e) {
      return false;
    }
  }

  async function loadWeather() {
    if (!wantsSample()) {
      try {
        const live = cleanWeather(await fetchJson(WORKER_URL, TIMEOUT_MS));
        if (live) return { weather: live, source: "live" };
        console.warn("[weather.js] Worker 응답 형식이 맞지 않아 샘플 날씨를 씁니다.");
      } catch (e) {
        console.warn("[weather.js] Worker를 부르지 못해 샘플 날씨를 씁니다.", e.message);
      }
    }
    const sample = cleanWeather(await fetchJson(SAMPLE_URL));
    if (!sample) throw new Error("weather_sample.json 형식이 맞지 않아요.");
    return { weather: sample, source: "sample" };
  }

  // ---------- 규칙 판단 ----------
  // when의 조건을 모두 만족하면 true (feelsLikeMin, feelsLikeMax는 그 값을 포함)
  function conditionMatches(when, w) {
    if (!when) return false;
    if (when.feelsLikeMin !== undefined && !(w.feelsLike >= when.feelsLikeMin)) return false;
    if (when.feelsLikeMax !== undefined && !(w.feelsLike <= when.feelsLikeMax)) return false;
    if (when.rain !== undefined && w.rain !== when.rain) return false;
    if (when.uvMin !== undefined && !(w.uv !== null && w.uv >= when.uvMin)) return false;
    return true;
  }

  // profiles가 ["all"]이거나 지금 고른 프로필과 하나라도 겹치면 true
  function profileMatches(ruleProfiles, selected) {
    if (!Array.isArray(ruleProfiles)) return false;
    if (ruleProfiles.indexOf("all") !== -1) return true;
    return ruleProfiles.some(function (p) { return selected.indexOf(p) !== -1; });
  }

  function evaluate() {
    const selected = Array.isArray(window.appState.profiles) ? window.appState.profiles : [];
    const matched = rules.filter(function (r) {
      return conditionMatches(r.when, weather) && profileMatches(r.profiles, selected);
    });

    window.conditionInfo = {
      weather: Object.assign({}, weather),
      messages: matched.map(function (r) { return r.message; }),
      needHeatShelter: matched.some(function (r) { return r.shelter === "heat"; }),
      needColdShelter: matched.some(function (r) { return r.shelter === "cold"; }),
      source: source,
    };

    document.dispatchEvent(new CustomEvent("conditionready", { detail: window.conditionInfo }));
  }

  // ---------- 시작 ----------
  async function init() {
    try {
      const [w, r] = await Promise.all([loadWeather(), fetchJson(RULES_URL)]);
      weather = w.weather;
      source = w.source;
      rules = Array.isArray(r) ? r : [];
      ready = true;
      evaluate();
    } catch (e) {
      // 샘플 파일까지 못 불러오면 conditionready를 보내지 않는다.
      console.error("[weather.js] 날씨 또는 규칙을 불러오지 못했어요.", e.message);
    }
  }

  // 사용자가 상황을 바꾸면 날씨는 다시 부르지 않고 규칙만 다시 고른다.
  document.addEventListener("profilechange", function () {
    if (ready) evaluate();
  });

  init();
})();
