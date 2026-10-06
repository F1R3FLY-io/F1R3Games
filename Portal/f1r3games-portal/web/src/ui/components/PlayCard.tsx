import { Link } from "react-router-dom";
import type { PlayHeader } from "../../core/portal";
import { Sigil, short } from "./Sigil";

export function previewText(p: PlayHeader): string {
  const pv = p.preview as any;
  if (pv && typeof pv === "object" && typeof pv.text === "string") return pv.text;
  if (typeof pv === "string") return pv;
  return "";
}

export function PlayCard({ play, gameName }: { play: PlayHeader; gameName?: string }) {
  const pv = play.preview as any;
  return (
    <Link className="card play-card" to={`/plays/${play.id}`}>
      {pv && typeof pv === "object" && typeof pv.svg === "string" ? (
        <img className="thumb" alt="" src={`data:image/svg+xml;utf8,${encodeURIComponent(pv.svg)}`} />
      ) : (
        <div className="thumb placeholder">{(gameName ?? play.game).slice(0, 2)}</div>
      )}
      <div className="card-body">
        <div className="card-title">{play.title || `${play.kind} ${play.id.slice(0, 6)}`}</div>
        <div className="muted small">
          {gameName ?? play.game} · {play.kind} · {new Date(play.createdAt).toLocaleString()}
        </div>
        <div className="authors">
          {play.authors.map((a) => (
            <span key={a} title={a}>
              <Sigil address={a} size={18} /> {short(a)}
            </span>
          ))}
        </div>
        {previewText(play) && <p className="small">{previewText(play)}</p>}
      </div>
    </Link>
  );
}
