import { Link } from "react-router-dom";
import { Async } from "../components/Async";
import { PlayCard } from "../components/PlayCard";
import { useLoad, usePortal } from "../PortalContext";

export function Home() {
  const portal = usePortal();
  const games = useLoad((p) => p.games());
  const feed = useLoad(async (p) => p.feed(7, await p.games()));
  const names = Object.fromEntries((games.data ?? []).map((g) => [g.id, g.name]));
  return (
    <>
      {!portal.signedOn && (
        <section className="hero">
          <h1>Play together on the shard.</h1>
          <p>Your key is your account: one sign-on for every game, a wallet that asks before it pays, and galleries of everything anyone has played.</p>
          <div className="row">
            <Link className="button" to="/signon">Sign on</Link>
            <Link className="button secondary" to="/games">Browse games</Link>
          </div>
        </section>
      )}
      <h2>Recent plays</h2>
      <Async state={feed} empty={<p className="muted">No plays in the last week. <Link to="/games">Start one.</Link></p>}>
        {(plays) => (
          <div className="grid">
            {plays.map((p) => (
              <PlayCard key={p.id} play={p} gameName={names[p.game]} />
            ))}
          </div>
        )}
      </Async>
    </>
  );
}
