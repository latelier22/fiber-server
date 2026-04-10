// server.js

import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";

/* =========================================================
 * 1) CONFIGURATION GÉNÉRALE
 * =========================================================
 * Ici on centralise les constantes du serveur :
 * - ports HTTP / WS
 * - chemin du fichier d'état
 * - options de replay à la connexion WS
 * ========================================================= */

const PORT_HTTP = process.env.PORT_HTTP || 3030;
const PORT_WS = process.env.PORT_WS || 3031;

// Fichier JSON utilisé pour mémoriser l'état du robot
// même après redémarrage du serveur.
const STATE_FILE = process.env.STATE_FILE || path.resolve("./robot_state.json");

// Si true, à chaque connexion WS on renvoie la dernière cible connue
const REPLAY_TARGET_ON_CONNECT = false;

// Si true, à chaque connexion WS on renvoie la dernière position robot connue
const REPLAY_ROBOT_ON_CONNECT = true;

/* =========================================================
 * 2) HELPERS PERSISTENCE JSON
 * =========================================================
 * Ces fonctions lisent / écrivent l'état du robot dans un fichier.
 * Cela permet de conserver la position du robot, la cible et busy
 * même si le serveur redémarre.
 * ========================================================= */

/**
 * Charge l'état sauvegardé depuis le fichier JSON.
 * Retourne null si le fichier n'existe pas ou si la lecture échoue.
 */
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

/**
 * Sauvegarde l'état dans un fichier JSON.
 * On écrit d'abord dans un .tmp puis on renomme :
 * c'est plus sûr qu'une écriture directe.
 */
function saveState(state) {
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.log("⚠️ saveState failed:", e?.message || e);
  }
}

/* =========================================================
 * 3) ÉTAT GLOBAL EN MÉMOIRE
 * =========================================================
 * Ici on garde l'état partagé par tous les navigateurs :
 * - dernière cible demandée
 * - dernière position robot connue
 * - statut busy
 * - infos de debug télémétrie
 * ========================================================= */

let lastTarget = null; // { x, y, time }
let lastRobot = null;  // { x, y, heading, speed, time }
let busy = false;      // true = robot occupé / en mission

// Variables de debug pour voir si la télémétrie arrive bien
let robotPosCount = 0;
let lastRobotPosAt = null;
let lastRobotPosIp = null;

/**
 * Recharge l'état sauvegardé au démarrage du serveur.
 */
const boot = loadState();
if (boot) {
  lastTarget = boot.lastTarget ?? null;
  lastRobot = boot.lastRobot ?? null;
  busy = !!boot.busy;
  robotPosCount = boot.robotPosCount ?? 0;
  lastRobotPosAt = boot.lastRobotPosAt ?? null;
  lastRobotPosIp = boot.lastRobotPosIp ?? null;

  console.log("💾 State restored from", STATE_FILE, {
    busy,
    hasRobot: !!lastRobot,
    hasTarget: !!lastTarget,
  });
} else {
  console.log("💾 No state file yet:", STATE_FILE);
}

/**
 * Sauvegarde l'état courant dans le fichier JSON.
 */
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

/* =========================================================
 * 4) HELPERS MÉTIER
 * =========================================================
 * Fonctions utilitaires pour clarifier le code :
 * - mise à jour de l'état robot
 * - mise à jour cible
 * - diffusion WebSocket
 * ========================================================= */

/**
 * Met à jour la dernière position connue du robot.
 */
function updateRobotPosition({ x, y, heading = null, speed = null, time = Date.now() }) {
  lastRobot = { x, y, heading, speed, time };
  robotPosCount++;
  lastRobotPosAt = time;
}

/**
 * Met à jour la dernière cible demandée.
 */
function updateTarget({ x, y, time = Date.now() }) {
  lastTarget = { x, y, time };
}

/**
 * Remet l'état "mission" à zéro.
 */
function clearMissionState() {
  lastTarget = null;
  busy = false;
}

/* =========================================================
 * 5) INITIALISATION EXPRESS
 * ========================================================= */

const app = express();
app.use(cors());
app.use(express.json());

/* =========================================================
 * 6) GESTION DES CLIENTS WEBSOCKET
 * =========================================================
 * Le serveur WS pousse les événements aux navigateurs :
 * - robot
 * - target
 * - appel
 * - return
 * - state
 * - clear
 * ========================================================= */

const clients = new Set();

/**
 * Envoie un message à tous les clients WebSocket connectés.
 */
function broadcast(obj) {
  const data = JSON.stringify(obj);

  for (const ws of clients) {
    if (ws.readyState === 1) {
      try {
        ws.send(data);
      } catch {}
    }
  }
}

const wss = new WebSocketServer({ port: PORT_WS });

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("🛰️ WS client connecté. Total:", clients.size);

  // À la connexion, on renvoie l'état utile au client
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
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Message de présence / init client
    if (msg.type === "hello") return;

    // Réponse heartbeat
    if (msg.type === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong" }));
      } catch {}
      return;
    }

    // Déclenchement d'un appel depuis WS
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

    // Mise à jour robot depuis WS
    if (
      msg.type === "robot" &&
      msg.data &&
      typeof msg.data.x === "number" &&
      typeof msg.data.y === "number"
    ) {
      updateRobotPosition({
        x: msg.data.x,
        y: msg.data.y,
        heading: msg.data.heading ?? null,
        speed: msg.data.speed ?? null,
        time: msg.data.time ?? Date.now(),
      });

      broadcast({ type: "robot", data: lastRobot });
      persist();
      return;
    }

    // Mise à jour cible depuis WS
    if (
      msg.type === "target" &&
      msg.data &&
      typeof msg.data.x === "number" &&
      typeof msg.data.y === "number"
    ) {
      // Si le robot est busy, on refuse de changer la cible
      // (à retirer si un jour tu veux autoriser un reroutage)
      if (busy) {
        broadcast({ type: "busy", data: { busy: true } });
        return;
      }

      updateTarget({
        x: msg.data.x,
        y: msg.data.y,
        time: msg.data.time ?? Date.now(),
      });

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

/* =========================================================
 * 7) ROUTES HTTP DE DEBUG / ÉTAT
 * ========================================================= */

/**
 * État complet du serveur pour debug.
 */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    busy,
    lastTarget,
    lastRobot,
    robotPosCount,
    lastRobotPosAt,
    lastRobotPosIp,
    stateFile: STATE_FILE,
    wsClients: clients.size,
  });
});

/**
 * Dernière position robot connue.
 * Utilisé par le front pour se resynchroniser au chargement.
 */
app.get("/api/robot-last", (_req, res) => {
  if (!lastRobot) {
    return res.json({ ok: false });
  }

  res.json({ ok: true, robot: lastRobot });
});

/* =========================================================
 * 8) ROUTES HTTP MÉTIER
 * =========================================================
 * Ici on regroupe les actions métier principales :
 * - call-robot
 * - robot-pos
 * - return
 * - reset
 * - reset-target
 * ========================================================= */

/**
 * Appel robot vers une cible géographique.
 * Reçoit x=lat et y=lon.
 */
app.post("/api/call-robot", (req, res) => {
  console.log("🚑 /api/call-robot body=", req.body, "busy(before)=", busy);

  if (busy) {
    return res.status(409).json({ error: "robot_busy" });
  }

  const { x, y } = req.body || {};
  if (typeof x !== "number" || typeof y !== "number") {
    return res.status(400).json({ error: "x (lat) et y (lon) requis" });
  }

  updateTarget({ x, y });

  busy = true;

  // On informe tous les clients de la nouvelle cible
  broadcast({ type: "target", data: lastTarget });

  // On informe tous les clients que le robot est occupé
  broadcast({ type: "state", data: { busy } });

  // On déclenche l'événement d'appel
  broadcast({
    type: "appel",
    data: { t: Date.now(), source: "http-call-robot" },
  });

  persist();

  console.log("✅ call-robot OK => busy=true target=", lastTarget);
  res.json({ status: "ok", target: lastTarget, busy: true });
});

/**
 * Réception de la télémétrie robot.
 * Cette route doit être appelée régulièrement pendant le déplacement.
 */
app.post("/api/robot-pos", (req, res) => {
  const { x, y, heading = null, speed = null } = req.body || {};

  if (typeof x !== "number" || typeof y !== "number") {
    return res.status(400).json({ error: "x (lat) et y (lon) requis" });
  }

  lastRobotPosIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress;

  updateRobotPosition({
    x,
    y,
    heading,
    speed,
    time: Date.now(),
  });

  console.log(
    "🤖 /api/robot-pos",
    "count=", robotPosCount,
    "ip=", lastRobotPosIp,
    "x=", x,
    "y=", y,
    "heading=", heading,
    "speed=", speed
  );

  // On diffuse la nouvelle position à tous les clients
  broadcast({ type: "robot", data: lastRobot });

  persist();

  res.json({ status: "ok" });
});

/**
 * Demande de retour vers la base.
 * Ici le serveur n'envoie qu'un événement.
 * Le calcul Dijkstra est fait côté front si tu as ajouté le handler.
 */
app.post("/api/return", (_req, res) => {
  console.log("↩️ /api/return");

  broadcast({
    type: "return",
    data: { t: Date.now() },
  });

  res.json({ status: "ok", action: "return" });
});

/**
 * Reset complet de mission :
 * - plus de cible
 * - robot disponible
 * - on demande aux fronts de nettoyer leur état visuel
 */
app.post("/api/reset", (_req, res) => {
  clearMissionState();

  broadcast({ type: "clear" });
  broadcast({ type: "state", data: { busy } });

  persist();

  console.log("🧹 /api/reset => busy=false");
  res.json({ status: "ok" });
});

/**
 * Reset de la cible uniquement.
 * Ne change pas forcément le statut busy.
 */
app.post("/api/reset-target", (_req, res) => {
  lastTarget = null;

  broadcast({ type: "clear" });
  persist();

  console.log("🧹 /api/reset-target");
  res.json({ status: "ok" });
});

/* =========================================================
 * 9) DÉMARRAGE SERVEUR HTTP
 * ========================================================= */

app.listen(PORT_HTTP, () => {
  console.log(`✅ HTTP prêt : http://localhost:${PORT_HTTP}`);
  console.log(`✅ WS prêt   : ws://localhost:${PORT_WS}`);
  console.log(`✅ STATE_FILE: ${STATE_FILE}`);
});