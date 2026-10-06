import math, random
S=0.42
DIRS=[(1,0),(1,-1),(0,-1),(-1,0),(-1,1),(0,1)]
def spiral(R):
    out=[(0,0)]
    for k in range(1,R+1):
        q,r=-k,k
        for i in range(6):
            for j in range(k):
                out.append((q,r)); q+=DIRS[i][0]; r+=DIRS[i][1]
    return out
def xy(q,r,s): return (s*math.sqrt(3)*(q+r/2), -s*1.5*r)
def hexpath(q,r,s,shrink=0.96):
    cx,cy=xy(q,r,s); pts=[]
    for i in range(6):
        a=math.radians(60*i-30); pts.append((cx+s*shrink*math.cos(a), cy+s*shrink*math.sin(a)))
    return " -- ".join(f"({x:.3f},{y:.3f})" for x,y in pts)+" -- cycle"
def dist(q,r): return max(abs(q),abs(r),abs(q+r))
# Figure 1: board radius 4, 44 seated players, sun pattern
R=4; cells=spiral(R); random.seed(7)
seated=set(cells[:1])|set(random.sample(cells[1:],43))
pal={0:"F3D630",1:"F2A900",2:"E3611C",3:"3FA9F5",4:"00528C"}
lines=[]
selected={(2,-1),(-1,3),(3,-3)}; selected&=seated
selected=set(list(selected)) or set()
mine=(1,0); seated.add(mine)
for (q,r) in cells:
    d=dist(q,r)
    if (q,r) in seated:
        col=pal[d]
        if (q,r)==(2,1) or (q,r)==(-3,0): col="FFFFFF"  # a couple not yet coordinated
        lines.append(f"\\fill[fill={{rgb,255:red,{int(col[0:2],16)};green,{int(col[2:4],16)};blue,{int(col[4:6],16)}}}] {hexpath(q,r,S)};")
        lines.append(f"\\draw[black!35,line width=0.3pt] {hexpath(q,r,S)};")
    else:
        lines.append(f"\\draw[black!25,line width=0.4pt,dash pattern=on 1.2pt off 1.2pt] {hexpath(q,r,S)};")
for (q,r) in selected:
    lines.append(f"\\draw[brandskydark,line width=1.6pt] {hexpath(q,r,S,1.02)};")
q,r=mine
lines.append(f"\\draw[black,line width=1.6pt] {hexpath(q,r,S,1.02)};")
cx,cy=xy(q,r,S); lines.append(f"\\fill[black] ({cx:.3f},{cy:.3f}) circle (0.07);")
open("fig/board.tex","w").write("\n".join(lines))
# Figure 2: spiral index R=2
lines=[]
s=0.55
for i,(q,r) in enumerate(spiral(2)):
    lines.append(f"\\draw[black!50,line width=0.4pt] {hexpath(q,r,s)};")
    cx,cy=xy(q,r,s)
    lines.append(f"\\node[font=\\footnotesize\\sffamily] at ({cx:.3f},{cy+0.09:.3f}) {{{i}}};")
    lines.append(f"\\node[font=\\scriptsize\\ttfamily,text=black!55] at ({cx:.3f},{cy-0.17:.3f}) {{{q},{r}}};")
open("fig/spiral.tex","w").write("\n".join(lines))
print([3*k*(k+1)+1 for k in range(1,13)])
print(spiral(1))
