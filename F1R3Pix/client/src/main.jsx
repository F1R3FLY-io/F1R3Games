import { createRoot } from "react-dom/client";
import { App } from "./ui/App.jsx";
import { PixGame } from "./core/game.js";
import { connect, instanceParam, portalOrigin } from "./core/sdk.js";
import { startDemo } from "./demo.js";
import "./ui/styles.css";

const origin = portalOrigin();
let game, demo = false;
if (origin && window.parent !== window) {
  game = new PixGame(connect(origin), { instance: instanceParam() });
} else {
  // Not framed by a Portal: play against an in-memory shard with simulated players.
  game = startDemo(PixGame);
  demo = true;
}
createRoot(document.getElementById("root")).render(<App game={game} demo={demo} />);
