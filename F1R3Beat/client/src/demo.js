// The standalone demo: an in-memory shard and seven simulated players who sit,
// set notes toward a groove for their row, and answer messages; the person is
// an eighth.
import { FakeShard, DEMO_CONFIG } from "./core/fake.js";
import { rowOf, stepOf } from "./core/grid.js";
import { seal } from "./core/envelope.js";

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
// What each row "wants" at a step of a 16-step bar: a rock groove in E minor.
const GROOVE = [
  (s) => (s % 8 === 0 ? "kick" : s % 8 === 4 ? "snare" : s % 2 === 0 ? "chh" : null),
  (s) => (s % 4 === 0 ? ["E2", "E2", "G2", "A2"][(s / 4) % 4] : s % 8 === 6 ? "B2" : null),
  (s) => (s % 8 === 4 ? ["E3", "G3"][(s / 8) % 2 | 0] : null),
  (s) => (s % 8 === 0 ? ["B3", "D4"][(s / 8) % 2 | 0] : null),
  (s) => (s === 6 || s === 14 ? ["E4", "D4"][(s / 8) | 0] : null),
];

export function startDemo(Game) {
  const shard = new FakeShard({ instance: "demo-" + Math.random().toString(16).slice(2, 10), config: DEMO_CONFIG });
  const host = shard.addPlayer({ name: "Britta Perry" }, { host: true });
  const bots = ["Abed Nadir", "Troy Barnes", "Annie Edison", "Shirley Bennett", "Pierce Hawthorne", "Ben Chang"].map((name) => shard.addPlayer({ name }));
  const you = shard.addPlayer({ name: "You" });
  const players = [host, ...bots];
  for (const p of players) shard.seat(p.address, p.pk, null);
  shard.inst.status = "active";
  setInterval(() => {
    const p = players[Math.floor(Math.random() * players.length)];
    const s = shard.get(["seat", p.address]);
    if (!s) return;
    const want = GROOVE[rowOf(s.cell)](stepOf(s.cell) % 16);
    shard.setNote(p.address, Math.random() < 0.85 ? want : null);
    shard.block();
  }, 2200);
  const answered = new Set();
  setInterval(() => {
    for (const p of players) for (const m of shard.mail(p.address, {})[1]) {
      const k = `${m.from}:${m.seq}:${p.address}`;
      if (answered.has(k) || m.from !== you.address) continue;
      answered.add(k);
      const env = seal({ game: "f1r3beat", instance: shard.instanceId, sender: { address: p.address, pk: p.pk },
        recipients: [{ address: you.address, pk: you.pk }], text: `${shard.players[p.address].name.split(" ")[0]} here: send 5 and I'll hold the backbeat.` });
      shard.say(p.address, [you.address], toHex(env));
      shard.block();
    }
  }, 2000);
  return new Game(shard.bridge(you.address), { instance: shard.instanceId, pollMs: 1500 });
}
