/* =====================================================================
 * world3d.js — 팀원1(지도 담당) · 1인칭 '찾아가기'용 3D 세상
 * three.js로 지도 위에 나무·벤치·가로등·쓰레기통·걸어 다니는 사람을 세운다.
 *
 *  - 물건을 놓을 자리는 지도 데이터에서 가져온다(따로 큰 파일을 받지 않음).
 *      · 길(산책로·보도) → 사람이 걷는 길, 길가에 벤치·가로등·쓰레기통
 *      · 잔디·숲·공원 → 나무 (물·건물·길 위에는 안 심는다)
 *    여기에 OpenStreetMap에 실제로 등록된 나무·벤치·가로등 위치(Overpass)를 받을 수 있으면 더한다.
 *  - 사람·나무 모양은 단순화한 것이고, 위치·숫자는 실제 그대로가 아니라 '분위기'를 위한 것이다.
 *  - game.js가 World3D.attach / update / detach 를 부른다.
 * ===================================================================== */
(function () {
  'use strict';

  const THREE_URL = 'https://unpkg.com/three@0.169.0/build/three.module.min.js';
  const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
  const RADIUS_M = 280;           // 이 반경 안에 물건을 만든다
  const REBUILD_M = 150;          // 만든 곳에서 이만큼 멀어지면 다시 만든다
  const TREE_GRID_M = 8;          // 나무 후보 간격
  const MAX_TREES = 1100;
  const MAX_PEOPLE = 46;
  const BENCH_EVERY_M = 32;
  const LAMP_EVERY_M = 30;
  const PATH_CLASSES = /^(path|footway|pedestrian|track|cycleway|steps|living_street|service|minor)$/;
  const WALK_CLASSES = /^(path|footway|pedestrian|track|cycleway|living_street)$/;
  const GREEN_CLASSES = /^(grass|wood|forest|park|farmland|meadow|scrub|garden|cemetery|pitch|recreation_ground|playground)$/;

  const W = { THREE: null, map: null, origin: null, s: 1, scene: null, camera: null, renderer: null, layerId: 'fp-world',
    groups: [], people: [], peopleMeshes: null, genCenter: null, osm: null, time: 0, ready: false };

  // ───────────────────── 1. 좌표 ─────────────────────
  function toLocal(lng, lat) {
    const m = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], 0);
    return { x: (m.x - W.origin.x) / W.s, z: (m.y - W.origin.y) / W.s };
  }
  function seeded(seed) { // 같은 자리에는 늘 같은 모양이 나오게
    let t = seed >>> 0;
    return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
  }
  const hash2 = (x, z) => ((Math.round(x) * 73856093) ^ (Math.round(z) * 19349663)) >>> 0;

  // ───────────────────── 2. 지도 데이터 모으기 ─────────────────────
  function featuresNear(sourceLayer, center, filterFn) {
    let feats = [];
    try { feats = W.map.querySourceFeatures('openmaptiles', { sourceLayer: sourceLayer }); } catch (e) { return []; }
    return feats.filter((f) => !filterFn || filterFn(f.properties || {}));
  }
  function linesOf(geom) {
    if (!geom) return [];
    if (geom.type === 'LineString') return [geom.coordinates];
    if (geom.type === 'MultiLineString') return geom.coordinates;
    return [];
  }
  function ringsOf(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
  }
  // 다각형(구멍 포함)을 지역 좌표로 바꾸고 테두리 상자를 붙인다
  function localPolys(feats, c, R) {
    const out = [];
    feats.forEach((f) => ringsOf(f.geometry).forEach((poly) => {
      const rings = poly.map((ring) => ring.map(([lng, lat]) => toLocal(lng, lat)));
      if (!rings.length || rings[0].length < 3) return;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      rings[0].forEach((p) => { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); });
      if (x1 < c.x - R || x0 > c.x + R || z1 < c.z - R || z0 > c.z + R) return;
      out.push({ rings, x0, x1, z0, z1 });
    }));
    return out;
  }
  function inRing(ring, x, z) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
  }
  function inPolys(polys, x, z) {
    for (const p of polys) {
      if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) continue;
      if (inRing(p.rings[0], x, z) && !p.rings.slice(1).some((h) => inRing(h, x, z))) return p;
    }
    return null;
  }
  function segDist(px, pz, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const L = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / L));
    return Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz));
  }

  function collect(center) {
    const c = toLocal(center.lng, center.lat);
    const R = RADIUS_M;
    const paths = [];
    featuresNear('transportation', center, (p) => PATH_CLASSES.test(String(p.class || '')) && p.brunnel !== 'tunnel').forEach((f) => {
      const walk = WALK_CLASSES.test(String(f.properties.class)) || /footway|path/.test(String(f.properties.subclass || ''));
      linesOf(f.geometry).forEach((line) => {
        const pts = line.map(([lng, lat]) => toLocal(lng, lat));
        if (pts.some((p) => Math.abs(p.x - c.x) < R && Math.abs(p.z - c.z) < R)) paths.push({ pts, walk, steps: f.properties.class === 'steps' || f.properties.subclass === 'steps' });
      });
    });
    const greens = localPolys(featuresNear('landcover', center, (p) => GREEN_CLASSES.test(String(p.class || p.subclass || '')))
      .concat(featuresNear('park', center)), c, R);
    const woods = localPolys(featuresNear('landcover', center, (p) => /wood|forest/.test(String(p.class || p.subclass || ''))), c, R);
    const water = localPolys(featuresNear('water', center), c, R);
    const buildings = localPolys(featuresNear('building', center), c, R);
    // 길 선분 격자(나무를 길 위에 심지 않으려고)
    const seg = new Map();
    const key = (x, z) => Math.floor(x / 20) + ':' + Math.floor(z / 20);
    paths.forEach((p) => {
      for (let i = 1; i < p.pts.length; i++) {
        const a = p.pts[i - 1], b = p.pts[i];
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 20));
        for (let k = 0; k <= n; k++) {
          const x = a.x + ((b.x - a.x) * k) / n, z = a.z + ((b.z - a.z) * k) / n;
          const kk = key(x, z);
          if (!seg.has(kk)) seg.set(kk, []);
          seg.get(kk).push([a, b]);
        }
      }
    });
    const nearPath = (x, z, d) => {
      const i0 = Math.floor(x / 20), j0 = Math.floor(z / 20);
      for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
        const arr = seg.get(i + ':' + j);
        if (arr) for (const [a, b] of arr) if (segDist(x, z, a, b) < d) return true;
      }
      return false;
    };
    return { c, paths, greens, woods, water, buildings, nearPath, hasMap: paths.length > 0 || greens.length > 0 };
  }

  // ───────────────────── 3. 모양 만들기 (여러 개를 한 번에 그리는 InstancedMesh) ─────────────────────
  function kit(parts, count) {
    const T = W.THREE;
    return parts.map((p) => {
      const mesh = new T.InstancedMesh(p.geom, p.mat, Math.max(1, count));
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.userData.offset = p.offset || new T.Matrix4();
      mesh.userData.vary = p.vary;
      W.scene.add(mesh);
      W.groups.push(mesh);
      return mesh;
    });
  }
  function place(meshes, x, z, rotY, scale, rand, colorFn) {
    const T = W.THREE;
    const base = new T.Matrix4().compose(new T.Vector3(x, 0, z), new T.Quaternion().setFromEuler(new T.Euler(0, rotY, 0)), new T.Vector3(scale, scale, scale));
    const m = new T.Matrix4();
    meshes.forEach((mesh) => {
      const i = mesh.count;
      if (i >= mesh.instanceMatrix.count) return;
      m.multiplyMatrices(base, mesh.userData.offset);
      mesh.setMatrixAt(i, m);
      if (mesh.userData.vary) mesh.setColorAt(i, mesh.userData.vary(rand));
      mesh.count = i + 1;
    });
  }
  const off = (x, y, z, rx, ry, rz) => {
    const T = W.THREE;
    return new T.Matrix4().compose(new T.Vector3(x, y, z), new T.Quaternion().setFromEuler(new T.Euler(rx || 0, ry || 0, rz || 0)), new T.Vector3(1, 1, 1));
  };

  function makeKits(n) {
    const T = W.THREE;
    const lam = (c, o) => new T.MeshLambertMaterial(Object.assign({ color: c }, o || {}));
    const hsl = (h, s, l) => new T.Color().setHSL(h, s, l);
    const shadowMat = new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
    const disc = new T.CircleGeometry(1, 14).rotateX(-Math.PI / 2);
    return {
      tree: kit([
        { geom: new T.CylinderGeometry(0.14, 0.22, 2.6, 7), mat: lam(0x6b4a2f), offset: off(0, 1.3, 0) },
        { geom: new T.IcosahedronGeometry(1.7, 0), mat: lam(0xffffff, { flatShading: true }), offset: off(0, 3.4, 0), vary: (r) => hsl(0.27 + r() * 0.08, 0.45 + r() * 0.2, 0.26 + r() * 0.12) },
        { geom: new T.IcosahedronGeometry(1.2, 0), mat: lam(0xffffff, { flatShading: true }), offset: off(0.5, 4.3, -0.3), vary: (r) => hsl(0.26 + r() * 0.08, 0.4 + r() * 0.2, 0.3 + r() * 0.12) },
        { geom: disc, mat: shadowMat, offset: off(0, 0.03, 0) },
      ], n.trees),
      pine: kit([
        { geom: new T.CylinderGeometry(0.12, 0.18, 1.6, 6), mat: lam(0x5a3d26), offset: off(0, 0.8, 0) },
        { geom: new T.ConeGeometry(1.4, 3.6, 7), mat: lam(0xffffff, { flatShading: true }), offset: off(0, 3.0, 0), vary: (r) => hsl(0.33 + r() * 0.05, 0.4 + r() * 0.15, 0.2 + r() * 0.08) },
        { geom: disc, mat: shadowMat, offset: off(0, 0.03, 0) },
      ], n.pines),
      bench: kit([
        { geom: new T.BoxGeometry(1.7, 0.07, 0.46), mat: lam(0x9a6b3f), offset: off(0, 0.46, 0) },
        { geom: new T.BoxGeometry(1.7, 0.4, 0.06), mat: lam(0x8a5f37), offset: off(0, 0.78, 0.22, -0.18) },
        { geom: new T.BoxGeometry(0.08, 0.46, 0.46), mat: lam(0x2f3437), offset: off(-0.72, 0.23, 0) },
        { geom: new T.BoxGeometry(0.08, 0.46, 0.46), mat: lam(0x2f3437), offset: off(0.72, 0.23, 0) },
      ], n.benches),
      lamp: kit([
        { geom: new T.CylinderGeometry(0.06, 0.09, 4.2, 6), mat: lam(0x3a4046), offset: off(0, 2.1, 0) },
        { geom: new T.SphereGeometry(0.22, 10, 8), mat: new T.MeshBasicMaterial({ color: 0xfff2c4 }), offset: off(0, 4.3, 0) },
      ], n.lamps),
      bin: kit([
        { geom: new T.CylinderGeometry(0.24, 0.22, 0.8, 10), mat: lam(0x2f6f4f), offset: off(0, 0.4, 0) },
      ], n.bins),
    };
  }

  // ───────────────────── 4. 사람 (걷는 모습은 매 장면 다시 계산) ─────────────────────
  const SKIN = [0.07, 0.06, 0.05, 0.08];
  function makePeopleMeshes(n) {
    const T = W.THREE;
    const lam = () => new T.MeshLambertMaterial({ color: 0xffffff });
    const mk = (geom) => {
      const m = new T.InstancedMesh(geom, lam(), n);
      m.count = 0; m.frustumCulled = false;
      W.scene.add(m); W.groups.push(m);
      return m;
    };
    return {
      torso: mk(new T.CylinderGeometry(0.17, 0.2, 0.62, 8).translate(0, 0, 0)),
      head: mk(new T.SphereGeometry(0.12, 10, 8)),
      hair: mk(new T.SphereGeometry(0.125, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)),
      legL: mk(new T.BoxGeometry(0.11, 0.82, 0.12).translate(0, -0.41, 0)),
      legR: mk(new T.BoxGeometry(0.11, 0.82, 0.12).translate(0, -0.41, 0)),
      armL: mk(new T.BoxGeometry(0.08, 0.6, 0.08).translate(0, -0.3, 0)),
      armR: mk(new T.BoxGeometry(0.08, 0.6, 0.08).translate(0, -0.3, 0)),
      shadow: (() => {
        const m = new T.InstancedMesh(new T.CircleGeometry(0.38, 12).rotateX(-Math.PI / 2),
          new T.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.25, depthWrite: false }), n);
        m.count = 0; m.frustumCulled = false; W.scene.add(m); W.groups.push(m); return m;
      })(),
    };
  }

  function spawnPeople(data, rand) {
    const T = W.THREE;
    const walkPaths = data.paths.filter((p) => p.walk && !p.steps && p.pts.length > 1);
    const people = [];
    const count = Math.min(MAX_PEOPLE, walkPaths.length ? 18 + walkPaths.length * 2 : 26);
    for (let i = 0; i < count; i++) {
      const p = {
        scale: rand() < 0.15 ? 0.72 : 0.92 + rand() * 0.14,                          // 아이·어른
        shirt: new T.Color().setHSL(rand(), 0.35 + rand() * 0.45, 0.35 + rand() * 0.3),
        pants: new T.Color().setHSL(0.6 + rand() * 0.1, 0.2 + rand() * 0.3, 0.15 + rand() * 0.2),
        skin: new T.Color().setHSL(SKIN[Math.floor(rand() * SKIN.length)], 0.4, 0.45 + rand() * 0.25),
        hair: new T.Color().setHSL(0.07, 0.3, 0.05 + rand() * 0.25),
        speed: 1.0 + rand() * 0.6, phase: rand() * 10, side: (rand() - 0.5) * 1.6,
      };
      if (walkPaths.length) {
        p.path = walkPaths[Math.floor(rand() * walkPaths.length)];
        p.lens = [0];
        for (let k = 1; k < p.path.pts.length; k++) p.lens.push(p.lens[k - 1] + Math.hypot(p.path.pts[k].x - p.path.pts[k - 1].x, p.path.pts[k].z - p.path.pts[k - 1].z));
        p.t = rand() * p.lens[p.lens.length - 1];
        p.dir = rand() < 0.5 ? 1 : -1;
      } else { // 길 정보가 없으면 주변을 천천히 돌아다닌다
        const a = rand() * Math.PI * 2, d = 15 + rand() * 120;
        p.x = data.c.x + Math.cos(a) * d; p.z = data.c.z + Math.sin(a) * d; p.h = rand() * Math.PI * 2;
      }
      people.push(p);
    }
    // 벤치에 앉아 쉬는 사람 몇 명
    (data.benchSpots || []).slice(0, 10).forEach((b, i) => {
      if (rand() < 0.45) people.push({ sit: true, x: b.x, z: b.z, h: b.rot, scale: 0.95, phase: i,
        shirt: new T.Color().setHSL(rand(), 0.4, 0.45), pants: new T.Color().setHSL(0.62, 0.3, 0.2),
        skin: new T.Color().setHSL(0.07, 0.4, 0.55), hair: new T.Color().setHSL(0.07, 0.2, 0.12 + rand() * 0.5) });
    });
    return people;
  }

  const tmpM = () => new W.THREE.Matrix4();
  function updatePeople(dt) {
    const T = W.THREE;
    const M = W.peopleMeshes;
    if (!M) return;
    const base = tmpM(), part = tmpM(), out = tmpM();
    const q = new T.Quaternion(), v = new T.Vector3(), sc = new T.Vector3();
    let i = 0;
    W.people.forEach((p) => {
      let x, z, h, swing = 0;
      if (p.sit) { x = p.x; z = p.z; h = p.h; }
      else if (p.path) {
        p.t += p.dir * p.speed * dt;
        const L = p.lens[p.lens.length - 1];
        if (p.t > L) { p.t = L; p.dir = -1; } else if (p.t < 0) { p.t = 0; p.dir = 1; }
        let k = 1;
        while (k < p.lens.length - 1 && p.lens[k] < p.t) k++;
        const a = p.path.pts[k - 1], b = p.path.pts[k];
        const seg = p.lens[k] - p.lens[k - 1] || 1;
        const f = (p.t - p.lens[k - 1]) / seg;
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
        x = a.x + dx * f + (-dz / len) * p.side;
        z = a.z + dz * f + (dx / len) * p.side;
        h = Math.atan2(dx * p.dir, dz * p.dir);
        swing = Math.sin((W.time + p.phase) * 7 * p.speed) * 0.5;
      } else {
        p.h += (Math.sin(W.time * 0.3 + p.phase) * 0.6) * dt;
        p.x += Math.sin(p.h) * p.speed * dt; p.z += Math.cos(p.h) * p.speed * dt;
        x = p.x; z = p.z; h = p.h;
        swing = Math.sin((W.time + p.phase) * 7 * p.speed) * 0.5;
      }
      const s = p.scale;
      const seatDrop = p.sit ? 0.38 : 0;
      base.compose(v.set(x, 0, z), q.setFromEuler(new T.Euler(0, h, 0)), sc.set(s, s, s));
      const set = (mesh, m, color) => { out.multiplyMatrices(base, m); mesh.setMatrixAt(i, out); if (color) mesh.setColorAt(i, color); };
      set(M.torso, part.makeTranslation(0, 1.18 - seatDrop, 0), p.shirt);
      set(M.head, part.makeTranslation(0, 1.62 - seatDrop, 0), p.skin);
      set(M.hair, part.makeTranslation(0, 1.64 - seatDrop, 0.01), p.hair);
      const leg = (side, ang) => part.compose(v.set(side, 0.86 - seatDrop, 0), q.setFromEuler(new T.Euler(p.sit ? -1.45 : ang, 0, 0)), sc.set(1, 1, 1));
      set(M.legL, leg(-0.08, swing), p.pants);
      set(M.legR, leg(0.08, -swing), p.pants);
      const arm = (side, ang) => part.compose(v.set(side, 1.44 - seatDrop, 0), q.setFromEuler(new T.Euler(ang, 0, side > 0 ? -0.08 : 0.08)), sc.set(1, 1, 1));
      set(M.armL, arm(-0.23, -swing * 0.8), p.shirt);
      set(M.armR, arm(0.23, swing * 0.8), p.shirt);
      set(M.shadow, part.makeTranslation(0, 0.03, 0));
      i++;
    });
    Object.values(M).forEach((m) => { m.count = i; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  }

  // ───────────────────── 5. 물건 배치 ─────────────────────
  function clearObjects() {
    W.groups.forEach((m) => { W.scene.remove(m); m.dispose && m.dispose(); });
    W.groups = [];
    W.peopleMeshes = null;
    W.people = [];
  }

  function populate(center) {
    clearObjects();
    W.genCenter = { lat: center.lat, lng: center.lng };
    const data = collect(center);
    const rand = seeded(hash2(data.c.x, data.c.z));
    const kits = makeKits({ trees: MAX_TREES, pines: 400, benches: 160, lamps: 160, bins: 80 });
    const R = RADIUS_M;
    const blocked = (x, z, pathGap) => inPolys(data.water, x, z) || inPolys(data.buildings, x, z) || data.nearPath(x, z, pathGap);

    // (1) OpenStreetMap에 실제로 등록된 물건(받아 둔 경우)
    let osmBench = 0, osmLamp = 0;
    (W.osm || []).forEach((o) => {
      const p = toLocal(o.lng, o.lat);
      if (Math.abs(p.x - data.c.x) > R || Math.abs(p.z - data.c.z) > R) return;
      const r = seeded(hash2(p.x * 7, p.z * 7));
      if (o.t === 'tree') place(kits.tree, p.x, p.z, r() * 6, 0.85 + r() * 0.5, r);
      else if (o.t === 'bench') { place(kits.bench, p.x, p.z, r() * 6, 1, r); osmBench++; }
      else if (o.t === 'lamp') { place(kits.lamp, p.x, p.z, 0, 1, r); osmLamp++; }
      else if (o.t === 'bin') place(kits.bin, p.x, p.z, 0, 1, r);
    });

    // (2) 길가: 벤치·가로등·쓰레기통 (실제 위치가 넉넉하면 건너뜀)
    data.benchSpots = [];
    data.paths.filter((p) => p.walk).forEach((p, pi) => {
      let acc = 0, lampAcc = LAMP_EVERY_M / 2, side = pi % 2 ? 1 : -1;
      for (let k = 1; k < p.pts.length; k++) {
        const a = p.pts[k - 1], b = p.pts[k];
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
        if (!len) continue;
        const nx = -dz / len, nz = dx / len;
        for (let d = 0; d < len; d += 2) {
          acc += 2; lampAcc += 2;
          const x = a.x + (dx * d) / len, z = a.z + (dz * d) / len;
          if (Math.abs(x - data.c.x) > R || Math.abs(z - data.c.z) > R) continue;
          if (acc >= BENCH_EVERY_M && osmBench < 10) {
            acc = 0; side = -side;
            const bx = x + nx * 2.3 * side, bz = z + nz * 2.3 * side;
            if (!inPolys(data.water, bx, bz) && !inPolys(data.buildings, bx, bz)) {
              const rot = Math.atan2(nx * side, nz * side);
              place(kits.bench, bx, bz, rot, 1, rand);
              data.benchSpots.push({ x: bx - nx * 0.1 * side, z: bz - nz * 0.1 * side, rot: rot + Math.PI });
              if (rand() < 0.4) place(kits.bin, bx + dx / len * 1.4, bz + dz / len * 1.4, 0, 1, rand);
            }
          }
          if (lampAcc >= LAMP_EVERY_M && osmLamp < 10) {
            lampAcc = 0;
            const lx = x - nx * 1.6 * side, lz = z - nz * 1.6 * side;
            if (!inPolys(data.water, lx, lz) && !inPolys(data.buildings, lx, lz)) place(kits.lamp, lx, lz, 0, 1, rand);
          }
        }
      }
    });

    // (3) 나무: 잔디·숲·공원 안에만 (지도 정보가 없으면 주변에 고르게)
    for (let gx = -R; gx <= R; gx += TREE_GRID_M) {
      for (let gz = -R; gz <= R; gz += TREE_GRID_M) {
        const r = seeded(hash2(data.c.x + gx, data.c.z + gz));
        const x = Math.round((data.c.x + gx) / TREE_GRID_M) * TREE_GRID_M + (r() - 0.5) * TREE_GRID_M * 0.9;
        const z = Math.round((data.c.z + gz) / TREE_GRID_M) * TREE_GRID_M + (r() - 0.5) * TREE_GRID_M * 0.9;
        let keep;
        if (data.hasMap) {
          if (inPolys(data.woods, x, z)) keep = r() < 0.75;
          else if (inPolys(data.greens, x, z)) keep = r() < 0.22;
          else keep = false;
        } else {
          keep = r() < 0.12 && Math.hypot(x - data.c.x, z - data.c.z) > 6;
        }
        if (!keep || blocked(x, z, 3)) continue;
        if (r() < 0.25) place(kits.pine, x, z, r() * 6, 0.8 + r() * 0.6, r);
        else place(kits.tree, x, z, r() * 6, 0.75 + r() * 0.65, r);
      }
    }

    // (4) 사람
    W.peopleMeshes = makePeopleMeshes(MAX_PEOPLE + 12);
    W.people = spawnPeople(data, rand);
    Object.values(kits).flat().forEach((m) => { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    W.stats = { trees: kits.tree[0].count + kits.pine[0].count, benches: kits.bench[0].count, lamps: kits.lamp[0].count,
      people: W.people.length, paths: data.paths.length, fromMap: data.hasMap, osm: (W.osm || []).length };
  }

  // ───────────────────── 6. OpenStreetMap 실제 물건 받기 (되면 쓰고, 안 되면 넘어간다) ─────────────────────
  async function fetchOsm(center) {
    const key = 'fp-osm-v1';
    try { const c = sessionStorage.getItem(key); if (c) return JSON.parse(c); } catch (e) { /* 무시 */ }
    const d = 0.012;
    const b = (center.lat - d) + ',' + (center.lng - d * 1.3) + ',' + (center.lat + d) + ',' + (center.lng + d * 1.3);
    const q = '[out:json][timeout:20];(node["natural"="tree"](' + b + ');node["amenity"="bench"](' + b + ');node["highway"="street_lamp"](' + b + ');node["amenity"="waste_basket"](' + b + '););out;';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(OVERPASS_URL, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const list = (json.elements || []).map((e) => ({ lat: e.lat, lng: e.lon,
        t: e.tags.natural === 'tree' ? 'tree' : e.tags.amenity === 'bench' ? 'bench' : e.tags.highway === 'street_lamp' ? 'lamp' : 'bin' }));
      try { sessionStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* 무시 */ }
      return list;
    } finally { clearTimeout(timer); }
  }

  // ───────────────────── 7. 지도에 붙이기 / 떼기 ─────────────────────
  async function attach(map, start) {
    if (W.ready) detach();
    W.map = map;
    W.THREE = W.THREE || await import(THREE_URL);
    const T = W.THREE;
    W.origin = maplibregl.MercatorCoordinate.fromLngLat([start.lng, start.lat], 0);
    W.s = W.origin.meterInMercatorCoordinateUnits();
    W.scene = new T.Scene();
    W.scene.fog = new T.Fog(0xeef3f7, 90, 330);
    W.camera = new T.Camera();
    W.scene.add(new T.HemisphereLight(0xe6f2ff, 0x5b6b45, 1.25));
    const sun = new T.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-60, 120, 40);
    W.scene.add(sun);
    W.time = 0;
    const layer = {
      id: W.layerId, type: 'custom', renderingMode: '3d',
      onAdd: (m, gl) => {
        W.renderer = new T.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
        W.renderer.autoClear = false;
      },
      render: (gl, args) => {
        const matrix = (args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix) || args;
        const m = new T.Matrix4().fromArray(matrix);
        const l = new T.Matrix4().makeTranslation(W.origin.x, W.origin.y, W.origin.z)
          .scale(new T.Vector3(W.s, -W.s, W.s))
          .multiply(new T.Matrix4().makeRotationX(Math.PI / 2));
        W.camera.projectionMatrix = m.multiply(l);
        W.renderer.resetState();
        W.renderer.render(W.scene, W.camera);
      },
    };
    const before = (map.getStyle().layers || []).find((l) => l.type === 'symbol');
    map.addLayer(layer, before ? before.id : undefined);
    W.ready = true;
    populate(start);
    // 실제 물건 위치는 늦게 오면 그때 다시 배치
    fetchOsm(start).then((list) => {
      if (!W.ready || !list || !list.length) return;
      W.osm = list;
      populate(W.genCenter);
    }).catch((err) => console.info('[world3d] OSM 실제 물건 위치는 못 받아 지도 데이터로만 배치해요:', err && err.message));
  }

  function update(pos, dt) {
    if (!W.ready) return;
    W.time += dt;
    // 처음엔 타일이 덜 받아졌을 수 있어, 길이 하나도 없으면 잠깐 뒤 다시 배치해 본다
    if ((W.stats && !W.stats.fromMap && W.time > 1.5 && !W.retried) ||
        (W.genCenter && distM(pos, W.genCenter) > REBUILD_M)) {
      W.retried = true;
      populate(pos);
    }
    updatePeople(dt);
    W.map.triggerRepaint();
  }

  function distM(a, b) {
    const dLat = (b.lat - a.lat) * 111320, dLng = (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
    return Math.hypot(dLat, dLng);
  }

  function detach() {
    if (!W.map) return;
    try { if (W.map.getLayer(W.layerId)) W.map.removeLayer(W.layerId); } catch (e) { /* 무시 */ }
    clearObjects();
    W.ready = false;
    W.retried = false;
  }

  window.World3D = { attach, update, detach, stats: () => W.stats, isReady: () => W.ready };
})();
