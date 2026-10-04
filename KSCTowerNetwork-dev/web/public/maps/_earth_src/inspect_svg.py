import re

src = r'c:\Program Files (x86)\Steam\steamapps\common\Kerbal Space Program\KSCTowerNetwork-dev\web\public\maps\_earth_src\world_topo_5layers.svg'
s = open(src, 'r', encoding='utf-8').read()
print('total bytes:', len(s))
print()

# Layer/group structure
for m in re.finditer(r'<g\b([^>]*?)>', s):
    attrs = m.group(1)
    label = re.search(r'inkscape:label="([^"]+)"', attrs)
    gid = re.search(r'id="([^"]+)"', attrs)
    tx = re.search(r'transform="([^"]+)"', attrs)
    style = re.search(r'style="([^"]+)"', attrs)
    fill = re.search(r'fill="([^"]+)"', attrs)
    print('<g>', 'label=', label.group(1) if label else '-', 'id=', gid.group(1) if gid else '-')
    if tx: print('     transform=', tx.group(1))
    if style: print('     style=', style.group(1)[:120])
    if fill: print('     fill=', fill.group(1))

print()
print('counts:')
for tag in ('g','path','rect','polygon','polyline','line','text','image','use'):
    n = len(re.findall(rf'<{tag}\b', s))
    if n: print(f'  <{tag}>: {n}')

# Look at first few path 'd' starts to understand coord ranges
print()
print('first 5 path d snippets:')
for i, m in enumerate(re.finditer(r'<path\b[^>]*\bd="([^"]{0,160})', s)):
    if i >= 5: break
    print(' ', m.group(1)[:140])

# Coord range
print()
nums = re.findall(r'-?\d+\.?\d*', re.findall(r'<path[^>]*d="([^"]+)"', s)[0])
nums = [float(x) for x in nums if x not in ('','.','-')]
print('first path: numeric min/max:', min(nums), max(nums))

# Sample fills used (gives elevation band colors)
fills = set()
for m in re.finditer(r'(?:fill|style)\s*=\s*"[^"]*?(?:fill\s*:\s*)?(#[0-9a-fA-F]{3,6})', s):
    fills.add(m.group(1).lower())
print()
print('distinct fills:', sorted(fills))
