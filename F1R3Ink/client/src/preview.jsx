// The gallery renderers (design §13): the Portal posts {event: "preview",
// data: {header, body}}. A round replays every public flag by block; a
// portrait replays one flag, with the colours its owner disclosed.
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import { decodeFlag, decodeRound, fromHex } from "./core/history.js";
import { Replay } from "./ui/Replay.jsx";
import { PreviewFlags } from "./ui/Gallery.jsx";
import "./ui/styles.css";

export function Playback({ kind, header, body }) {
  const decoded = useMemo(() => {
    try {
      if (!body) return null;
      const b = fromHex(body);
      return kind === "flag" ? decodeFlag(b) : decodeRound(b);
    } catch { return null; }
  }, [body, kind]);
  const names = Object.fromEntries((header?.preview?.flags ?? []).filter((f) => f.n).map((f) => [f.p, f.n]));
  if (!decoded) {
    return (
      <div className="preview-page" style={{ padding: 12 }}>
        {header?.preview && <PreviewFlags preview={header.preview} size={64} />}
        <p className="muted small">{header?.preview?.text ?? "This play has no body to show."}</p>
      </div>
    );
  }
  return (
    <div className="preview-page" style={{ padding: 12 }}>
      <Replay kind={kind} decoded={decoded} title={header?.title} names={names} />
      {header?.preview?.text && <p className="small muted">{header.preview.text}</p>}
    </div>
  );
}

function Host({ kind }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    const h = (e) => { if (e.data && (e.data.f1r3games === 1 || e.data.f1r3games === 2) && e.data.event === "preview") setData(e.data.data); };
    window.addEventListener("message", h);
    return () => window.removeEventListener("message", h);
  }, []);
  return data ? <Playback kind={kind} header={data.header} body={data.body} /> : <p className="muted small" style={{ padding: 12 }}>Waiting for the play…</p>;
}

const el = document.getElementById("root");
if (el && el.dataset.kind) createRoot(el).render(<Host kind={el.dataset.kind} />);
