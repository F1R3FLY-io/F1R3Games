// Sound (design §8.2). The loop is scheduled on the Web Audio clock at the
// listener's own tempo (D7): tempo counts quarter notes, as F1R3Score's
// renderer does, so a column of 1/k whole notes lasts 240 / (k · bpm) seconds.
// A changed pattern takes effect at the next loop boundary.
//
// Timbres: the design calls for one bundled, permissively licensed General
// MIDI sound set so that every player hears the same instruments. Until that
// set is cut and bundled, this module synthesises a stand-in for each row
// with Web Audio oscillators and noise; the stand-in is the same on every
// device, which is the property the design needs.
import { notes } from "./score.js";

export const columnSeconds = (k, bpm) => 240 / (k * bpm);

/** The loop's events at `bpm`: {time, length, row, midi, note}, rests excluded. */
export function loopEvents(pattern, bpm) {
  const col = columnSeconds(pattern.shape.k, bpm);
  return notes(pattern).map((n) => ({ time: n.step * col, length: col, row: n.row, midi: n.midi, note: n.note }));
}
export const loopSeconds = (pattern, bpm) => pattern.shape.steps * columnSeconds(pattern.shape.k, bpm);

const hz = (m) => 440 * 2 ** ((m - 69) / 12);

function noiseBuffer(ctx) {
  const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = b.getChannelData(0);
  let x = 0x2545f491;
  for (let i = 0; i < d.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; d[i] = ((x >>> 0) / 4294967296) * 2 - 1; }
  return b;
}

function env(ctx, g, t, attack, peak, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

/** Play one note at audio time `t` into `out`. */
export function voice(ctx, out, noise, { row, midi, length }, t) {
  const g = ctx.createGain();
  g.connect(out);
  if (row === 0) {
    const name = midi;
    if (name === 36) { // kick
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      o.connect(g); env(ctx, g, t, 0.002, 0.9, 0.25); o.start(t); o.stop(t + 0.3); return;
    }
    if ([45, 47, 50].includes(name)) { // toms
      const o = ctx.createOscillator(); const f = { 45: 110, 47: 146, 50: 196 }[name];
      o.frequency.setValueAtTime(f * 1.4, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
      o.connect(g); env(ctx, g, t, 0.002, 0.6, 0.3); o.start(t); o.stop(t + 0.35); return;
    }
    const s = ctx.createBufferSource(); s.buffer = noise;
    const f = ctx.createBiquadFilter();
    const hat = [42, 44, 46, 49, 51].includes(name);
    f.type = hat ? "highpass" : "bandpass";
    f.frequency.value = hat ? 7000 : name === 37 ? 1800 : 1200;
    s.connect(f); f.connect(g);
    const decay = { 42: 0.05, 44: 0.07, 46: 0.35, 49: 1.2, 51: 0.6, 37: 0.04, 38: 0.18, 39: 0.12 }[name] ?? 0.15;
    env(ctx, g, t, 0.001, hat ? 0.35 : 0.7, decay);
    if (name === 38) { const o = ctx.createOscillator(); o.frequency.value = 190; const og = ctx.createGain(); o.connect(og); og.connect(out); env(ctx, og, t, 0.001, 0.4, 0.08); o.start(t); o.stop(t + 0.12); }
    s.start(t, 0, decay + 0.05); return;
  }
  const o = ctx.createOscillator();
  o.type = ["", "triangle", "sawtooth", "triangle", "square"][row];
  o.frequency.value = hz(midi);
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = [0, 900, 2600, 4000, 1800][row];
  o.connect(f); f.connect(g);
  const hold = Math.max(0.05, length * 0.92);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime([0, 0.5, 0.22, 0.3, 0.18][row], t + 0.01);
  g.gain.setValueAtTime([0, 0.5, 0.22, 0.3, 0.18][row], t + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + hold + 0.08);
  o.start(t); o.stop(t + hold + 0.1);
}

/** A looping player: start(), stop(), setPattern(p), setTempo(bpm); onStep(step) for the playhead. */
export class LoopPlayer {
  constructor({ ctx = null, onStep = () => {} } = {}) { this.ctx = ctx; this.onStep = onStep; this.pattern = null; this.next = null; this.bpm = 100; this.timer = null; }
  setPattern(p) { this.next = p; if (!this.pattern) this.pattern = p; }
  setTempo(bpm) { this.bpm = bpm; }
  get playing() { return !!this.timer; }
  start() {
    if (this.timer || !this.pattern) return;
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!this.ctx) { if (!AC) return; this.ctx = new AC(); }
    this.out = this.ctx.createGain(); this.out.gain.value = 0.8; this.out.connect(this.ctx.destination);
    this.noise = noiseBuffer(this.ctx);
    this.nextTime = this.ctx.currentTime + 0.05; this.step = 0;
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  }
  stop() { clearInterval(this.timer); this.timer = null; try { this.out?.disconnect(); } catch { /* already gone */ } this.onStep(null); }
  tick() {
    const ctx = this.ctx, ahead = ctx.currentTime + 0.12;
    while (this.nextTime <= ahead) {
      const p = this.pattern, t = this.nextTime, s = this.step;
      const col = columnSeconds(p.shape.k, this.bpm);
      for (const n of notes(p).filter((x) => x.step === s)) voice(ctx, this.out, this.noise, { row: n.row, midi: n.midi, length: col }, t);
      setTimeout(() => this.timer && this.onStep(s), Math.max(0, (t - ctx.currentTime) * 1000));
      this.nextTime = t + col;
      this.step = s + 1;
      if (this.step >= p.shape.steps) { this.step = 0; if (this.next) this.pattern = this.next; }
    }
  }
}

/** A Standard MIDI File (type 1, 960 ticks per quarter) of one pass of the loop at `bpm`. */
export function midiFile(pattern, bpm) {
  const ppq = 960;
  const ticks = (step) => Math.round(step * (4 * ppq) / pattern.shape.k);
  const vlq = (n) => { const out = [n & 127]; while ((n >>= 7)) out.unshift((n & 127) | 128); return out; };
  const track = (events) => {
    const body = [];
    let last = 0;
    for (const [t, bytes] of events.sort((a, b) => a[0] - b[0] || a[2] - b[2])) { body.push(...vlq(t - last), ...bytes); last = t; }
    body.push(0, 0xff, 0x2f, 0);
    return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
  };
  const us = Math.round(60_000_000 / bpm);
  const tracks = [track([[0, [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255], 0]])];
  const PROGRAMS = [[0, 9], [33, 1], [29, 2], [0, 3], [66, 4]]; // [program, channel - 1]
  for (let row = 0; row < 5; row++) {
    const [prog, ch] = PROGRAMS[row];
    const ev = [[0, [0xc0 | ch, prog], 0]];
    for (const n of notes(pattern).filter((x) => x.row === row)) {
      ev.push([ticks(n.step), [0x90 | ch, n.midi, 96], 1]);
      ev.push([ticks(n.step + 1), [0x80 | ch, n.midi, 0], 0]);
    }
    tracks.push(track(ev));
  }
  const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, ppq >> 8, ppq & 255];
  return Uint8Array.from([...hdr, ...tracks.flat()]);
}
