// A symmetric 5×5 sigil derived from an address, in the brand palette.

const PALETTE = ["#F3D630", "#3FA9F5", "#F2F2F2", "#20486B", "#D2DAE0"];

function hashBytes(s: string): number[] {
  let h = 2166136261;
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    for (const c of s + i) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    out.push(h & 0xff);
  }
  return out;
}

export function Sigil({ address, size = 32 }: { address: string; size?: number }) {
  const b = hashBytes(address);
  const fg = PALETTE[b[0] % 2];
  const cells: JSX.Element[] = [];
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++)
      if (b[1 + y * 3 + x] & 1) {
        cells.push(<rect key={`${x}${y}`} x={x} y={y} width={1} height={1} fill={fg} />);
        if (x < 2) cells.push(<rect key={`m${x}${y}`} x={4 - x} y={y} width={1} height={1} fill={fg} />);
      }
  return (
    <svg className="sigil" width={size} height={size} viewBox="-0.5 -0.5 6 6" aria-label={`sigil of ${address}`}>
      <rect x={-0.5} y={-0.5} width={6} height={6} rx={1.2} fill="#0D3050" />
      {cells}
    </svg>
  );
}

export function short(address: string) {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}
