#!/usr/bin/env python3
"""Génère le thème sombre de docs/css/app.css : chaque règle qui fixe une couleur reçoit une variante `html.dark …`.
Usage : python3 tools/gen_dark_css.py   (réécrit le bloc entre les marqueurs, sans toucher au reste)"""
import colorsys, re, pathlib

CSS = pathlib.Path(__file__).resolve().parent.parent / 'docs/css/app.css'
BEGIN, END = '/* >>> thème sombre généré (tools/gen_dark_css.py) */', '/* <<< fin du thème sombre généré */'
MARK = '/* === retouches du thème sombre (écrites à la main, après le bloc généré) === */'
HEX = re.compile(r'#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b')
BG, TXT, BORDER = ('background', 'background-color'), ('color',), ('border', 'border-color', 'border-top', 'border-bottom', 'border-left', 'border-right', 'outline')

def parse(h):
    h = h.lstrip('#')
    if len(h) == 3: h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))

def to_hex(r, g, b): return '#%02x%02x%02x' % tuple(round(max(0, min(1, v)) * 255) for v in (r, g, b))

def remap(hexv, kind):
    r, g, b = parse(hexv); h, l, s = colorsys.rgb_to_hls(r, g, b)
    if s < .05: h, s = 215 / 360, .14                                                       # gris neutres → légèrement bleutés
    if kind == 'text': l2 = 1.0 - l * 0.9 if l < .5 else (max(l, .58) if l < .9 else 0.12 + (1 - l) * 0.9 * .6)   # texte sombre → clair ; gris moyens inchangés ; blanc → très sombre (sur fond remappé)
    else: l2 = 0.11 + (1 - l) * 0.9 if l > .5 else 0.96 - l * 0.9                          # fonds/bordures clairs → sombres ; fonds sombres → clairs
    return to_hex(*colorsys.hls_to_rgb(h, l2, s * (0.85 if kind != 'text' else 1)))

def kind_of(prop):
    p = prop.strip().lower()
    if p in TXT: return 'text'
    if p in BG or p in BORDER: return 'bg'
    return None

def dark_decls(body):
    out = []
    for decl in body.split(';'):
        if ':' not in decl: continue
        prop, val = decl.split(':', 1); k = kind_of(prop)
        if not k or 'var(' in val or not HEX.search(val): continue
        if 'gradient' in val or 'url(' in val: continue
        name = prop.strip()
        if name.startswith(('border', 'outline')) and not name.endswith('-color'): name += '-color'          # on ne touche qu'à la couleur : jamais à l'épaisseur
        mapped = HEX.sub(lambda m: remap(m.group(0), k), val.strip())
        if name != prop.strip(): mapped = HEX.search(mapped).group(0)                                   # border-color : la couleur seule
        out.append(f"{name}: {mapped}")
    return out

def rules(css, i=0, depth=0):
    """Itère (sélecteur, corps, media) en gardant l'enveloppe @media."""
    out, n = [], len(css)
    while i < n:
        if css.startswith('/*', i): i = css.index('*/', i) + 2; continue
        if css[i].isspace(): i += 1; continue
        j = css.index('{', i); head = css[i:j].strip()
        if head.startswith('@media'):
            k, d = j + 1, 1
            while d: d += {'{': 1, '}': -1}.get(css[k], 0); k += 1
            out.append(('@media', head, css[j + 1:k - 1])); i = k
        else:
            k = css.index('}', j); out.append(('rule', head, css[j + 1:k])); i = k + 1
    return out

def emit(sel, body):
    d = dark_decls(body)
    if not d or sel.startswith('@') or sel.startswith('html.dark'): return ''
    sels = ',\n'.join('html.dark ' + s.strip() for s in sel.split(','))
    return f"{sels} {{ {'; '.join(d)}; }}\n"

def main():
    css = CSS.read_text(encoding='utf-8')
    if BEGIN in css: css = css[:css.index(BEGIN)].rstrip() + '\n\n' + css[css.index(END) + len(END):].lstrip()
    out = [BEGIN + '\n']
    for kind, head, body in rules(css):
        if kind == 'rule': out.append(emit(head, body))
        else:
            inner = ''.join(emit(h, b) for k, h, b in rules(body) if k == 'rule')
            if inner: out.append(f"{head} {{\n{inner}}}\n")
    out.append(END + '\n')
    block = ''.join(out)
    if MARK in css: css = css.replace(MARK, block + '\n' + MARK)
    else: css = css.rstrip() + '\n\n' + block
    CSS.write_text(css, encoding='utf-8')
    print('règles sombres :', sum(1 for l in ''.join(out).split('\n') if l.startswith('html.dark')))
main()
