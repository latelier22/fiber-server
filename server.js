// server.js
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";

import fs from "fs";
import path from "path";

const PORT_HTTP = process.env.PORT_HTTP || 3030;
const PORT_WS   = process.env.PORT_WS   || 3031;

const STATE_FILE = process.env.STATE_FILE || path.resolve("./robot_state.json");

// --- options de replay au reload
const REPLAY_TARGET_ON_CONNECT = false;
const REPLAY_ROBOT_ON_CONNECT  = true;

// -------------------------
// Persist JSON (fichier)
// -------------------------
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.log("⚠️ loadState failed:", e?.message || e);
    return null;
  }
}

function saveState(state) {
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_FILE); // atomique
  } catch (e) {
    console.log("⚠️ saveState failed:", e?.message || e);
  }
}

// -------------------------
// App / WS registry
// -------------------------
const app = express();
app.use(cors());
app.use(express.json());

const clients = new Set();
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try { ws.send(data); } catch {}
    }
  }
}

// -------------------------
// Etats (RAM + restore fichier)
// -------------------------
let lastTarget = null;
let lastRobot  = null;
let busy = false;

// DEBUG: compteur robot-pos
let robotPosCount = 0;
let lastRobotPosAt = null;
let lastRobotPosIp = null;

const boot = loadState();
if (boot) {
  lastTarget = boot.lastTarget ?? null;
  lastRobot  = boot.lastRobot  ?? null;
  busy       = !!boot.busy;
  robotPosCount  = boot.robotPosCount ?? 0;
  lastRobotPosAt = boot.lastRobotPosAt ?? null;
  lastRobotPosIp = boot.lastRobotPosIp ?? null;
  console.log("💾 State restored from", STATE_FILE, { busy, hasRobot: !!lastRobot, hasTarget: !!lastTarget });
} else {
  console.log("💾 No state file yet:", STATE_FILE);
}

function persist() {
  saveState({
    lastTarget,
    lastRobot,
    busy,
    robotPosCount,
    lastRobotPosAt,
    lastRobotPosIp,
  });
}

// -------------------------
// WebSocket
// -------------------------
const wss = new WebSocketServer({ port: PORT_WS });

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("🛰️ WS client connecté. Total:", clients.size);

  try {
    if (REPLAY_TARGET_ON_CONNECT && lastTarget) {
      ws.send(JSON.stringify({ type: "target", data: lastTarget }));
    }
    if (REPLAY_ROBOT_ON_CONNECT && lastRobot) {
      ws.send(JSON.stringify({ type: "robot", data: lastRobot }));
    }
    ws.send(JSON.stringify({ type: "state", data: { busy } }));
  } catch {}

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "hello") return;

    if (msg.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
      return;
    }

    if (msg.type === "appel") {
      if (busy) {
        broadcast({ type: "busy", data: { busy: true } });
        return;
      }
      busy = true;
      broadcast({ type: "state", data: { busy } });
      persist();

      broadcast({ type: "appel", data: msg.data ?? { t: Date.now() } });
      console.log("📣 WS APPEL");
      return;
    }

    if (msg.type === "robot" && msg.data && typeof msg.data.x === "number" && typeof msg.data.y === "number") {
      lastRobot = { ...msg.data, time: msg.data.time ?? Date.now() };
      broadcast({ type: "robot", data: lastRobot });
      persist();
      return;
    }

    if (msg.type === "target" && msg.data && typeof msg.data.x === "number" && typeof msg.data.y === "number") {
      // IMPORTANT: si tu veux pouvoir remplacer la target même busy, enlève ce if(busy)…
      if (busy) {
        broadcast({ type: "busy", data: { busy: true } });
        return;
      }
      lastTarget = { ...msg.data, time: msg.data.time ?? Date.now() };
      broadcast({ type: "target", data: lastTarget });
      persist();
      return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("🔌 WS client déconnecté. Total:", clients.size);
  });
});

// -------------------------
// HTTP API
// -------------------------

// Health JSON (à utiliser pour debug)
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    busy,
    lastTarget,
    lastRobot,
    robotPosCount,
    lastRobotPosAt,
    lastRobotPosIp,
    stateFile: STATE_FILE,
  })
);

// Appel mobile
app.post("/api/call-robot", (req, res) => {
  console.log("🚑 /api/call-robot body=", req.body, "busy(before)=", busy);

  if (busy) return res.status(409).json({ error: "robot_busy" });

  const { x, y } = req.body || {};
  if (typeof x !== "number" || typeof y !== "number") {
    return res.status(400).json({ error: "x (lat) et y (lon) requis" });
  }

  lastTarget = { x, y, time: Date.now() };
  broadcast({ type: "target", data: lastTarget });

  busy = true;
  broadcast({ type: "state", data: { busy } });
  broadcast({ type: "appel", data: { t: Date.now(), source: "http-call-robot" } });

  persist();

  console.log("✅ call-robot OK => busy=true target=", lastTarget);
  res.json({ status: "ok", target: lastTarget, busy: true });
});

// Télémétrie robot (doit arriver TOUT LE TEMPS)
app.post("/api/robot-pos", (req, res) => {
  const { x, y, heading = null, speed = null } = req.body || {};
  if (typeof x !== "number" || typeof y !== "number") {
    return res.status(400).json({ error: "x (lat) et y (lon) requis" });
  }

  robotPosCount++;
  lastRobotPosAt = Date.now();
  lastRobotPosIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;

  lastRobot = { x, y, heading, speed, time: Date.now() };

  console.log(
    "🤖 /api/robot-pos",
    "count=", robotPosCount,
    "ip=", lastRobotPosIp,
    "x=", x, "y=", y,
    "heading=", heading,
    "speed=", speed
  );

  broadcast({ type: "robot", data: lastRobot });

  persist();

  res.json({ status: "ok" });
});

// Reset (rendre dispo)
app.post("/api/reset", (_req, res) => {
  lastTarget = null;
  busy = false;

  broadcast({ type: "clear" });
  broadcast({ type: "state", data: { busy } });

  persist();

  console.log("🧹 /api/reset => busy=false");
  res.json({ status: "ok" });
});

// Reset target seulement
app.post("/api/reset-target", (_req, res) => {
  lastTarget = null;
  broadcast({ type: "clear" });
  persist();
  console.log("🧹 /api/reset-target");
  res.json({ status: "ok" });
});

// Dernière position robot (App Inventor / front)
app.get("/api/robot-last", (_req, res) => {
  if (!lastRobot) return res.json({ ok: false });
  res.json({ ok: true, robot: lastRobot });
});

app.listen(PORT_HTTP, () => {
  console.log(`✅ HTTP prêt : http://localhost:${PORT_HTTP}`);
  console.log(`✅ WS prêt   : ws://localhost:${PORT_WS}`);
  console.log(`✅ STATE_FILE: ${STATE_FILE}`);
});


app.post("/api/return", (_req, res) => {
  console.log("↩️ /api/return");

  broadcast({
    type: "return",
    data: { t: Date.now() }
  });

  res.json({ status: "ok", action: "return" });
});

