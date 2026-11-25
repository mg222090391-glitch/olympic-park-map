// =====================================================================
// 올림픽공원 편의시설 지도 - 날씨 중계 서버 (Cloudflare Worker)
// 담당: 팀원2(은혜)
//
// 하는 일
//   기상청 단기예보(초단기실황, 초단기예보)와 생활기상지수(자외선)를 불러서
//   화면에 필요한 값만 JSON으로 돌려준다.
//
// 돌려주는 JSON (window.conditionInfo.weather와 같은 형식)
//   {
//     "temp": 4.9,              기온(℃), 초단기실황 T1H
//     "feelsLike": 1.7,         체감온도(℃), 기상청 공식으로 계산
//     "rain": false,            지금 비·눈이 오거나 6시간 안에 올 예보가 있으면 true
//     "sky": "맑음",            하늘 상태: 맑음 / 구름많음 / 흐림 (못 받으면 null)
//     "uv": 2,                  자외선지수 (못 받으면 null)
//     "baseTime": "2026-11-19 13:00",  기온 관측 기준 시각(한국 시간)
//     "missing": []             못 받은 항목 이름 (확인용)
//   }
//
// 중요
//   - 인증키는 코드에 쓰지 않는다. Cloudflare의 Secret(이름: SERVICE_KEY)에서 읽는다.
//   - SERVICE_KEY에는 data.go.kr의 "일반 인증키(Decoding)"를 넣는다.
//   - 오류 메시지에도 키나 요청 주소를 넣지 않는다.
// =====================================================================

// ---------- 설정 ----------
const FCST_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
const LIFE_URL = "https://apis.data.go.kr/1360000/LivingWthrIdxServiceV5";

// 올림픽공원 격자 좌표 (활용가이드 격자 엑셀: 송파구·방이2동 = 62, 126)
const NX = 62;
const NY = 126;

// 자외선지수 지점코드 (방이2동 행정구역코드)
const UV_AREA_NO = "1171056200";

// 같은 응답을 다시 쓰는 시간(초). 기상청 API 하루 호출 한도를 아끼기 위함.
const CACHE_SECONDS = 600;

// 하늘 상태 코드 (활용가이드: 맑음 1, 구름많음 3, 흐림 4)
const SKY_TEXT = { "1": "맑음", "3": "구름많음", "4": "흐림" };

// ---------- CORS 헤더 ----------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=" + CACHE_SECONDS,
    },
  });
}

// ---------- 시간 계산 (Worker는 UTC로 돌기 때문에 한국 시간으로 바꿔서 쓴다) ----------
function kstNow() {
  // 한국 시간 = UTC + 9시간. 이 Date 객체는 getUTC... 함수로만 읽는다.
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function ymd(d) {
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
}

function addHours(d, h) {
  return new Date(d.getTime() + h * 60 * 60 * 1000);
}

// 초단기실황: 매시 정각 발표, 10분 뒤부터 조회 가능
// back = 0이면 가장 최근 발표, 1이면 그 한 시간 전
function ncstBase(now, back) {
  let t = new Date(now.getTime());
  if (t.getUTCMinutes() < 10) t = addHours(t, -1);
  t = addHours(t, -back);
  return { date: ymd(t), time: pad(t.getUTCHours()) + "00" };
}

// 초단기예보: 매시 30분 발표, 45분 뒤부터 조회 가능
function ultraFcstBase(now, back) {
  let t = new Date(now.getTime());
  if (t.getUTCMinutes() < 45) t = addHours(t, -1);
  t = addHours(t, -back);
  return { date: ymd(t), time: pad(t.getUTCHours()) + "30" };
}

// 자외선지수: 00, 03, 06, ..., 21시 발표 (time 형식: YYYYMMDDHH)
// back = 0이면 지금 시각이 속한 3시간 구간의 발표, 1이면 그 이전 발표
function uvBase(now, back) {
  let t = new Date(now.getTime());
  const h = t.getUTCHours() - (t.getUTCHours() % 3);
  t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h));
  t = addHours(t, -3 * back);
  return t;
}

// ---------- 기상청 API 호출 ----------
// 성공하면 item 배열을 돌려주고, 실패하면 null을 돌려준다.
async function callKma(baseUrl, operation, params, serviceKey) {
  const query = new URLSearchParams({
    serviceKey: serviceKey,
    pageNo: "1",
    numOfRows: "1000",
    dataType: "JSON",
    ...params,
  });

  let text;
  try {
    const res = await fetch(baseUrl + "/" + operation + "?" + query.toString());
    if (!res.ok) return null;
    text = await res.text();
  } catch (e) {
    return null;
  }

  // 키 오류 같은 경우에는 JSON을 요청해도 XML로 오는 일이 있어서 둘 다 대비한다.
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return null;
  }

  const header = data && data.response && data.response.header;
  if (!header || header.resultCode !== "00") return null;

  const items = data.response.body && data.response.body.items && data.response.body.items.item;
  if (!items) return null;
  return Array.isArray(items) ? items : [items];
}

// 최근 발표가 아직 안 올라왔을 수 있어서, 한 번 더 이전 발표로 다시 시도한다.
async function getNcst(now, key) {
  for (let back = 0; back < 2; back++) {
    const base = ncstBase(now, back);
    const items = await callKma(FCST_URL, "getUltraSrtNcst",
      { base_date: base.date, base_time: base.time, nx: String(NX), ny: String(NY) }, key);
    if (items && items.length) return { items: items, base: base };
  }
  return null;
}

async function getUltraFcst(now, key) {
  for (let back = 0; back < 2; back++) {
    const base = ultraFcstBase(now, back);
    const items = await callKma(FCST_URL, "getUltraSrtFcst",
      { base_date: base.date, base_time: base.time, nx: String(NX), ny: String(NY) }, key);
    if (items && items.length) return items;
  }
  return null;
}

async function getUv(now, key) {
  for (let back = 0; back < 2; back++) {
    const issued = uvBase(now, back);
    const time = ymd(issued) + pad(issued.getUTCHours());
    const items = await callKma(LIFE_URL, "getUVIdxV5", { areaNo: UV_AREA_NO, time: time }, key);
    if (!items || !items.length) continue;

    // 발표 시각부터 지금까지 몇 시간 지났는지 보고, 그 시각에 맞는 h0, h3, h6... 값을 고른다.
    const passed = Math.floor((now.getTime() - issued.getTime()) / (60 * 60 * 1000));
    const slot = Math.max(0, passed - (passed % 3));
    const value = items[0]["h" + slot];
    if (value !== undefined && value !== null && value !== "") {
      const n = Number(value);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

// ---------- 체감온도 (기상청 기상자료개방포털 공식) ----------
// 여름철(5~9월): 기온과 습도로 계산
// 겨울철(10~4월): 기온과 풍속으로 계산. 기온 10℃ 이하, 풍속 1.3m/s 이상일 때만 계산하고 아니면 기온을 쓴다.
function feelsLikeTemp(month, ta, rh, windMs) {
  if (month >= 5 && month <= 9) {
    if (rh === null) return ta;
    // 습구온도 Tw (Stull의 추정식)
    const tw = ta * Math.atan(0.151977 * Math.sqrt(rh + 8.313659))
      + Math.atan(ta + rh)
      - Math.atan(rh - 1.67633)
      + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh)
      - 4.686035;
    return -0.2442 + 0.55399 * tw + 0.45535 * ta - 0.0022 * tw * tw + 0.00278 * tw * ta + 3.0;
  }
  if (windMs === null || ta > 10 || windMs < 1.3) return ta;
  const v = Math.pow(windMs * 3.6, 0.16); // 풍속을 km/h로 바꾼 뒤 0.16제곱
  return 13.12 + 0.6215 * ta - 11.37 * v + 0.3965 * v * ta;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) || Math.abs(n) >= 900 ? null : n; // ±900 이상은 결측값
}

// ---------- 날씨 정리 ----------
async function buildWeather(key) {
  const now = kstNow();
  const missing = [];

  // 세 API를 동시에 부른다.
  const [ncst, fcst, uv] = await Promise.all([
    getNcst(now, key),
    getUltraFcst(now, key),
    getUv(now, key),
  ]);

  // 기온이 없으면 카드를 만들 수 없으니 실패로 처리한다. (weather.js가 샘플 파일로 바꾼다)
  if (!ncst) return null;

  const obs = {};
  for (const it of ncst.items) obs[it.category] = numOrNull(it.obsrValue);

  const temp = obs.T1H;
  if (temp === null || temp === undefined) return null;

  const rh = obs.REH === undefined ? null : obs.REH;
  const wind = obs.WSD === undefined ? null : obs.WSD;
  const month = now.getUTCMonth() + 1;
  const feelsLike = round1(feelsLikeTemp(month, temp, rh, wind));

  // 비: 지금 강수 형태(PTY)가 0이 아니면 true
  let rain = obs.PTY !== null && obs.PTY !== undefined && obs.PTY > 0;

  // 하늘 상태와 6시간 안의 비 예보는 초단기예보에서 본다.
  let sky = null;
  if (fcst) {
    const skyItems = fcst
      .filter((it) => it.category === "SKY")
      .sort((a, b) => (a.fcstDate + a.fcstTime).localeCompare(b.fcstDate + b.fcstTime));
    if (skyItems.length) sky = SKY_TEXT[String(skyItems[0].fcstValue)] || null;
    if (fcst.some((it) => it.category === "PTY" && numOrNull(it.fcstValue) > 0)) rain = true;
  }
  if (!fcst) missing.push("ultraFcst");
  if (sky === null) missing.push("sky");
  if (uv === null) missing.push("uv");

  const b = ncst.base;
  const baseTime = b.date.slice(0, 4) + "-" + b.date.slice(4, 6) + "-" + b.date.slice(6, 8)
    + " " + b.time.slice(0, 2) + ":" + b.time.slice(2, 4);

  return { temp, feelsLike, rain, sky, uv, baseTime, missing };
}

// ---------- 요청 처리 ----------
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "GET 요청만 받아요." }, 405);
    }
    if (!env.SERVICE_KEY) {
      return jsonResponse({ error: "SERVICE_KEY Secret이 설정되지 않았어요." }, 500);
    }

    // 10분 동안은 저장해 둔 응답을 그대로 돌려준다 (Cloudflare 무료 캐시).
    const cache = caches.default;
    const cacheKey = new Request(new URL("/weather", request.url).toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let weather;
    try {
      weather = await buildWeather(env.SERVICE_KEY);
    } catch (e) {
      weather = null;
    }

    if (!weather) {
      // 실패한 응답은 저장하지 않는다.
      return jsonResponse({ error: "기상청 날씨를 불러오지 못했어요." }, 502);
    }

    const response = jsonResponse(weather, 200);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
