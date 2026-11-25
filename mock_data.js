/* mock_data.js — 미리보기용 "가상" 데이터 (실제 시설 정보가 아님!)
 * 주소 뒤에 ?demo 를 붙여 열 때만 map.js가 불러온다. 예) https://…/olympic-park-map/?demo
 * 진짜 data/olympic_park_data.json 이 올라오면 이 파일은 지워도 된다.
 * 필드 이름은 map.js가 읽는 이름과 같게 맞췄다.
 */
window.__PARK_DATA__ = {
  meta: { park_center: [37.5194, 127.1218], is_mock: true },
  toilets: [
    { name: '샘플 화장실 A', lat: 37.5168, lng: 127.1196, total: 14, female_stalls: 8, male_fixtures: 6, accessible_stalls: 2, diaper_table: 'Y', emergency_bell: 'Y', open: '상시', source: '가상 데이터' },
    { name: '샘플 화장실 B', lat: 37.5211, lng: 127.1174, total: 9, female_stalls: 5, male_fixtures: 4, accessible_stalls: 1, diaper_table: 'Y', emergency_bell: 'Y', open: '06:00~22:00', source: '가상 데이터' },
    { name: '샘플 화장실 C', lat: 37.5232, lng: 127.1236, total: 6, female_stalls: 3, male_fixtures: 3, accessible_stalls: 0, diaper_table: 'N', emergency_bell: 'Y', open: '06:00~22:00', source: '가상 데이터' },
    { name: '샘플 화장실 D', lat: 37.5187, lng: 127.1262, total: 20, female_stalls: 12, male_fixtures: 8, accessible_stalls: 2, diaper_table: 'Y', emergency_bell: 'Y', open: '상시', source: '가상 데이터' },
    { name: '샘플 화장실 E', lat: 37.5159, lng: 127.1243, total: 8, female_stalls: 4, male_fixtures: 4, accessible_stalls: 1, diaper_table: 'N', emergency_bell: 'N', open: '09:00-18:00', source: '가상 데이터' },
    { name: '샘플 화장실 F', lat: 37.5203, lng: 127.1290, total: 10, female_stalls: 6, male_fixtures: 4, accessible_stalls: 1, diaper_table: 'Y', emergency_bell: 'Y', open: '06:00~23:00', source: '가상 데이터' },
    { name: '샘플 화장실 G', lat: 37.5222, lng: 127.1205, total: 4, female_stalls: 2, male_fixtures: 2, accessible_stalls: 0, diaper_table: null, emergency_bell: 'Y', open: null, source: '가상 데이터' },
    { name: '샘플 화장실 H (공사 중)', lat: 37.5176, lng: 127.1150, total: 6, female_stalls: 3, male_fixtures: 3, accessible_stalls: 1, diaper_table: 'Y', emergency_bell: 'Y', open: '공사로 임시 폐쇄', source: '가상 데이터' },
  ],
  facilities: [
    { type: '편의점', place: '샘플 편의점 1', detail: '가상 위치', lat: 37.5180, lng: 127.1215 },
    { type: '편의점', place: '샘플 편의점 2', detail: '가상 위치', lat: 37.5214, lng: 127.1268 },
    { type: '카페', place: '샘플 카페', detail: '가상 위치', lat: 37.5198, lng: 127.1186 },
    { type: '자판기', place: '샘플 자판기', detail: '가상 위치', lat: 37.5226, lng: 127.1256 },
    { type: '수유실', place: '샘플 수유실', detail: '가상 위치', lat: 37.5172, lng: 127.1229, note: '가상 데이터' },
  ],
  heat_shelters: [
    { name: '샘플 무더위쉼터', kind: '실내', facility: '가상 시설', days: '매일', hours: '09:00~18:00', weekend_extra: 'N', dist_from_park_m: 120, lat: 37.5150, lng: 127.1270 },
  ],
  cold_shelters: [
    { name: '샘플 한파쉼터', kind: '실내', facility: '가상 시설', who: '누구나', note: '가상 데이터', dist_from_park_m: 180, lat: 37.5243, lng: 127.1180 },
  ],
  wheelchair_chargers: [
    { name: '샘플 전동휠체어 충전기', detail: '가상 위치', weekday: '09:00~18:00', holiday: '10:00~17:00', slots: 2, lat: 37.5191, lng: 127.1241 },
  ],
  subway_elevators: [
    { station: '샘플역 1번 출구', lat: 37.5163, lng: 127.1306 },
    { station: '샘플역 2번 출구', lat: 37.5172, lng: 127.1128 },
  ],
  aed: [
    { name: '샘플 관리사무소', detail: '가상 위치 1층', lat: 37.5196, lng: 127.1230 },
  ],
};
