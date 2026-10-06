import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Async } from "../components/Async";
import { Sigil, short } from "../components/Sigil";
import { useLoad, usePortal, usePortalCtx } from "../PortalContext";
import { message } from "../util";

/** A play: header, links (tunes ↔ performances), engagement, and the game's
 *  own preview renderer in a sandboxed frame. */
export function Play() {
  const { id = "" } = useParams();
  const portal = usePortal();
  const { refresh } = usePortalCtx();
  const play = useLoad((p) => p.play(id), [id]);
  const game = useLoad(async (p) => (play.data ? p.game(play.data.game) : null), [play.data?.game]);
  const counts = useLoad((p) => p.counts(id), [id]);
  const linked = useLoad(async (p) => Promise.all((play.data?.links ?? []).map((l) => p.play(l))), [play.data?.links?.join()]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const renderer = game.data?.galleries.find((k) => k.kind === play.data?.kind)?.renderer;

  useEffect(() => {
    if (!renderer || !play.data || !frame.current) return;
    const f = frame.current;
    const send = async () => {
      const body = await portal.playBody(id).catch(() => null);
      f.contentWindow?.postMessage({ f1r3games: 2, event: "preview", data: { header: play.data, body } }, new URL(renderer, location.href).origin);
    };
    f.addEventListener("load", send);
    return () => f.removeEventListener("load", send);
  }, [renderer, play.data]);

  return (
    <Async state={play}>
      {(p) => (
        <article className="panel">
          <h1>{p.title || `${p.kind} ${p.id.slice(0, 8)}`}</h1>
          <p className="muted">
            {game.data?.name ?? p.game} · {p.kind} · version {p.version} · {new Date(p.createdAt).toLocaleString()}
          </p>
          <div className="authors">
            {p.authors.map((a) => (
              <span key={a}>
                <Sigil address={a} size={22} /> {short(a)}
              </span>
            ))}
          </div>
          {renderer ? (
            <iframe ref={frame} className="preview" title="preview" sandbox="allow-scripts" src={renderer} />
          ) : (
            <p className="muted">This game provides no preview renderer.</p>
          )}
          {(linked.data?.length ?? 0) > 0 && (
            <>
              <h2>Linked</h2>
              <ul className="plain">
                {linked.data!.filter(Boolean).map((l) => (
                  <li key={l!.id}>
                    <Link to={`/plays/${l!.id}`}>{l!.title || `${l!.kind} ${l!.id.slice(0, 8)}`}</Link> <span className="muted">({l!.kind})</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="row">
            <span className="muted">{Object.entries(counts.data ?? {}).map(([k, n]) => `${n} ${k}`).join(" · ") || "no engagement yet"}</span>
            {portal.signedOn && (
              <button
                className="secondary small"
                onClick={async () => {
                  try {
                    await portal.engage(id, "like");
                    setNote("Recorded; it shows once the block is finalised.");
                    refresh();
                  } catch (e) {
                    setNote(message(e));
                  }
                }}
              >
                Like
              </button>
            )}
            <Link className="button secondary small" to={`/instances/${p.instance}`}>
              Open the instance
            </Link>
          </div>
          {note && <p className="muted small">{note}</p>}
        </article>
      )}
    </Async>
  );
}
