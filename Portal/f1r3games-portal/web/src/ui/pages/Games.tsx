import { Link } from "react-router-dom";
import { Async } from "../components/Async";
import { useLoad, usePortal } from "../PortalContext";

export function Games() {
  const portal = usePortal();
  const games = useLoad((p) => p.games());
  return (
    <>
      <h1>Games</h1>
      <Async state={games} empty={<p className="muted">No games are registered yet. The F1R3FLY.io Cooperative registers games.</p>}>
        {(gs) => (
          <div className="grid">
            {gs.map((g) => (
              <div className="card game-card" key={g.id}>
                <div className="card-body">
                  <div className="card-title">{g.name}</div>
                  {g.tagline && <p className="muted">{g.tagline}</p>}
                  <div className="row">
                    <Link className="button" to={portal.signedOn ? `/games/${g.id}/launch` : `/signon?next=/games/${g.id}/launch`}>
                      Launch
                    </Link>
                    <Link className="button secondary" to={`/games/${g.id}/gallery`}>
                      {g.galleries.length > 1 ? "Galleries" : "Gallery"}
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Async>
    </>
  );
}
