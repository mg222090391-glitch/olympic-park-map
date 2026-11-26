/* =====================================================================
 * nav.js — 휴대폰 화면 바꾸기 (탭 · 홈 메뉴 · 뒤로 가기)
 * ---------------------------------------------------------------------
 *  - index.html의 .screen[data-screen="이름"] 중 하나에만 is-active를 붙인다.
 *  - data-go="이름" 이 붙은 버튼(아래 탭, 홈 메뉴, '지도에서 보기' 등)을 누르면 그 화면으로 간다.
 *  - 다른 팀원 파일은 고치지 않는다. 대신 이런 때 알아서 알맞은 화면을 연다:
 *      · ui.js가 지도로 스크롤하려 할 때(scrollIntoView) → 그 요소가 있는 화면으로
 *      · 'focusplace'(목록에서 장소를 누름), 'emergencyroute'(응급 화면에서 AED 길안내) → 지도 화면
 *  - 휴대폰 '뒤로' 버튼을 누르면 앞 화면으로 돌아간다(주소의 #공유 설정은 건드리지 않는다).
 *  - 'routeready'를 들어 길안내가 생기면 '길안내' 탭에 점을 켠다.
 * ===================================================================== */
(function () {
  'use strict';

  var current = null;
  var latestUrl = location.href;   // ui.js가 마지막으로 정한 주소(#공유 설정 포함)

  // ui.js는 설정이 바뀔 때마다 history.replaceState(null, …)로 주소의 #공유 설정을 바꾼다.
  // 이때 우리가 적어 둔 화면 이름(state)이 지워지지 않게 지켜 주고, 최신 주소를 기억한다.
  var origReplace = window.history && window.history.replaceState ? window.history.replaceState.bind(window.history) : null;
  if (origReplace) {
    window.history.replaceState = function (state, title, url) {
      if (state == null && window.history.state && window.history.state.screen) state = window.history.state;
      var r = origReplace(state, title, url);
      latestUrl = location.href;
      return r;
    };
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function screenEl(name) { return $('.screen[data-screen="' + name + '"]'); }

  // 지도 화면이 보이면 지도 크기를 다시 맞춘다(화면 크기가 바뀌었을 수도 있어서)
  function resizeMap() {
    var map = window.mapUtils && window.mapUtils.getMap && window.mapUtils.getMap();
    if (map && map.resize) {
      requestAnimationFrame(function () { try { map.resize(); } catch (e) { /* 무시 */ } });
    }
  }

  // 화면 보여 주기. opts.push === false 면 '뒤로 가기' 기록을 남기지 않는다
  function show(name, opts) {
    opts = opts || {};
    var el = screenEl(name);
    if (!el) return;
    if (name !== current) {
      $all('.screen').forEach(function (s) {
        var on = s === el;
        s.classList.toggle('is-active', on);
        s.classList.remove('is-entering');
        if (on) {
          void s.offsetWidth;            // 애니메이션을 처음부터 다시
          s.classList.add('is-entering');
        }
      });
      $all('.tabbar .tab').forEach(function (t) {
        if (t.getAttribute('data-go') === name) t.setAttribute('aria-current', 'page');
        else t.removeAttribute('aria-current');
      });
      // '이용 안내'처럼 탭에 없는 화면이면 탭 표시는 모두 꺼진다
      if (opts.push !== false && window.history && window.history.pushState) {
        try { window.history.pushState({ screen: name }, '', location.href); latestUrl = location.href; } catch (e) { /* 무시 */ }
      }
      current = name;
      // 화면 읽기 프로그램·키보드: 새 화면의 시작으로 초점
      if (opts.focus !== false) {
        var main = $('#app-main');
        if (main) { try { main.focus({ preventScroll: true }); } catch (e) { main.focus(); } }
      }
    }
    if (name === 'map') resizeMap();
    if (opts.target) {
      var t = document.getElementById(opts.target);
      if (t) t.scrollIntoView({ block: 'start' });
    }
  }

  // ui.js가 지도·목록으로 스크롤할 때, 그 요소가 숨은 화면에 있으면 먼저 그 화면을 연다
  var origScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () {
    var scr = this.closest ? this.closest('.screen[data-screen]') : null;
    if (scr && !scr.classList.contains('is-active')) show(scr.getAttribute('data-screen'), { focus: false });
    // 지도 화면은 스크롤할 곳이 없으니 화면만 바꾸고 끝
    if (scr && scr.classList.contains('screen-map')) return;
    return origScroll.apply(this, arguments);
  };

  function onClick(e) {
    // 글 속 바로가기 링크(#parking-section 등)가 다른 화면을 가리키면 그 화면을 연다
    var a = e.target.closest('a[href^="#"]');
    if (a && a.getAttribute('href').length > 1) {
      var id = a.getAttribute('href').slice(1);
      var t = null;
      try { t = document.getElementById(decodeURIComponent(id)); } catch (err) { t = null; }
      var scr = t && t.closest('.screen[data-screen]');
      if (scr) {
        e.preventDefault();                 // 주소의 #공유 설정을 바꾸지 않게
        show(scr.getAttribute('data-screen'), { target: t.id });
        return;
      }
    }
    var b = e.target.closest('[data-go]');
    if (!b) return;
    e.preventDefault();
    show(b.getAttribute('data-go'), { target: b.getAttribute('data-focus') || null });
  }

  // '길안내 보기' 버튼 글자를 지금 고른 곳에 맞춘다 (예: '화장실 길안내 보기')
  function syncRouteLabel() {
    var btn = $('[data-role="go-route-label"]');
    if (!btn) return;
    var on = $('#dest-select .dest-btn[aria-pressed="true"]');
    var dest = on ? on.getAttribute('data-dest') : 'all';
    var text = on ? ($('.dest-text', on) || on).firstChild.textContent.trim() : '';
    btn.textContent = dest && dest !== 'all' && text ? text + ' 길안내 보기' : '추천·길안내 보기';
  }

  function syncRouteDot() {
    var dot = $('[data-role="route-dot"]');
    if (!dot) return;
    var plan = window.routePlan;
    dot.hidden = !(plan && plan.stops && plan.stops.length);
  }

  function init() {
    if (!document.body.classList.contains('app')) return;
    document.addEventListener('click', onClick);

    // 목록·요약에서 장소를 누르거나, 응급 화면에서 AED 길안내를 누르면 지도로
    document.addEventListener('focusplace', function () { show('map', { focus: false }); });
    document.addEventListener('emergencyroute', function () { show('map', { focus: false }); });

    // 길안내 탭 점, '길안내 보기' 글자
    document.addEventListener('routeready', function () { syncRouteDot(); syncRouteLabel(); });
    var dests = $('#dest-select .dest-options');
    if (dests) dests.addEventListener('click', function () { setTimeout(syncRouteLabel, 0); });

    // 휴대폰 '뒤로' 버튼
    // 뒤로 가도 '지금 고른 설정'은 그대로 두려고, 주소를 최신 주소로 다시 맞춘다
    window.addEventListener('popstate', function (e) {
      var name = e.state && e.state.screen ? e.state.screen : 'home';
      if (origReplace && location.href !== latestUrl) {
        try { origReplace({ screen: name }, '', latestUrl); } catch (err) { /* 무시 */ }
      }
      show(name, { push: false, focus: false });
    });

    // 처음 화면: 홈. 지금 주소(#공유 설정 포함)는 그대로 두고 화면 이름만 기록
    try { if (origReplace) origReplace({ screen: 'home' }, '', location.href); latestUrl = location.href; } catch (e) { /* 무시 */ }
    show('home', { push: false, focus: false });
    syncRouteDot();
    syncRouteLabel();

    // 공유 링크로 '가고 싶은 곳'이 정해져 열렸으면 바로 길안내 화면을 보여 준다
    var picked = $('#dest-select .dest-btn[aria-pressed="true"]');
    if (picked && picked.getAttribute('data-dest') !== 'all') show('route', { push: true, focus: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
