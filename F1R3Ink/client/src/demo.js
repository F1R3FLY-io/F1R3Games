// The standalone demo: an in-memory shard and seven simulated players who
// enter (some public, some private), ink one another now and then (a few
// anonymously, through the simulated relay), and answer messages; the person
// is an eighth, and chooses their own visibility on entering.
import { FakeShard, DEMO_CONFIG } from "./core/fake.js";
import { seal, sealInk } from "./core/envelope.js";
import { toHex } from "./core/history.js";

const BOTS = [
  ["Britta Perry", "public", ["fierce", "fair"], [0, 6, 3]],
  ["Abed Nadir", "public", ["watching", "kind"], [5, 6, 10]],
  ["Troy Barnes", "private", ["goofy"], [2, 1, 9]],
  ["Annie Edison", "public", ["prepared", "anxious"], [4, 9, 10]],
  ["Shirley Bennett", "private", ["warm"], [1, 11, 12]],
  ["Pierce Hawthorne", "public", ["old money"], [13, 14, 8]],
  ["Jeff Winger", "public", ["persuasive"], [7, 6, 15]],
];

export function startDemo(Game) {
  const shard = new FakeShard({ instance: "demo-" + Math.random().toString(16).slice(2, 10), config: DEMO_CONFIG, relayWindow: 2 });
  const bots = BOTS.map(([name, flag, tags, likes], i) => ({ ...shard.addPlayer({ name }, { host: i === 0 }), name, flag, tags, likes }));
  const you = shard.addPlayer({ name: "You" });
  for (const b of bots) { shard.enter(b.address, b.pk, b.flag); shard.tags(b.address, b.tags); shard.block(); }
  shard.inst.status = "active";
  const inkOf = (bot, target, colour) => {
    const p = shard.get(["p", target]);
    if (!p) return null;
    if (p.flag === "public") return { c: colour };
    const stripe = shard.get(["s", target, bot.anon?.[target] ?? bot.address]);
    const sid = bot.anon?.[target] ?? bot.address;
    return { sealed: toHex(sealInk({ game: "f1r3ink", instance: shard.instanceId, target, sid, seq: (stripe?.seq ?? 0) + 1, parties: [p.pk, bot.pk], colour }).bytes) };
  };
  const tick = () => {
    const bot = bots[Math.floor(Math.random() * bots.length)];
    const others = shard.roster.filter((a) => a !== bot.address);
    const target = others[Math.floor(Math.random() * others.length)];
    const colour = Math.random() < 0.75 ? bot.likes[Math.floor(Math.random() * bot.likes.length)] : Math.floor(Math.random() * DEMO_CONFIG.palette.length);
    const anonymous = (bot.anon && target in bot.anon) || (Math.random() < 0.15 && !shard.get(["s", target, bot.address]));
    try {
      if (anonymous) {
        const r = shard.relayRequest(bot.address, "handles", {});
        bot.anon = { ...(bot.anon ?? {}), [target]: `anon:${r.handles[target]}` };
        shard.relayRequest(bot.address, "ink", { target, ink: inkOf(bot, target, colour) });
      } else {
        shard.ink(bot.address, target, inkOf(bot, target, colour));
      }
    } catch { /* too soon: the relay refuses at once */ }
    shard.block(6000);
  };
  for (let i = 0; i < 18; i++) tick();
  setInterval(tick, 2500);
  const answered = new Set();
  setInterval(() => {
    for (const b of bots) for (const m of shard.mail(b.address, {})[1]) {
      const k = `${m.from}:${m.seq}:${b.address}`;
      if (answered.has(k) || m.from !== you.address) continue;
      answered.add(k);
      const env = seal({ game: "f1r3ink", instance: shard.instanceId, sender: { address: b.address, pk: b.pk },
        recipients: [{ address: you.address, pk: you.pk }], text: `${b.name.split(" ")[0]} here: I picked that colour because of how you came in today.` });
      shard.say(b.address, [you.address], toHex(env));
      shard.block();
    }
  }, 2000);
  return new Game(shard.bridge(you.address), { instance: shard.instanceId, pollMs: 1500, now: () => shard.ts });
}
