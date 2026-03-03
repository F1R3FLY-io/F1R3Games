// Basic F1R3Pix ideas
import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ─── Constants & Config ────────────────────────────────────────────
const HEX_SIZE = 32;
const HEX_GAP = 3;
const GRID_RINGS = 5; // hexagonal grid rings from center
const COLORS = [
  "#0a0a0a", "#ff2d55", "#ff6b35", "#ffd700", "#39ff14",
  "#00e5ff", "#7b61ff", "#ff61d8", "#ffffff", "#1a1a2e",
  "#e63946", "#457b9d", "#2a9d8f", "#e9c46a", "#f4a261",
  "#264653", "#606c38", "#dda15e", "#bc6c25", "#780000",
];

const PLAYER_AVATARS = [
  { id: "p1", name: "You", emoji: "🔥", color: "#ff2d55" },
  { id: "p2", name: "Aria", emoji: "🌊", color: "#00e5ff" },
  { id: "p3", name: "Kael", emoji: "⚡", color: "#ffd700" },
  { id: "p4", name: "Nova", emoji: "🌸", color: "#ff61d8" },
  { id: "p5", name: "Zeph", emoji: "🍃", color: "#39ff14" },
  { id: "p6", name: "Onyx", emoji: "🌑", color: "#7b61ff" },
  { id: "p7", name: "Lyra", emoji: "✨", color: "#e9c46a" },
  { id: "p8", name: "Rune", emoji: "🔮", color: "#457b9d" },
  { id: "p9", name: "Ash", emoji: "🌋", color: "#e63946" },
  { id: "p10", name: "Fern", emoji: "🌿", color: "#2a9d8f" },
  { id: "p11", name: "Sol", emoji: "☀️", color: "#f4a261" },
  { id: "p12", name: "Mist", emoji: "🌫️", color: "#606c38" },
];

// ─── Hex Grid Math ─────────────────────────────────────────────────
function hexToPixel(q, r, size) {
  const x = size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const y = size * ((3 / 2) * r);
  return { x, y };
}

function generateHexGrid(rings) {
  const cells = [];
  for (let q = -rings; q <= rings; q++) {
    for (let r = -rings; r <= rings; r++) {
      const s = -q - r;
      if (Math.abs(s) <= rings) {
        cells.push({ q, r, s });
      }
    }
  }
  return cells;
}

function hexCorners(cx, cy, size) {
  const corners = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    corners.push({
      x: cx + size * Math.cos(angle),
      y: cy + size * Math.sin(angle),
    });
  }
  return corners.map((c) => `${c.x},${c.y}`).join(" ");
}

// ─── Assign players to hex cells ───────────────────────────────────
function assignPlayersToGrid(cells, players) {
  const assignment = {};
  const shuffled = [...cells].sort(() => Math.random() - 0.5);
  players.forEach((p, i) => {
    if (i < shuffled.length) {
      const key = `${shuffled[i].q},${shuffled[i].r}`;
      assignment[key] = p.id;
    }
  });
  return assignment;
}

// ─── Hex Cell Component ────────────────────────────────────────────
function HexCell({ q, r, size, color, owner, isHighlighted, isOwn, onClick }) {
  const { x, y } = hexToPixel(q, r, size + HEX_GAP);
  const points = hexCorners(x, y, size);
  const glowColor = isHighlighted ? "#00e5ff" : isOwn ? "#ff2d55" : "none";

  return (
    <g
      onClick={onClick}
      style={{ cursor: isOwn ? "pointer" : "default" }}
      className="hex-cell"
    >
      {(isHighlighted || isOwn) && (
        <polygon
          points={hexCorners(x, y, size + 3)}
          fill="none"
          stroke={glowColor}
          strokeWidth="2"
          opacity="0.7"
          style={{
            filter: `drop-shadow(0 0 6px ${glowColor})`,
            animation: isHighlighted ? "pulse 2s ease-in-out infinite" : "none",
          }}
        />
      )}
      <polygon
        points={points}
        fill={color || "#111118"}
        stroke="#1a1a2e"
        strokeWidth="1"
        style={{
          transition: "fill 0.5s ease",
          filter: color && color !== "#0a0a0a"
            ? `drop-shadow(0 0 4px ${color}40)`
            : "none",
        }}
      />
      {owner && (
        <text
          x={x}
          y={y + 1}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="10"
          fill="#ffffff80"
          style={{ pointerEvents: "none" }}
        >
          {PLAYER_AVATARS.find((p) => p.id === owner)?.emoji || ""}
        </text>
      )}
    </g>
  );
}

// ─── Color Picker ──────────────────────────────────────────────────
function ColorPicker({ currentColor, onSelect }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(5, 1fr)",
      gap: "6px",
      padding: "12px",
      background: "#0d0d15",
      borderRadius: "12px",
      border: "1px solid #1a1a2e",
    }}>
      {COLORS.map((c) => (
        <button
          key={c}
          onClick={() => onSelect(c)}
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "6px",
            background: c,
            border: currentColor === c ? "2px solid #fff" : "2px solid #1a1a2e",
            cursor: "pointer",
            transition: "transform 0.15s, border 0.15s",
            boxShadow: currentColor === c ? `0 0 10px ${c}80` : "none",
          }}
          onMouseEnter={(e) => (e.target.style.transform = "scale(1.2)")}
          onMouseLeave={(e) => (e.target.style.transform = "scale(1)")}
        />
      ))}
    </div>
  );
}

// ─── Message Bubble ────────────────────────────────────────────────
function MessageBubble({ msg, isSent }) {
  const player = PLAYER_AVATARS.find((p) => p.id === (isSent ? msg.to?.[0] : msg.from));
  return (
    <div style={{
      display: "flex",
      flexDirection: isSent ? "row-reverse" : "row",
      gap: "8px",
      alignItems: "flex-end",
      marginBottom: "8px",
    }}>
      <div style={{
        width: "24px",
        height: "24px",
        borderRadius: "50%",
        background: player?.color || "#333",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "12px",
        flexShrink: 0,
      }}>
        {player?.emoji}
      </div>
      <div style={{
        maxWidth: "200px",
        padding: "8px 12px",
        borderRadius: isSent ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
        background: isSent ? "#1a1a3e" : "#0d0d15",
        border: `1px solid ${player?.color || "#333"}30`,
        fontSize: "12px",
        color: "#ccc",
        lineHeight: "1.4",
      }}>
        <div style={{ fontSize: "10px", color: player?.color, marginBottom: "2px", fontWeight: 600 }}>
          {isSent ? `→ ${player?.name}` : player?.name}
        </div>
        {msg.text}
      </div>
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────────────
export default function F1R3Pix() {
  const currentPlayer = PLAYER_AVATARS[0];
  const otherPlayers = PLAYER_AVATARS.slice(1);

  const hexCells = useMemo(() => generateHexGrid(GRID_RINGS), []);
  const [cellOwners] = useState(() => assignPlayersToGrid(hexCells, PLAYER_AVATARS));
  const [cellColors, setCellColors] = useState({});
  const [selectedColor, setSelectedColor] = useState("#ff2d55");
  const [selectedPlayers, setSelectedPlayers] = useState(new Set());
  const [tokenBalance, setTokenBalance] = useState(1000);
  const [sendAmount, setSendAmount] = useState("");
  const [messages, setMessages] = useState([
    { id: 1, from: "p3", to: ["p1"], text: "Let's make a spiral from center!", time: Date.now() - 60000 },
    { id: 2, from: "p5", to: ["p1"], text: "I'll go green if you go red next to me", time: Date.now() - 30000 },
  ]);
  const [newMessage, setNewMessage] = useState("");
  const [tokenLog, setTokenLog] = useState([
    { id: 1, from: "p1", to: "p3", amount: 50, time: Date.now() - 120000 },
    { id: 2, from: "p7", to: "p1", amount: 25, time: Date.now() - 90000 },
  ]);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const msgEndRef = useRef(null);

  // scroll messages
  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Simulate other players changing colors
  useEffect(() => {
    const interval = setInterval(() => {
      const keys = Object.keys(cellOwners).filter((k) => cellOwners[k] !== "p1");
      if (keys.length === 0) return;
      const rk = keys[Math.floor(Math.random() * keys.length)];
      const rc = COLORS[Math.floor(Math.random() * COLORS.length)];
      setCellColors((prev) => ({ ...prev, [rk]: rc }));
    }, 3000);
    return () => clearInterval(interval);
  }, [cellOwners]);

  const handleHexClick = useCallback((q, r) => {
    const key = `${q},${r}`;
    if (cellOwners[key] === currentPlayer.id) {
      setCellColors((prev) => ({ ...prev, [key]: selectedColor }));
    }
  }, [cellOwners, currentPlayer.id, selectedColor]);

  const togglePlayer = useCallback((playerId) => {
    setSelectedPlayers((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  }, []);

  const sendMessage = useCallback(() => {
    if (!newMessage.trim() || selectedPlayers.size === 0) return;
    const msg = {
      id: Date.now(),
      from: currentPlayer.id,
      to: Array.from(selectedPlayers),
      text: newMessage.trim(),
      time: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
    setNewMessage("");
  }, [newMessage, selectedPlayers, currentPlayer.id]);

  const sendTokens = useCallback(() => {
    const amt = parseInt(sendAmount);
    if (!amt || amt <= 0 || amt > tokenBalance || selectedPlayers.size === 0) return;
    const perPlayer = Math.floor(amt / selectedPlayers.size);
    selectedPlayers.forEach((pid) => {
      setTokenLog((prev) => [
        ...prev,
        { id: Date.now() + Math.random(), from: currentPlayer.id, to: pid, amount: perPlayer, time: Date.now() },
      ]);
    });
    setTokenBalance((prev) => prev - perPlayer * selectedPlayers.size);
    setSendAmount("");
  }, [sendAmount, tokenBalance, selectedPlayers, currentPlayer.id]);

  // Identify highlighted cells
  const highlightedCells = useMemo(() => {
    const set = new Set();
    Object.entries(cellOwners).forEach(([key, owner]) => {
      if (selectedPlayers.has(owner)) set.add(key);
    });
    return set;
  }, [cellOwners, selectedPlayers]);

  // SVG dimensions
  const gridWidth = (GRID_RINGS * 2 + 1) * (HEX_SIZE + HEX_GAP) * Math.sqrt(3);
  const gridHeight = (GRID_RINGS * 2 + 1) * (HEX_SIZE + HEX_GAP) * 1.6;

  return (
    <div style={{
      width: "100%",
      height: "100vh",
      background: "#06060e",
      color: "#e0e0e0",
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      display: "flex",
      overflow: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Outfit:wght@300;400;500;600;700;800&display=swap');

        @keyframes pulse {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 5px currentColor; }
          50% { box-shadow: 0 0 15px currentColor, 0 0 30px currentColor; }
        }
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        .hex-cell polygon { transition: fill 0.5s ease, filter 0.3s ease; }
        .hex-cell:hover polygon { filter: brightness(1.3) !important; }
        .scrollbar-thin::-webkit-scrollbar { width: 4px; }
        .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
        .scrollbar-thin::-webkit-scrollbar-thumb { background: #1a1a2e; border-radius: 2px; }
        input, textarea {
          font-family: 'JetBrains Mono', monospace;
        }
      `}</style>

      {/* ═══ LEFT COLUMN: Tokens & Transactions ═══ */}
      <div style={{
        width: "240px",
        minWidth: "240px",
        background: "#08081240",
        borderRight: "1px solid #1a1a2e",
        display: "flex",
        flexDirection: "column",
        padding: "16px",
        gap: "16px",
      }}>
        {/* Logo */}
        <div style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: "18px",
          fontWeight: 800,
          letterSpacing: "2px",
          textAlign: "center",
          padding: "8px 0",
          background: "linear-gradient(135deg, #ff2d55, #ff6b35, #ffd700)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}>
          F1R3PIX
        </div>

        {/* Balance */}
        <div style={{
          background: "#0d0d15",
          borderRadius: "12px",
          padding: "16px",
          border: "1px solid #1a1a2e",
        }}>
          <div style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "1.5px", color: "#666", marginBottom: "8px" }}>
            F1R3Cap Balance
          </div>
          <div style={{
            fontSize: "28px",
            fontWeight: 700,
            fontFamily: "'Outfit', sans-serif",
            color: "#ffd700",
            textShadow: "0 0 20px #ffd70040",
          }}>
            {tokenBalance.toLocaleString()}
          </div>
          <div style={{ fontSize: "10px", color: "#555", marginTop: "4px" }}>
            ≈ staked on shard
          </div>
        </div>

        {/* Send Tokens */}
        <div style={{
          background: "#0d0d15",
          borderRadius: "12px",
          padding: "16px",
          border: "1px solid #1a1a2e",
        }}>
          <div style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "1.5px", color: "#666", marginBottom: "12px" }}>
            Send F1R3Cap
          </div>
          {selectedPlayers.size === 0 ? (
            <div style={{ fontSize: "11px", color: "#444", fontStyle: "italic" }}>
              Select players on the right →
            </div>
          ) : (
            <>
              <div style={{ fontSize: "11px", color: "#888", marginBottom: "8px" }}>
                To: {Array.from(selectedPlayers).map((pid) => {
                  const p = PLAYER_AVATARS.find((x) => x.id === pid);
                  return p ? `${p.emoji} ${p.name}` : pid;
                }).join(", ")}
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <input
                  type="number"
                  value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value)}
                  placeholder="Amount"
                  style={{
                    flex: 1,
                    background: "#111118",
                    border: "1px solid #1a1a2e",
                    borderRadius: "8px",
                    padding: "8px",
                    color: "#ffd700",
                    fontSize: "13px",
                    outline: "none",
                    width: "80px",
                  }}
                />
                <button
                  onClick={sendTokens}
                  style={{
                    background: "linear-gradient(135deg, #ffd700, #ff6b35)",
                    border: "none",
                    borderRadius: "8px",
                    padding: "8px 14px",
                    color: "#06060e",
                    fontWeight: 700,
                    fontSize: "12px",
                    cursor: "pointer",
                    fontFamily: "'Outfit', sans-serif",
                  }}
                >
                  SEND
                </button>
              </div>
            </>
          )}
        </div>

        {/* Token Log */}
        <div style={{
          flex: 1,
          background: "#0d0d15",
          borderRadius: "12px",
          padding: "12px",
          border: "1px solid #1a1a2e",
          overflow: "auto",
        }}
        className="scrollbar-thin"
        >
          <div style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "1.5px", color: "#666", marginBottom: "10px" }}>
            Transaction Log
          </div>
          {[...tokenLog].reverse().slice(0, 20).map((tx) => {
            const from = PLAYER_AVATARS.find((p) => p.id === tx.from);
            const to = PLAYER_AVATARS.find((p) => p.id === tx.to);
            const isSent = tx.from === currentPlayer.id;
            return (
              <div key={tx.id} style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 0",
                borderBottom: "1px solid #111118",
                fontSize: "11px",
                animation: "slideIn 0.3s ease",
              }}>
                <span style={{ color: isSent ? "#ff2d55" : "#39ff14" }}>
                  {isSent ? "↑" : "↓"}
                </span>
                <span>{from?.emoji}</span>
                <span style={{ color: "#444" }}>→</span>
                <span>{to?.emoji}</span>
                <span style={{
                  marginLeft: "auto",
                  color: isSent ? "#ff2d55" : "#39ff14",
                  fontWeight: 600,
                }}>
                  {isSent ? "-" : "+"}{tx.amount}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══ CENTER COLUMN: Hex Grid ═══ */}
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
      }}>
        {/* Ambient background */}
        <div style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse at center, #0d0d1540, #06060e)",
          pointerEvents: "none",
        }} />

        {/* Color picker toggle */}
        <div style={{
          position: "absolute",
          top: "16px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 10,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "8px",
        }}>
          <button
            onClick={() => setShowColorPicker(!showColorPicker)}
            style={{
              background: selectedColor,
              width: "40px",
              height: "40px",
              borderRadius: "50%",
              border: "3px solid #fff",
              cursor: "pointer",
              boxShadow: `0 0 20px ${selectedColor}60`,
              transition: "transform 0.2s",
            }}
            onMouseEnter={(e) => (e.target.style.transform = "scale(1.1)")}
            onMouseLeave={(e) => (e.target.style.transform = "scale(1)")}
          />
          {showColorPicker && <ColorPicker currentColor={selectedColor} onSelect={(c) => { setSelectedColor(c); setShowColorPicker(false); }} />}
        </div>

        {/* Grid title */}
        <div style={{
          position: "absolute",
          bottom: "16px",
          left: "50%",
          transform: "translateX(-50%)",
          fontSize: "10px",
          letterSpacing: "3px",
          textTransform: "uppercase",
          color: "#333",
          fontFamily: "'Outfit', sans-serif",
        }}>
          {hexCells.length} cells • {PLAYER_AVATARS.length} players • {selectedPlayers.size} selected
        </div>

        {/* SVG Grid */}
        <svg
          width="100%"
          height="100%"
          viewBox={`${-gridWidth / 2 - 20} ${-gridHeight / 2 - 20} ${gridWidth + 40} ${gridHeight + 40}`}
          style={{ maxWidth: "100%", maxHeight: "100%" }}
        >
          <defs>
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {hexCells.map(({ q, r }) => {
            const key = `${q},${r}`;
            const owner = cellOwners[key];
            return (
              <HexCell
                key={key}
                q={q}
                r={r}
                size={HEX_SIZE}
                color={cellColors[key]}
                owner={owner}
                isHighlighted={highlightedCells.has(key)}
                isOwn={owner === currentPlayer.id}
                onClick={() => handleHexClick(q, r)}
              />
            );
          })}
        </svg>
      </div>

      {/* ═══ RIGHT COLUMN: Players & Messages ═══ */}
      <div style={{
        width: "260px",
        minWidth: "260px",
        background: "#08081240",
        borderLeft: "1px solid #1a1a2e",
        display: "flex",
        flexDirection: "column",
        padding: "16px",
        gap: "12px",
      }}>
        {/* Current player avatar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "12px",
          background: "#0d0d15",
          borderRadius: "12px",
          border: `1px solid ${currentPlayer.color}40`,
        }}>
          <div style={{
            width: "48px",
            height: "48px",
            borderRadius: "50%",
            background: `linear-gradient(135deg, ${currentPlayer.color}, ${currentPlayer.color}80)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "24px",
            boxShadow: `0 0 20px ${currentPlayer.color}30`,
          }}>
            {currentPlayer.emoji}
          </div>
          <div>
            <div style={{
              fontFamily: "'Outfit', sans-serif",
              fontWeight: 700,
              fontSize: "16px",
            }}>
              {currentPlayer.name}
            </div>
            <div style={{ fontSize: "10px", color: currentPlayer.color, letterSpacing: "1px" }}>
              ACTIVE
            </div>
          </div>
        </div>

        {/* Player wheel */}
        <div style={{
          background: "#0d0d15",
          borderRadius: "12px",
          border: "1px solid #1a1a2e",
          padding: "10px",
          maxHeight: "220px",
          overflow: "auto",
        }}
        className="scrollbar-thin"
        >
          <div style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "1.5px", color: "#666", marginBottom: "8px" }}>
            Players ({otherPlayers.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {otherPlayers.map((p) => {
              const isSelected = selectedPlayers.has(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => togglePlayer(p.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 10px",
                    borderRadius: "10px",
                    border: isSelected ? `1px solid ${p.color}` : "1px solid transparent",
                    background: isSelected ? `${p.color}15` : "transparent",
                    cursor: "pointer",
                    transition: "all 0.2s",
                    textAlign: "left",
                    color: isSelected ? "#fff" : "#888",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "12px",
                  }}
                >
                  <div style={{
                    width: "30px",
                    height: "30px",
                    borderRadius: "50%",
                    background: isSelected
                      ? `linear-gradient(135deg, ${p.color}, ${p.color}80)`
                      : "#111118",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "14px",
                    transition: "all 0.2s",
                    boxShadow: isSelected ? `0 0 10px ${p.color}40` : "none",
                  }}>
                    {p.emoji}
                  </div>
                  <span style={{ fontWeight: isSelected ? 600 : 400 }}>{p.name}</span>
                  {isSelected && (
                    <div style={{
                      marginLeft: "auto",
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      background: p.color,
                      boxShadow: `0 0 6px ${p.color}`,
                    }} />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Messages */}
        <div style={{
          flex: 1,
          background: "#0d0d15",
          borderRadius: "12px",
          border: "1px solid #1a1a2e",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}>
          <div style={{
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "1.5px",
            color: "#666",
            padding: "12px 12px 8px",
          }}>
            Messages
          </div>
          <div
            style={{
              flex: 1,
              overflow: "auto",
              padding: "0 12px",
            }}
            className="scrollbar-thin"
          >
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                isSent={msg.from === currentPlayer.id}
              />
            ))}
            <div ref={msgEndRef} />
          </div>
          <div style={{
            padding: "10px",
            borderTop: "1px solid #1a1a2e",
            display: "flex",
            gap: "6px",
          }}>
            <input
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder={
                selectedPlayers.size > 0
                  ? `Message ${selectedPlayers.size} player${selectedPlayers.size > 1 ? "s" : ""}...`
                  : "Select players first..."
              }
              disabled={selectedPlayers.size === 0}
              style={{
                flex: 1,
                background: "#111118",
                border: "1px solid #1a1a2e",
                borderRadius: "8px",
                padding: "8px 10px",
                color: "#ccc",
                fontSize: "12px",
                outline: "none",
              }}
            />
            <button
              onClick={sendMessage}
              disabled={selectedPlayers.size === 0 || !newMessage.trim()}
              style={{
                background: selectedPlayers.size > 0 && newMessage.trim()
                  ? "linear-gradient(135deg, #7b61ff, #ff61d8)"
                  : "#1a1a2e",
                border: "none",
                borderRadius: "8px",
                padding: "8px 12px",
                color: "#fff",
                fontSize: "12px",
                cursor: selectedPlayers.size > 0 ? "pointer" : "default",
                fontWeight: 600,
                fontFamily: "'Outfit', sans-serif",
              }}
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
