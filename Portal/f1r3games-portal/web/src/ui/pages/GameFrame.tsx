import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { GameHost } from "../../core/host";
import { InviteDialog } from "../components/InviteDialog";
import { Async } from "../components/Async";
import { useLoad, usePortal } from "../PortalContext";

/** Host a game in a sandboxed frame and answer its protocol. */
export function GameFrame() {
  const { id = "" } = useParams();
  const portal = usePortal();
  const data = useLoad(async (p) => {
    const inst = await p.instance(id);
    const game = inst ? await p.game(inst.game) : null;
    return inst && game ? { inst, game } : null;
  }, [id]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    if (!data.data) return;
    const { game } = data.data;
    // Templates and allowance (granted at launch, or a default here for joiners).
    if (!portal.wallet.allowances().some((a) => a.instance === id)) portal.enterGame(game, id, 2_000_000);
    const host = new GameHost(portal, game, id, () => frame.current?.contentWindow ?? null, { openInvite: () => setInviting(true) });
    return host.attach();
  }, [data.data]);

  return (
    <Async state={data}>
      {({ game, inst }) =>
        game.platforms?.includes("visionos") && !game.entry.startsWith("http") ? (
          <section className="panel narrow">
            <h1>{game.name}</h1>
            <p>This game is played on Apple Vision Pro. Open the instrument and join instance:</p>
            <code className="block">{inst.id}</code>
            <p className="muted">
              The instrument imports the same key file and publishes performances and tunes to this instance; they appear in the galleries here.
            </p>
          </section>
        ) : (
          new URL(game.entry, location.href).origin === location.origin ? (
            // allow-same-origin below is safe only because the game is on another origin.
            <section className="panel narrow">
              <h1>{game.name}</h1>
              <p className="error">This game is served from the portal's own origin. The portal frames games only from their own origin.</p>
            </section>
          ) : (
          <>
            {/* allow-same-origin keeps the game on its real origin, so the host protocol can check
                event.origin and address its replies to it; without it the frame's origin is opaque
                ("null") and every message is dropped. The game is on another origin than the portal,
                so this grants it nothing over the portal. allow-downloads lets a game hand the player a
                file it made (F1R3Beat's Download MIDI). */}
            <iframe
              ref={frame}
              className="game"
              title={game.name}
              sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"
              src={`${game.entry}${game.entry.includes("?") ? "&" : "?"}instance=${inst.id}&portal=${encodeURIComponent(location.origin)}`}
            />
            {inviting && <InviteDialog instance={inst.id} game={game} onClose={() => setInviting(false)} />}
          </>
          )
        )
      }
    </Async>
  );
}
