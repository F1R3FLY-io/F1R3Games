// The standalone demo: an in-memory shard, five simulated players who sit,
// paint toward a pattern and answer messages, and the person as a sixth.
import { FakeShard } from "./core/fake.js";
import { ringOf } from "./core/hex.js";
import { seal } from "./core/envelope.js";

const RINGS = ["#F3D630", "#F28C28", "#E5383B", "#3FA9F5", "#007BC4"];
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function startDemo(PixGame) {
  const shard = new FakeShard({ instance: "demo-" + Math.random().toString(16).slice(2, 10), config: { capacity: 37, seating: "random", palette: null, messageLimit: 2048 } });
  const host = shard.addPlayer({ name: "Britta Perry" }, { host: true });
  const bots = ["Abed Nadir", "Troy Barnes", "Annie Edison", "Shirley Bennett", "Pierce Hawthorne"].map((name) => shard.addPlayer({ name }));
  const you = shard.addPlayer({ name: "You" });
  for (const p of [host, ...bots]) shard.seat(p.address, p.pk, null);
  shard.inst.status = "active";
  const players = [host, ...bots];
  setInterval(() => {
    const p = players[Math.floor(Math.random() * players.length)];
    const s = shard.get(["seat", p.address]);
    if (!s) return;
    const target = RINGS[ringOf(...s.cell) % RINGS.length];
    shard.paint(p.address, Math.random() < 0.8 ? target : RINGS[Math.floor(Math.random() * RINGS.length)]);
    shard.block();
  }, 2500);
  // Answer anyone who writes to a simulated player.
  const answered = new Set();
  setInterval(() => {
    for (const p of players) {
      for (const m of shard.mail(p.address, {})[1]) {
        const k = `${m.from}:${m.seq}:${p.address}`;
        if (answered.has(k) || m.from !== you.address) continue;
        answered.add(k);
        const env = seal({ game: "f1r3pix", instance: shard.instanceId, sender: { address: p.address, pk: p.pk },
          recipients: [{ address: you.address, pk: you.pk }], text: `${shard.players[p.address].name.split(" ")[0]} here: deal. Send 5 each and we'll go gold in the middle.` });
        shard.say(p.address, [you.address], toHex(env));
        shard.block();
      }
    }
  }, 2000);
  return new PixGame(shard.bridge(you.address), { instance: shard.instanceId, pollMs: 1500 });
}
