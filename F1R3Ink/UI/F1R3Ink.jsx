import { useState, useEffect, useCallback, useRef } from "react";

// ══════════════════════════════════════════════════════════════════
// F1R3Ink — Collective Emotional Intelligence
// Shard-native | F1R3FLY Brand Book V1.0
// ══════════════════════════════════════════════════════════════════

// ── F1R3FLY Brand System (Brand Book V1.0) ───────────────────────
const BRAND = {
  yellow: "#F3D630", sage: "#8BB999", sky: "#3FA9F5",
  surface: "#08080f", card: "#0c0c18", border: "#1a1a30",
  text: "#ffffff", textSec: "#999", textMuted: "#555", textDim: "#333",
};

const BRAND_FONTS = `
  @import url('https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@300;400;600;700&display=swap');
  @font-face { font-family:'Brandon Grotesque'; src:local('Brandon Grotesque Medium'),local('BrandonGrotesque-Medium'); font-weight:500; }
  @font-face { font-family:'Brandon Grotesque'; src:local('Brandon Grotesque Bold'),local('BrandonGrotesque-Bold'); font-weight:700; }
  @font-face { font-family:'Brandon Grotesque'; src:local('Brandon Grotesque Regular'),local('BrandonGrotesque-Regular'); font-weight:400; }
`;

const FONT_HEADING = "'Brandon Grotesque', 'Source Sans 3', sans-serif";
const FONT_BODY = "'Source Sans 3', 'Brandon Grotesque', sans-serif";
const FONT_MONO = "'Brandon Grotesque', 'Source Sans 3', monospace";

const F1R3FLY_LOGO_URI = "data:image/png;base64,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";

function F1R3FLYLogo({ size = 48 }) {
  return <img src={F1R3FLY_LOGO_URI} width={size} height={size}
    alt="F1R3FLY" style={{ objectFit: "contain", display: "block" }} />;
}

function BrandBar({ title, accent, subtitle, right }) {
  return (
    <header style={{
      padding: "10px 20px", borderBottom: `1px solid ${BRAND.border}`,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      background: `linear-gradient(180deg, ${BRAND.card} 0%, ${BRAND.surface} 100%)`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <F1R3FLYLogo size={28} />
        <div>
          <span style={{ fontSize: 15, fontWeight: 300, letterSpacing: 3,
            color: "#888", fontFamily: FONT_HEADING }}>
            F1R3<span style={{ color: accent || BRAND.sky, fontWeight: 700 }}>{title}</span>
          </span>
          {subtitle && (
            <div style={{ fontSize: 8, color: BRAND.textDim, letterSpacing: 2, marginTop: 1 }}>
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {right && <div>{right}</div>}
    </header>
  );
}



// ── Shard config ─────────────────────────────────────────────────
const PFX_P = "f1r3ink-player:";
const PFX_I = "f1r3ink-ink:";
const MY_ID = "f1r3ink-myid";
const POLL = 2000;

const INK_COLORS = [
  { hex: "#FF2D55", name: "rose" },   { hex: "#FF6B2B", name: "ember" },
  { hex: "#FFD60A", name: "gold" },   { hex: "#30D158", name: "verdant" },
  { hex: "#00C7BE", name: "teal" },   { hex: "#40C8E0", name: "sky" },
  { hex: "#5E5CE6", name: "indigo" }, { hex: "#BF5AF2", name: "violet" },
  { hex: "#FF375F", name: "coral" },  { hex: "#FFFFFF", name: "light" },
  { hex: "#8E8E93", name: "ash" },    { hex: "#1C1C1E", name: "void" },
];

// ── Shard helpers ────────────────────────────────────────────────
const sh = {
  async get(k,s=true){try{const r=await window.storage.get(k,s);return r?.value?JSON.parse(r.value):null}catch{return null}},
  async set(k,v,s=true){try{await window.storage.set(k,JSON.stringify(v),s);return true}catch{return false}},
  async del(k,s=true){try{await window.storage.delete(k,s);return true}catch{return false}},
  async list(p){try{const r=await window.storage.list(p,true);return r?.keys||[]}catch{return[]}},
};

// ── Avatar sigil ─────────────────────────────────────────────────
function hSeed(id){let h=0;for(let i=0;i<id.length;i++)h=((h<<5)-h+id.charCodeAt(i))|0;return Math.abs(h)}

function Sigil({seed,size=64}){
  const s=seed%10000,h1=s%360,h2=(s*7+120)%360,r=size*.38;
  const shapes=[];
  for(let i=0;i<5;i++){
    const a=((Math.PI*2)/5)*i+((s*(i+1))%60)*.02;
    const d=r*.3+((s*(i+3))%40)*r*.012;
    shapes.push(<circle key={i} cx={size/2+Math.cos(a)*d} cy={size/2+Math.sin(a)*d}
      r={4+((s*(i+2))%8)} fill={`hsl(${i%2===0?h1:h2},70%,65%)`} opacity={.85}/>);
  }
  const pts=[];
  for(let i=0;i<6;i++){
    const a=((Math.PI*2)/6)*i+(s%30)*.05;
    const d=r*.25+((s*(i+1))%20)*.5;
    pts.push(`${size/2+Math.cos(a)*d},${size/2+Math.sin(a)*d}`);
  }
  return(
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill={`hsl(${h1},25%,15%)`} stroke={`hsl(${h1},50%,40%)`} strokeWidth="1.5"/>
      {shapes}
      <polygon points={pts.join(" ")} fill="none" stroke={`hsl(${h2},60%,70%)`} strokeWidth="1.2" opacity=".7"/>
    </svg>
  );
}

// ── Freak Flag ───────────────────────────────────────────────────
function FreakFlag({stripes,seed,size=64,showFull=false}){
  const flagH=showFull?Math.max(size,stripes.length*4+20):size;
  const sh2=stripes.length>0?Math.min(6,(flagH-10)/stripes.length):6;
  return(
    <div style={{position:"relative",width:showFull?size+80:size+40,height:flagH,display:"flex",alignItems:"center"}}>
      <div style={{position:"absolute",left:0,top:"50%",transform:"translateY(-50%)",width:"100%",display:"flex",flexDirection:"column",gap:1}}>
        {stripes.map((s,i)=>(
          <div key={i} style={{height:sh2,background:`linear-gradient(90deg,transparent 0%,${s.color}88 15%,${s.color} 40%,${s.color}66 80%,transparent 100%)`,borderRadius:2,animation:`stripeIn .6s ${i*.05}s ease-out both`}}/>
        ))}
      </div>
      <div style={{position:"relative",zIndex:2,flexShrink:0,filter:"drop-shadow(0 0 6px rgba(0,0,0,.8))"}}>
        <Sigil seed={seed} size={size}/>
      </div>
    </div>
  );
}

// ── Color Picker ─────────────────────────────────────────────────
function ColorPicker({onSelect,selected}){
  return(
    <div style={{display:"flex",flexWrap:"wrap",gap:6,justifyContent:"center",padding:"8px 0"}}>
      {INK_COLORS.map(c=>(
        <button key={c.hex} onClick={()=>onSelect(c.hex)} title={c.name}
          style={{width:28,height:28,borderRadius:"50%",background:c.hex,
            border:selected===c.hex?"2px solid #fff":c.hex==="#1C1C1E"?"1px solid #444":"1px solid transparent",
            cursor:"pointer",transition:"transform .15s,box-shadow .15s",
            transform:selected===c.hex?"scale(1.25)":"scale(1)",
            boxShadow:selected===c.hex?`0 0 12px ${c.hex}88`:"none"}}/>
      ))}
    </div>
  );
}

// ── Tag editor ───────────────────────────────────────────────────
function TagEditor({tags,onUpdate}){
  const[editing,setEditing]=useState(false);
  const[draft,setDraft]=useState(tags.join(", "));
  const save=()=>{const t=draft.split(",").map(s=>s.trim()).filter(Boolean).slice(0,6);onUpdate(t);setEditing(false)};
  if(editing)return(
    <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
      <input value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>e.key==="Enter"&&save()}
        placeholder="mood, vibe, role..." autoFocus
        style={{background:BRAND.card,border:`1px solid ${BRAND.border}`,borderRadius:4,color:"#ccc",
          padding:"4px 8px",fontSize:12,fontFamily:FONT_BODY,width:"100%",maxWidth:200}}/>
      <button onClick={save} style={{background:"none",border:"1px solid #555",color:"#aaa",
        borderRadius:4,padding:"2px 8px",fontSize:11,cursor:"pointer",fontFamily:FONT_BODY}}>ok</button>
    </div>
  );
  return(
    <div onClick={()=>{setDraft(tags.join(", "));setEditing(true)}}
      style={{display:"flex",flexWrap:"wrap",gap:4,cursor:"pointer",minHeight:24}} title="click to edit">
      {tags.length===0&&<span style={{color:"#555",fontSize:11,fontStyle:"italic"}}>+ add tags</span>}
      {tags.map((t,i)=><span key={i} style={{background:BRAND.card,border:`1px solid ${BRAND.border}`,
        borderRadius:3,padding:"1px 7px",fontSize:11,color:"#8888aa",fontFamily:FONT_BODY}}>{t}</span>)}
    </div>
  );
}

// ── Wheel entry ──────────────────────────────────────────────────
function WheelEntry({player,stripes,isSelected,onSelect}){
  return(
    <div onClick={onSelect} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:8,cursor:"pointer",
      background:isSelected?"#1a1a3a":"transparent",border:isSelected?`1px solid ${BRAND.sky}44`:"1px solid transparent",transition:"all .2s"}}>
      <FreakFlag stripes={stripes} seed={hSeed(player.id)} size={42}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,color:isSelected?"#e0e0ff":"#999",fontFamily:FONT_HEADING,
          whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{player.name}</div>
        {player.tags?.length>0&&(
          <div style={{display:"flex",gap:3,flexWrap:"wrap",marginTop:3}}>
            {player.tags.slice(0,3).map((t,i)=><span key={i} style={{fontSize:9,color:"#666",background:"#111",padding:"0 4px",borderRadius:2}}>{t}</span>)}
          </div>
        )}
        <div style={{fontSize:9,color:"#444",marginTop:2}}>{stripes.length} ink{stripes.length!==1?"s":""}</div>
      </div>
    </div>
  );
}

// ── Shard status ─────────────────────────────────────────────────
function ShardStatus({ok,players,inks,sync}){
  return(
    <div style={{display:"flex",alignItems:"center",gap:8,fontSize:8,color:"#444"}}>
      <div style={{width:5,height:5,borderRadius:"50%",background:ok?"#30D158":"#FF453A",
        boxShadow:ok?"0 0 6px #30D15844":"none",animation:ok?"breathe 2s infinite":"none"}}/>
      <span style={{letterSpacing:1}}>SHARD {ok?"LIVE":"OFFLINE"}</span>
      <span style={{color:"#333"}}>|</span>
      <span>{players} player{players!==1?"s":""}</span>
      <span style={{color:"#333"}}>|</span>
      <span>{inks} ink{inks!==1?"s":""}</span>
    </div>
  );
}

// ── Join screen ──────────────────────────────────────────────────
function JoinScreen({onJoin,existingPlayers}){
  const[name,setName]=useState("");
  const[tags,setTags]=useState("");
  const go=()=>{const n=name.trim();if(!n)return;onJoin(n,tags.split(",").map(s=>s.trim()).filter(Boolean).slice(0,6))};
  return(
    <div style={{minHeight:"100vh",background:BRAND.surface,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",fontFamily:FONT_HEADING}}>
      <style>{BRAND_FONTS}{`
        @keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
        *{box-sizing:border-box} input:focus{border-color:${BRAND.sky}66!important}
      `}</style>
      <div style={{animation:"fadeIn .6s ease-out",textAlign:"center"}}>
        <F1R3FLYLogo size={56}/>
        <h1 style={{margin:"16px 0 0",fontSize:28,fontWeight:300,letterSpacing:6,color:"#888",fontFamily:FONT_HEADING}}>
          F1R3<span style={{color:"#FF2D55",fontWeight:700}}>Ink</span>
        </h1>
        <div style={{fontSize:10,color:BRAND.textDim,marginTop:4,letterSpacing:2}}>COLLECTIVE EMOTIONAL INTELLIGENCE</div>
        <div style={{marginTop:32,display:"flex",flexDirection:"column",gap:12,alignItems:"center"}}>
          <input value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}
            placeholder="your name" style={{background:"#111",border:`1px solid ${BRAND.border}`,borderRadius:6,
              color:"#ccc",padding:"10px 16px",fontSize:14,width:260,fontFamily:FONT_HEADING,textAlign:"center",outline:"none"}}/>
          <input value={tags} onChange={e=>setTags(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}
            placeholder="tags: mood, vibe, role..."
            style={{background:"#111",border:`1px solid ${BRAND.border}`,borderRadius:6,
              color:"#888",padding:"8px 16px",fontSize:11,width:260,fontFamily:FONT_BODY,textAlign:"center",outline:"none"}}/>
          <button onClick={go} style={{background:"#FF2D55",color:"#fff",border:"none",borderRadius:6,
            padding:"10px 32px",fontSize:13,fontFamily:FONT_HEADING,fontWeight:500,cursor:"pointer",
            letterSpacing:3,marginTop:8,boxShadow:"0 0 20px #FF2D5544"}}>JOIN</button>
        </div>
        {existingPlayers.length>0&&(
          <div style={{marginTop:32,color:BRAND.textDim,fontSize:10,letterSpacing:1}}>
            {existingPlayers.length} already playing:
            <div style={{marginTop:6,display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap"}}>
              {existingPlayers.map(p=>(
                <div key={p.id} style={{display:"flex",alignItems:"center",gap:4}}>
                  <Sigil seed={hSeed(p.id)} size={20}/><span style={{color:"#555",fontSize:10}}>{p.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
export default function F1R3Ink(){
  const[phase,setPhase]=useState("loading");
  const[myId,setMyId]=useState(null);
  const[players,setPlayers]=useState([]);
  const[inksByTarget,setInksByTarget]=useState({});
  const[selTarget,setSelTarget]=useState(null);
  const[selColor,setSelColor]=useState(null);
  const[flash,setFlash]=useState(null);
  const[shardOk,setShardOk]=useState(false);
  const[lastSync,setLastSync]=useState(null);
  const pollRef=useRef(null);

  const me=players.find(p=>p.id===myId);
  const others=players.filter(p=>p.id!==myId);
  const mySeed=myId?hSeed(myId):0;
  const myStripes=inksByTarget[myId]||[];
  const totalInks=Object.values(inksByTarget).reduce((a,b)=>a+b.length,0);

  const loadPlayers=useCallback(async()=>{
    const keys=await sh.list(PFX_P);const all=[];
    for(const k of keys){const p=await sh.get(k);if(p)all.push(p)}
    all.sort((a,b)=>a.joinedAt-b.joinedAt);setPlayers(all);return all;
  },[]);

  const loadAllInks=useCallback(async(pl)=>{
    const pList=pl||players;const result={};
    for(const p of pList){const keys=await sh.list(`${PFX_I}${p.id}:`);const inks=[];
      for(const k of keys){const ink=await sh.get(k);if(ink)inks.push(ink)}
      inks.sort((a,b)=>a.ts-b.ts);result[p.id]=inks}
    setInksByTarget(result);return result;
  },[players]);

  const sync=useCallback(async()=>{
    try{const pl=await loadPlayers();await loadAllInks(pl);setShardOk(true);setLastSync(Date.now())}
    catch{setShardOk(false)}
  },[loadPlayers,loadAllInks]);

  useEffect(()=>{(async()=>{
    const savedId=await sh.get(MY_ID,false);
    if(savedId){const p=await sh.get(`${PFX_P}${savedId}`);
      if(p){setMyId(savedId);await sync();setPhase("play");return}}
    await loadPlayers();setPhase("join");
  })()},[]);

  useEffect(()=>{if(phase!=="play")return;pollRef.current=setInterval(sync,POLL);
    return()=>clearInterval(pollRef.current)},[phase,sync]);

  const handleJoin=async(name,tags)=>{
    const id=`p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
    const player={id,name,tags,joinedAt:Date.now()};
    await sh.set(`${PFX_P}${id}`,player);await sh.set(MY_ID,id,false);
    setMyId(id);await sync();setPhase("play");
  };

  const inkPlayer=async()=>{
    if(!selTarget||!selColor||!myId)return;
    const ts=Date.now();const key=`${PFX_I}${selTarget}:${ts}:${myId}`;
    const data={from:myId,target:selTarget,color:selColor,ts};
    if(await sh.set(key,data)){
      setInksByTarget(prev=>({...prev,[selTarget]:[...(prev[selTarget]||[]),data]}));
      setFlash(selColor);setTimeout(()=>setFlash(null),400);setSelColor(null);
    }
  };

  const updateTags=async(t)=>{if(!me)return;const u={...me,tags:t};
    await sh.set(`${PFX_P}${myId}`,u);setPlayers(p=>p.map(x=>x.id===myId?u:x))};

  const leave=async()=>{
    if(myId){await sh.del(`${PFX_P}${myId}`);
      for(const p of players){const keys=await sh.list(`${PFX_I}${p.id}:`);
        for(const k of keys){if(k.endsWith(`:${myId}`))await sh.del(k)}}
      await sh.set(MY_ID,null,false)}
    setMyId(null);setPhase("join");await loadPlayers();
  };

  if(phase==="loading")return(
    <div style={{minHeight:"100vh",background:BRAND.surface,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:FONT_HEADING}}>
      <style>{BRAND_FONTS}{`@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}`}</style>
      <div style={{color:"#555",fontSize:12,letterSpacing:2,animation:"pulse 1.5s ease-in-out infinite"}}>connecting to shard...</div>
    </div>
  );

  if(phase==="join")return <JoinScreen onJoin={handleJoin} existingPlayers={players}/>;

  return(
    <div style={{minHeight:"100vh",background:BRAND.surface,color:"#ddd",fontFamily:FONT_BODY,
      display:"flex",flexDirection:"column",overflow:"hidden",position:"relative"}}>
      {flash&&<div style={{position:"fixed",inset:0,background:flash,opacity:.12,pointerEvents:"none",zIndex:100,animation:"flashFade .4s ease-out forwards"}}/>}
      <style>{BRAND_FONTS}{`
        @keyframes stripeIn{from{opacity:0;transform:scaleX(0);transform-origin:left}to{opacity:1;transform:scaleX(1)}}
        @keyframes flashFade{from{opacity:.15}to{opacity:0}}
        @keyframes breathe{0%,100%{opacity:.5}50%{opacity:1}}
        @keyframes slideUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:${BRAND.border};border-radius:2px}
        *{box-sizing:border-box} input:focus{border-color:${BRAND.sky}66!important}
      `}</style>

      <BrandBar title="Ink" accent="#FF2D55"
        subtitle={<ShardStatus ok={shardOk} players={players.length} inks={totalInks}/>}
        right={<button onClick={leave} style={{background:"none",border:`1px solid ${BRAND.border}`,color:"#555",
          borderRadius:4,padding:"4px 10px",fontSize:10,cursor:"pointer",fontFamily:FONT_HEADING,letterSpacing:1}}>LEAVE</button>}/>

      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        {/* LEFT: My flag */}
        <div style={{width:"38%",minWidth:180,borderRight:`1px solid ${BRAND.border}`,padding:"20px 16px",
          display:"flex",flexDirection:"column",alignItems:"center",gap:16,overflowY:"auto"}}>
          <div style={{fontSize:10,color:BRAND.textMuted,letterSpacing:2,fontFamily:FONT_HEADING}}>MY FLAG</div>
          <FreakFlag stripes={myStripes} seed={mySeed} size={72} showFull/>
          <div style={{fontSize:16,color:"#ccc",fontFamily:FONT_HEADING,fontWeight:700}}>{me?.name}</div>
          <div style={{width:"100%",maxWidth:200}}>
            <div style={{fontSize:9,color:"#444",marginBottom:4,letterSpacing:1,fontFamily:FONT_HEADING}}>TAGS</div>
            <TagEditor tags={me?.tags||[]} onUpdate={updateTags}/>
          </div>
          {myStripes.length>0&&(
            <div style={{width:"100%",maxWidth:200,marginTop:8,animation:"slideUp .3s ease-out"}}>
              <div style={{fontSize:9,color:"#444",letterSpacing:1,marginBottom:6,fontFamily:FONT_HEADING}}>INKED BY</div>
              {myStripes.slice().reverse().slice(0,12).map((s,i)=>{const from=players.find(p=>p.id===s.from);return(
                <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:s.color,flexShrink:0}}/>
                  <span style={{fontSize:10,color:"#666",fontFamily:FONT_BODY}}>{from?.name||"?"}</span>
                  <span style={{fontSize:9,color:"#333"}}>{new Date(s.ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>
                </div>
              )})}
            </div>
          )}
          {myStripes.length===0&&(
            <div style={{color:"#333",fontSize:11,fontStyle:"italic",textAlign:"center",marginTop:20,lineHeight:1.6,fontFamily:FONT_BODY}}>
              no ink yet<br/><span style={{fontSize:9}}>others will color your flag</span>
            </div>
          )}
        </div>

        {/* RIGHT: Community wheel */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{padding:"16px 16px 8px",fontSize:10,color:BRAND.textMuted,letterSpacing:2,fontFamily:FONT_HEADING}}>COMMUNITY WHEEL</div>
          <div style={{flex:1,overflowY:"auto",padding:"0 12px 12px"}}>
            {others.length===0&&(
              <div style={{color:"#333",fontSize:11,fontStyle:"italic",textAlign:"center",marginTop:40,lineHeight:1.8,fontFamily:FONT_BODY}}>
                waiting for others to join...<br/><span style={{fontSize:9}}>share this artifact to play together</span>
              </div>
            )}
            {others.map(p=>(
              <WheelEntry key={p.id} player={p} stripes={inksByTarget[p.id]||[]}
                isSelected={selTarget===p.id} onSelect={()=>setSelTarget(selTarget===p.id?null:p.id)}/>
            ))}
          </div>
          {selTarget&&(
            <div style={{borderTop:`1px solid ${BRAND.border}`,padding:"12px 16px",animation:"slideUp .2s ease-out"}}>
              <div style={{fontSize:11,color:"#666",marginBottom:6,textAlign:"center",fontFamily:FONT_BODY}}>
                ink <span style={{color:"#aaa"}}>{players.find(p=>p.id===selTarget)?.name}</span> with a color
              </div>
              <ColorPicker onSelect={setSelColor} selected={selColor}/>
              {selColor&&(
                <div style={{textAlign:"center",marginTop:8}}>
                  <button onClick={inkPlayer} style={{
                    background:selColor,color:selColor==="#FFD60A"||selColor==="#FFFFFF"?"#111":"#fff",
                    border:"none",borderRadius:6,padding:"8px 28px",fontSize:13,fontFamily:FONT_HEADING,
                    fontWeight:500,cursor:"pointer",letterSpacing:2,boxShadow:`0 0 20px ${selColor}44`,transition:"transform .1s"}}
                    onMouseDown={e=>e.currentTarget.style.transform="scale(.95)"}
                    onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}>INK</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <footer style={{padding:"6px 20px",borderTop:`1px solid ${BRAND.border}`,display:"flex",
        justifyContent:"space-between",fontSize:9,color:"#333",letterSpacing:1,fontFamily:FONT_BODY}}>
        <span>shard: player:{players.length} + ink:{totalInks}</span>
        <span>poll: {POLL/1000}s</span>
        <span>id: {myId?.slice(0,10)}...</span>
      </footer>
    </div>
  );
}
