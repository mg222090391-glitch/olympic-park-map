"""공공데이터 CSV → data/parking.json (주차 화면용)

사용법:
  python3 tools/build_parking.py 입출차.csv 전국주차장정보표준데이터.csv 서울시_차량_출입구_정보.csv 전국주정차금지_지정_구역표준데이터.csv
결과: data/parking.json

들어가는 것
  pattern   : 올림픽공원 입출차 기록 → 요일·시각별 '주차장 안에 있던 차' 평균, '들어온 차' 평균, 머문 시간
              (기록에 주차장 구분 칸이 없어 공원 전체를 합친 값)
  lots      : 전국주차장정보표준데이터 중 공원 중심 1.6km 안 주차장 (요금·면수·운영시간·할인)
  inPark    : 서울시 차량 출입구 정보 중 공원 안 시설(한성백제박물관·소마미술관) 출입구
  noParking : 전국주정차금지구역 중 송파구 위례성대로 구간
"""
import sys, math, json, re, datetime
import numpy as np
import pandas as pd

IO_CSV, LOT_CSV, GATE_CSV, NOPARK_CSV = sys.argv[1:5]
OUT = 'data/parking.json'
CENTER = (37.5189, 127.1239)
NEAR_M = 1600
IN_PARK_FACILITIES = ['한성백제박물관', '소마미술관']
DOW = '월화수목금토일'


def hv(a, b, c, d):
    r = math.radians
    x, y = r(c - a), r(d - b)
    h = math.sin(x / 2) ** 2 + math.cos(r(a)) * math.cos(r(c)) * math.sin(y / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def num(x):
    try:
        f = float(x)
        return int(f) if f == int(f) else f
    except (TypeError, ValueError):
        return None


def discounts(text):
    out = {}
    if not isinstance(text, str):
        return out
    for seg in text.split('*'):
        m = re.match(r'\s*(\d+)\s*할인(.*)', seg)
        if not m:
            continue
        pct, body = int(m.group(1)), m.group(2)
        for key, word in [('disabled', '장애인'), ('veteran', '국가유공'), ('compact', '경차'), ('eco', '저공해'),
                          ('multichild3', '3자녀'), ('multichild2', '2자녀')]:
            if word in body:
                out[key] = pct
    return out


out = {}

# 1) 입출차
d = pd.read_csv(IO_CSV, encoding='cp949')
d['in'] = pd.to_datetime(d['입차일시'], errors='coerce')
d['out'] = pd.to_datetime(d['출차일시'], errors='coerce')
d['stay'] = (d['out'] - d['in']).dt.total_seconds() / 60
v = d[(d.stay > 0) & (d.stay < 2 * 24 * 60)].copy()
first, last = v['in'].min().normalize(), v['in'].max().normalize()
days = pd.date_range(first, last, freq='D')
ins = np.sort(v['in'].values.astype('datetime64[m]'))
outs = np.sort(v['out'].values.astype('datetime64[m]'))
occ = {k: [[] for _ in range(24)] for k in range(7)}
for day in days:
    for h in range(24):
        t = np.datetime64(day + pd.Timedelta(hours=h), 'm')
        occ[day.dayofweek][h].append(int(np.searchsorted(ins, t, 'right') - np.searchsorted(outs, t, 'right')))
present = {DOW[k]: [round(float(np.mean(occ[k][h])), 1) for h in range(24)] for k in range(7)}
v['dow'], v['h'] = v['in'].dt.dayofweek, v['in'].dt.hour
ndays = {k: sum(1 for x in days if x.dayofweek == k) for k in range(7)}
arrivals = {DOW[k]: [round(float(((v.dow == k) & (v.h == h)).sum()) / ndays[k], 1) for h in range(24)] for k in range(7)}
peak = max(((k, h, val) for k, arr in present.items() for h, val in enumerate(arr)), key=lambda x: x[2])
wk = v['in'].dt.dayofweek >= 5
daily = v.groupby(v['in'].dt.date).size()
out['pattern'] = {
    'source': f'한국체육산업개발 올림픽공원 입출차 정보 ({first:%Y년 %-m월}, {len(d):,}건 중 머문 시간 0분 초과·2일 미만 {len(v):,}건)',
    'note': '주차장 구분 칸이 없어 공원 전체 주차장을 합친 값이에요. 주차장 전체 면수 정보가 없어 점유율(%)이 아니라 평소 대비 붐빔으로만 봐요.',
    'present_by_dow': present,
    'arrivals_by_dow': arrivals,
    'peak_present': round(peak[2], 1),
    'peak_at': {'dow': peak[0], 'hour': peak[1]},
    'daily_avg': int(round(daily.mean())),
    'busiest_day': {'date': str(daily.idxmax()), 'cars': int(daily.max())},
    'stay_median_min': {'weekday': int(v[~wk].stay.median()), 'weekend': int(v[wk].stay.median())},
    'stay_share': {'le30': round(float((v.stay <= 30).mean()), 3), 'gt240': round(float((v.stay > 240).mean()), 3)},
}

# 2) 공원 근처 주차장
p = pd.read_csv(LOT_CSV, encoding='cp949', dtype=str)
p['lat'] = pd.to_numeric(p['위도'], errors='coerce')
p['lng'] = pd.to_numeric(p['경도'], errors='coerce')
p = p.dropna(subset=['lat', 'lng'])
p['dist'] = [hv(CENTER[0], CENTER[1], a, b) for a, b in zip(p.lat, p.lng)]
lots = []
for _, r in p[p.dist < NEAR_M].sort_values('dist').iterrows():
    dpass = num(r['1일주차권요금'])
    lots.append({
        'id': r['주차장관리번호'], 'name': r['주차장명'], 'kind': r['주차장유형'], 'spaces': num(r['주차구획수']),
        'address': r['소재지지번주소'], 'lat': round(float(r.lat), 6), 'lng': round(float(r.lng), 6), 'days': r['운영요일'],
        'hours': {'weekday': [r['평일운영시작시각'], r['평일운영종료시각']], 'sat': [r['토요일운영시작시각'], r['토요일운영종료시각']],
                  'holiday': [r['공휴일운영시작시각'], r['공휴일운영종료시각']]},
        'paid': r['요금정보'] == '유료',
        'fee': {'baseMin': num(r['주차기본시간']), 'base': num(r['주차기본요금']), 'addMin': num(r['추가단위시간']),
                'add': num(r['추가단위요금']), 'dayPass': dpass if dpass else None},
        'discounts': discounts(r['특기사항']), 'accessible': r['장애인전용주차구역보유여부'] == 'Y',
        'manager': r['관리기관명'], 'phone': r['전화번호'], 'dataDate': r['데이터기준일자'],
    })
out['lots'] = lots
out['lots_source'] = f'전국주차장정보표준데이터 (공원 중심 {NEAR_M / 1000:.1f}km 안, 데이터 기준일 {max(l["dataDate"] for l in lots)})'

# 3) 공원 안 시설 주차 출입구
e = pd.read_csv(GATE_CSV, encoding='cp949', dtype=str)
e['lat'] = pd.to_numeric(e['위도'], errors='coerce')
e['lng'] = pd.to_numeric(e['경도'], errors='coerce')


def fmt(h):
    a, b = h.split('-')
    return a[:2] + ':' + a[2:] + '~' + b[:2] + ':' + b[2:]


def excel_date(x):
    return str(datetime.date(1899, 12, 30) + datetime.timedelta(days=int(x))) if str(x).isdigit() else x


fac = []
for name in IN_PARK_FACILITIES:
    g = e[e['시설명'] == name].sort_values('출입구 아이디')
    if g.empty:
        continue
    heights = [float(x.rstrip('Mm')) for x in g['출입구 높이제한 구조물 높이'].dropna()]
    etc = sorted(set(g['기타'].dropna()))
    f0 = g.iloc[0]
    fac.append({'name': name + ' 주차장', 'lat': round(float(f0.lat), 6), 'lng': round(float(f0.lng), 6),
                'entrances': int(len(g)), 'heightLimitM': min(heights) if heights else None,
                'hours': [fmt(h) for h in sorted(set(g['평일 허용시간'].dropna()))],
                'note': ' · '.join(etc) if etc else None, 'dataDate': excel_date(f0['데이터 기준일자'])})
out['inPark'] = fac
out['inPark_source'] = '서울시 차량 출입구 정보'

# 4) 주정차 금지
z = pd.read_csv(NOPARK_CSV, encoding='cp949', dtype=str)
z = z[(z['시군구명'] == '송파구') & (z['도로명'] == '위례성대로')]
out['noParking'] = [{'road': r['도로명'], 'where': r['상세위치'], 'lengthKm': num(r['금지구역총연장']),
                     'weekday': [r['평일주정차금지시작시각'], r['평일주정차금지종료시각']],
                     'manager': r['관리기관명'], 'phone': r['관리기관전화번호']} for _, r in z.iterrows()]
out['noParking_source'] = '전국주정차금지(지정)구역표준데이터'

json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('저장:', OUT, '| 주차장', len(lots), '곳 · 공원 안', len(fac), '곳 · 주정차 금지', len(out['noParking']), '곳')
