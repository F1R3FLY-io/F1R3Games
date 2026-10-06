# Reference sketch of the F1R3Beat score bridge (canonical form v2): grid -> canonical score.
from fractions import Fraction as Fr
ROWS = ["drums", "bass", "guitar", "keys", "sax"]
TIMBRES = ("timbres   { drums = gm(0) on 10, bass = gm(33) on 2, guitar = gm(29) on 3,\n"
           "            keys = gm(0) on 4, sax = gm(66) on 5 }")
KIT = {"kick": 36, "rim": 37, "snare": 38, "clap": 39, "chh": 42, "phh": 44, "ltom": 45,
       "ohh": 46, "mtom": 47, "crash": 49, "htom": 50, "ride": 51}
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
def midi(p):
    n = p[:-1]; o = int(p[-1]); return 12*(o+1) + NAMES.index(n)
def lines(grid, S):
    out = {}
    for r in ROWS:
        v = grid.get(r, {}); L = []; gap = 0
        for t in range(S):
            if t in v:
                if gap: L.append(("r", gap)); gap = 0
                L.append((v[t], 1))
            else: gap += 1
        if gap: L.append(("r", gap))
        out[r] = L
    return out
def score(grid, meter, bars, col):
    n, d = meter; S = int(Fr(n, d) * bars / col)
    ls = lines(grid, S)
    used = {p for L in ls.values() for p, _ in L if p != "r"}
    kit = sorted([p for p in used if p in KIT], key=KIT.get)
    pit = sorted([p for p in used if p not in KIT], key=midi)
    ks = sorted({k for L in ls.values() for _, k in L})
    pd = ", ".join(["r"] + [f"{p} = {KIT[p]}" for p in kit] + pit)
    dd = ", ".join(f"c{k} = {Fr(k)*col}" for k in ks)
    body = []
    for i, r in enumerate(ROWS):
        notes = [f"{p} c{k}" for p, k in ls[r]]
        chunks = [", ".join(notes[j:j+8]) for j in range(0, len(notes), 8)]
        head = f'line(base "{r}", {r})'
        lead = "play " if i == 0 else "   | "
        pad = " " * (len(lead) + 32)
        txt = f"{lead}{head:<30}  [ " + (",\n" + pad).join(chunks) + " ]"
        body.append(txt)
    return (f"// F1R3Beat pattern, canonical form v2 · meter {n}/{d} · bars {bars} · column {col} · columns {S}\n"
            f"score F1R3Beat\nimport std\npitches   {{ {pd} }}\ndurations {{ {dd} }}\n{TIMBRES}\n" + "\n".join(body) + "\n")
MOTHER = {"drums": {0: "kick", 2: "chh", 4: "snare", 6: "chh", 8: "kick", 10: "kick", 12: "snare", 14: "ohh"},
          "bass": {0: "E2", 3: "E2", 6: "G2", 8: "A2", 11: "A2"},
          "guitar": {4: "E3", 12: "D3"}, "sax": {4: "D4", 8: "E4"}}
FATHER = {"drums": {0: "kick", 2: "chh", 4: "kick", 6: "chh", 8: "kick", 10: "chh", 12: "kick", 14: "chh"},
          "bass": {0: "A2", 4: "C3", 8: "D3", 14: "E3"},
          "guitar": {0: "G3"}, "keys": {4: "C4"}, "sax": {0: "G4", 2: "A4", 4: "B4"}}
CHILD = {"drums": FATHER["drums"],
         "bass": {0: "A2", 3: "C3", 6: "D3", 11: "E3"},   # slot at column 8 silenced by refill
         "guitar": {4: "G3"},                              # slot at column 12 silenced
         "sax": {4: "G4", 8: "B4"}}                        # A4 dropped
if __name__ == "__main__":
    for name, g in [("mother", MOTHER), ("father", FATHER), ("child", CHILD)]:
        open(f"fig/{name}.score", "w").write(score(g, (4, 4), 1, Fr(1, 16)))
