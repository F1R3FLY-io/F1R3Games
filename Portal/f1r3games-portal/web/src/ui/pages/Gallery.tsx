import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Async } from "../components/Async";
import { PlayCard } from "../components/PlayCard";
import { useLoad } from "../PortalContext";

export function Gallery() {
  const { id = "" } = useParams();
  const game = useLoad((p) => p.game(id), [id]);
  const [kind, setKind] = useState<string | null>(null);
  const current = kind ?? game.data?.galleries[0]?.kind ?? null;
  const plays = useLoad(async (p) => (current ? p.gallery(id, current) : []), [id, current]);
  const open = useLoad((p) => p.publicInstances(id), [id]);
  return (
    <Async state={game}>
      {(g) => (
        <>
          <h1>{g.name}</h1>
          {g.galleries.length > 1 && (
            <div className="tabs">
              {g.galleries.map((k) => (
                <button key={k.kind} className={k.kind === current ? "tab on" : "tab"} onClick={() => setKind(k.kind)}>
                  {k.label ?? k.kind}
                </button>
              ))}
            </div>
          )}
          <Async state={plays} empty={<p className="muted">No {current} yet in the last two weeks.</p>}>
            {(ps) => (
              <div className="grid">
                {ps.map((p) => (
                  <PlayCard key={p.id} play={p} gameName={g.name} />
                ))}
              </div>
            )}
          </Async>
          <h2>Open instances</h2>
          <Async state={open} empty={<p className="muted">No public instances. Unlisted instances are reached by their link.</p>}>
            {(is) => (
              <ul className="plain">
                {is.filter((i) => i.status !== "closed").map((i) => (
                  <li key={i.id}>
                    <Link to={`/instances/${i.id}`}>{i.id.slice(0, 10)}</Link> · {Object.keys(i.participants).length} players · {i.status}
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </>
      )}
    </Async>
  );
}
