"""OpenStreetMap 길(Overpass JSON, out geom) -> 걷는 길 그래프 data/walk_graph.json
브라우저용 같은 스크립트(JS)와 결과가 똑같이 나오도록 정수만 쓴다."""
import json, math, sys, collections
src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src))
WALK = {'footway','path','pedestrian','steps','living_street','residential','service','unclassified',
        'tertiary','secondary','primary','track','cycleway','primary_link','secondary_link','tertiary_link','corridor'}
def ok(t):
    if t.get('highway') not in WALK: return False
    if t.get('foot') in ('no', 'private'): return False
    if t.get('access') in ('no', 'private') and t.get('foot') not in ('yes', 'designated', 'permissive'): return False
    return True
r = lambda x, k: int(math.floor(x * k + 0.5))
raw = []   # (keyA, keyB, steps)
micro = {}
for w in d['elements']:
    t = w.get('tags', {})
    if w.get('type') != 'way' or not ok(t): continue
    steps = t.get('highway') == 'steps'
    ks = []
    for g in w['geometry']:
        k = (r(g['lat'], 1e7), r(g['lon'], 1e7))
        micro[k] = (r(g['lat'], 1e6), r(g['lon'], 1e6))
        ks.append(k)
    for a, b in zip(ks, ks[1:]):
        if a != b: raw.append((a, b, steps))
adj = collections.defaultdict(list)
for a, b, s in raw: adj[a].append(b); adj[b].append(a)
seen, best = set(), []
for n in sorted(adj):
    if n in seen: continue
    comp, st = [], [n]; seen.add(n)
    while st:
        x = st.pop(); comp.append(x)
        for y in adj[x]:
            if y not in seen: seen.add(y); st.append(y)
    if len(comp) > len(best): best = comp
keep = sorted(best)
idx = {k: i for i, k in enumerate(keep)}
n = []
for k in keep: n += list(micro[k])
e = [[idx[a], idx[b]] + ([1] if s else []) for a, b, s in raw if a in idx and b in idx]
res = {'meta': {'source': 'OpenStreetMap contributors (ODbL) via Overpass API', 'bbox': [37.503, 127.104, 37.530, 127.142],
                'format': 'n = [lat*1e6, lng*1e6, ...]; e = [nodeA, nodeB, (1 = steps)]'},
       'n': n, 'e': e}
open(out, 'w').write(json.dumps(res, separators=(',', ':')))
print('nodes', len(keep), 'edges', len(e), 'steps', sum(len(x) > 2 for x in e))
