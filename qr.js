/* =====================================================================
 * qr.js — 팀원1 · 공유 링크 QR코드 만들기 (외부 라이브러리 없이)
 * ---------------------------------------------------------------------
 * QR코드 표준(ISO/IEC 18004)의 '바이트 모드 + 오류 정정 M단계'만 구현했다.
 * 링크(주소) 정도 길이(버전 1~20, 최대 약 600바이트)면 충분하다.
 *   window.QRMini.svg(text, { size: 220, dark: '#000', light: '#fff', margin: 4 }) → <svg> 문자열
 *   window.QRMini.matrix(text) → [[true/false, ...], ...] (true = 검은 칸)
 * ui.js가 공유 창을 열 때만 이 파일을 불러온다(index.html 스크립트 순서는 그대로).
 * ===================================================================== */
(function () {
  'use strict';

  // 오류 정정 M단계: 버전별 블록당 오류 정정 코드워드 수, 블록 수 (인덱스 = 버전, 0은 안 씀)
  const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
  const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
  const MAX_VERSION = 20;
  const FORMAT_ECL_M = 0;   // 형식 정보에 들어가는 M단계 값

  function rawDataModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }

  function dataCodewords(ver) {
    return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }

  // ---------- 갈루아 체(GF(2^8)) 곱셈과 리드-솔로몬 ----------
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function rsDivisor(degree) {
    const r = new Array(degree).fill(0);
    r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < r.length; j++) {
        r[j] = gfMul(r[j], root);
        if (j + 1 < r.length) r[j] ^= r[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return r;
  }

  function rsRemainder(data, divisor) {
    const r = divisor.map(() => 0);
    data.forEach((b) => {
      const factor = b ^ r.shift();
      r.push(0);
      divisor.forEach((d, i) => { r[i] ^= gfMul(d, factor); });
    });
    return r;
  }

  // ---------- 글자 → 코드워드 ----------
  function utf8Bytes(text) {
    return Array.from(new TextEncoder().encode(text));
  }

  function encodeData(bytes, ver) {
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0x4, 4);                                   // 바이트 모드
    put(bytes.length, ver <= 9 ? 8 : 16);          // 글자 수
    bytes.forEach((b) => put(b, 8));
    const cap = dataCodewords(ver) * 8;
    put(0, Math.min(4, cap - bits.length));        // 끝 표시
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let pad = 0xec; out.length < dataCodewords(ver); pad ^= 0xec ^ 0x11) out.push(pad);
    return out;
  }

  function addEccAndInterleave(data, ver) {
    const numBlocks = NUM_BLOCKS[ver];
    const eccLen = ECC_PER_BLOCK[ver];
    const rawCodewords = Math.floor(rawDataModules(ver) / 8);
    const numShort = numBlocks - (rawCodewords % numBlocks);
    const shortLen = Math.floor(rawCodewords / numBlocks);
    const div = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((blk, j) => {
        if (i !== shortLen - eccLen || j >= numShort) result.push(blk[i]);
      });
    }
    return result;
  }

  // ---------- 그림(모듈) 그리기 ----------
  function build(ver, codewords, mask) {
    const size = ver * 4 + 17;
    const mods = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { mods[y][x] = dark; isFn[y][x] = true; };

    // 타이밍 패턴
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // 위치 찾기 패턴(세 모서리) + 흰 테두리
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(([cx, cy]) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
        }
      }
    });
    // 정렬 패턴
    const align = [];
    if (ver > 1) {
      const n = Math.floor(ver / 7) + 2;
      const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
      align.push(6);
      for (let pos = size - 7; align.length < n; pos -= step) align.splice(1, 0, pos);
    }
    align.forEach((ay, i) => {
      align.forEach((ax, j) => {
        const last = align.length - 1;
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      });
    });
    // 형식 정보 자리 확보(나중에 채움)
    drawFormat(set, size, 0);
    // 버전 정보(버전 7 이상)
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) !== 0;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        set(a, b, bit);
        set(b, a, bit);
      }
    }
    // 데이터 채우기(오른쪽 아래부터 지그재그)
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && i < codewords.length * 8) {
            mods[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
    // 마스크
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFn[y][x] && maskBit(mask, x, y)) mods[y][x] = !mods[y][x];
      }
    }
    drawFormat(set, size, mask);
    return mods;
  }

  function maskBit(m, x, y) {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }

  function drawFormat(set, size, mask) {
    const data = (FORMAT_ECL_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);   // 항상 검은 칸
  }

  // 마스크 고르기용 감점(규칙 1·2·4: 같은 색 줄, 2x2 덩어리, 검은 칸 비율)
  function penalty(m) {
    const n = m.length;
    let p = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b < n; b++) {
          const cur = pass ? m[b][a] : m[a][b];
          const prev = pass ? m[b - 1][a] : m[a][b - 1];
          if (cur === prev) {
            run++;
            if (run === 5) p += 3; else if (run > 5) p += 1;
          } else run = 1;
        }
      }
    }
    for (let y = 0; y + 1 < n; y++) {
      for (let x = 0; x + 1 < n; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
      }
    }
    let dark = 0;
    m.forEach((row) => row.forEach((c) => { if (c) dark++; }));
    const total = n * n;
    p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return p;
  }

  function matrix(text) {
    const bytes = utf8Bytes(String(text));
    let ver = 1;
    for (; ver <= MAX_VERSION; ver++) {
      const need = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
      if (need <= dataCodewords(ver) * 8) break;
    }
    if (ver > MAX_VERSION) throw new Error('QR코드로 만들기에 글자가 너무 길어요.');
    const cw = addEccAndInterleave(encodeData(bytes, ver), ver);
    let best = null;
    let bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = build(ver, cw, mask);
      const pen = penalty(m);
      if (pen < bestP) { bestP = pen; best = m; }
    }
    return best;
  }

  function svg(text, opt) {
    opt = opt || {};
    const m = matrix(text);
    const margin = opt.margin === undefined ? 4 : opt.margin;
    const n = m.length + margin * 2;
    let d = '';
    m.forEach((row, y) => row.forEach((c, x) => { if (c) d += 'M' + (x + margin) + ',' + (y + margin) + 'h1v1h-1z'; }));
    const size = opt.size || 220;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" width="' + size + '" height="' + size +
      '" shape-rendering="crispEdges" role="img" aria-label="' + (opt.label || 'QR코드') + '">' +
      '<rect width="100%" height="100%" fill="' + (opt.light || '#ffffff') + '"/>' +
      '<path d="' + d + '" fill="' + (opt.dark || '#000000') + '"/></svg>';
  }

  window.QRMini = { svg: svg, matrix: matrix };
})();
