import { useEffect, useState } from "react";
import { midiFile } from "../core/audio.js";

/** Play/stop, the player's own listening tempo (D7), and Download MIDI. */
export function Transport({ game, state, player, pattern }) {
  const [playing, setPlaying] = useState(player.playing);
  const [bpm, setBpm] = useState(game.tempo);
  const [text, setText] = useState(String(game.tempo));
  useEffect(() => { if (state.tempo === null) { setBpm(game.tempo); setText(String(game.tempo)); } }, [state.seats, state.grid]);
  const toggle = () => { if (player.playing) player.stop(); else { if (pattern) player.setPattern(pattern); player.setTempo(bpm); player.start(); } setPlaying(player.playing); };
  const change = (v) => { const b = game.setTempo(Number(v)); setBpm(b); setText(String(b)); player.setTempo(b); };
  const commit = () => { if (/^\d+$/.test(text)) change(text); else setText(String(bpm)); };
  const download = () => {
    const url = URL.createObjectURL(new Blob([midiFile(pattern, bpm)], { type: "audio/midi" }));
    const a = document.createElement("a");
    a.href = url; a.download = `f1r3beat-${game.instanceId?.slice(0, 8) ?? "pattern"}.mid`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="panel transport" role="group" aria-label="Transport">
      <button onClick={toggle} aria-pressed={playing} disabled={!pattern}>{playing ? "■ Stop" : "▶ Play"}</button>
      <label className="tempo">
        <span className="small">listening at</span>
        <input type="range" min={40} max={240} value={bpm} aria-label="tempo" onChange={(e) => change(e.target.value)} />
        <input className="bpm" inputMode="numeric" aria-label="bpm" value={text} onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
               onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
        <span className="small">bpm</span>
      </label>
      <button className="ghost small" disabled={!pattern} onClick={download}>Download MIDI</button>
    </div>
  );
}
