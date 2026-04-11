// server.js

import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";
import * as turf from "@turf/turf";

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
 * 6bis) GRAPHE / KML
 * =========================================================
 * Objectif :
 * - lire le fichier KML UNE FOIS
 * - extraire les points (nodes)
 * - générer un graphe
 * - le mettre en cache
 * - éviter de recalculer côté navigateur
 * ========================================================= */

// Chemins
const KML_FILE = path.resolve("./public/lycee.kml");
const GRAPH_CACHE_FILE = path.resolve("./graph_cache.json");

// Graphe en mémoire
let graphCache = null;

/**
 * Charger le cache JSON si existant
 */
function loadGraphCache() {
  try {
    if (!fs.existsSync(GRAPH_CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(GRAPH_CACHE_FILE, "utf-8"));
  } catch (e) {
    console.log("⚠️ loadGraphCache failed:", e?.message || e);
    return null;
  }
}

/**
 * Sauvegarder le graphe en cache JSON
 */
function saveGraphCache(graph) {
  try {
    fs.writeFileSync(GRAPH_CACHE_FILE, JSON.stringify(graph, null, 2), "utf-8");
  } catch (e) {
    console.log("⚠️ saveGraphCache failed:", e?.message || e);
  }
}

/**
 * Génère un nom de nœud unique comme avant :
 * A, B, C, ... Z, AA, AB, etc.
 */
function nodeName(i) {
  let s = "";
  while (i >= 0) {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  }
  return s;
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function parseKml(kmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
  });

  const json = parser.parse(kmlText);
  const doc = json?.kml?.Document || json?.Document || null;

  if (!doc) {
    throw new Error("Structure KML invalide : Document introuvable");
  }

  const placemarks = [
    ...asArray(doc.Placemark),
    ...asArray(doc.Folder).flatMap((f) => asArray(f.Placemark)),
  ];

  const nodes = [];
  const obstacles = [];

  for (const p of placemarks) {
    const name = String(p?.name || "");
    const pointCoords = p?.Point?.coordinates;
    const polyCoords =
      p?.Polygon?.outerBoundaryIs?.LinearRing?.coordinates;

    // ---- Cas 1 : point => nœud de graphe
    if (pointCoords) {
      const parts = String(pointCoords).trim().split(",");
      if (parts.length >= 2) {
        const lon = Number(parts[0]);
        const lat = Number(parts[1]);

        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          nodes.push({
            id: nodeName(nodes.length),
            label: name || `Repère ${nodes.length + 1}`,
            lat,
            lon,
          });
        }
      }
    }

    // ---- Cas 2 : polygone => obstacle
    if (polyCoords) {
      const coords = String(polyCoords)
        .trim()
        .split(/\s+/)
        .map((c) => {
          const [lon, lat] = c.split(",").map(Number);
          return [lon, lat];
        })
        .filter(([lon, lat]) => Number.isFinite(lat) && Number.isFinite(lon));

      if (coords.length >= 4) {
        obstacles.push({
          name,
          coords,
        });
      }
    }
  }

  return { nodes, obstacles };
}

/**
 * Génère des liens entre tous les nœuds.
 * ATTENTION :
 * cette version est volontairement simple et ne tient
 * pas encore compte des obstacles.
 */
function buildLinks(nodes, obstacles) {
  const links = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const n1 = nodes[i];
      const n2 = nodes[j];

      const line = turf.lineString([
        [n1.lon, n1.lat],
        [n2.lon, n2.lat],
      ]);

      let blocked = false;

      for (const obs of obstacles) {
        const polygon = turf.polygon([obs.coords]);

        if (turf.lineIntersect(line, polygon).features.length > 0) {
          blocked = true;
          break;
        }
      }

      if (blocked) continue;

      const dist = turf.distance(
        [n1.lon, n1.lat],
        [n2.lon, n2.lat],
        { units: "kilometers" }
      ) * 1000;

      links.push({
        from: n1.id,
        to: n2.id,
        dist,
      });
    }
  }

  return links;
}
/**
 * Construit le graphe complet depuis le fichier KML.
 */
function buildGraphFromKml() {
  console.log("🗺️ Lecture KML depuis", KML_FILE);

  if (!fs.existsSync(KML_FILE)) {
    throw new Error(`Fichier KML introuvable : ${KML_FILE}`);
  }

  const kmlText = fs.readFileSync(KML_FILE, "utf-8");

  const { nodes, obstacles } = parseKml(kmlText);
  const links = buildLinks(nodes, obstacles);

  const originNode = nodes.find((n) => n.id === "A") || nodes[0] || null;

  console.log("✅ Graphe construit :", {
    nodes: nodes.length,
    obstacles: obstacles.length,
    links: links.length,
  });

  return {
    origin: originNode
      ? { lat: originNode.lat, lon: originNode.lon, id: originNode.id }
      : null,
    nodes,
    obstacles,
    links,
  };
}

/**
 * Initialise le graphe :
 * - charge depuis le cache si dispo
 * - sinon reconstruit depuis le KML
 */
function initGraph() {
  try {
    graphCache = loadGraphCache();

    if (graphCache) {
      console.log("⚡ Graphe chargé depuis cache");
      return;
    }

    graphCache = buildGraphFromKml();
    saveGraphCache(graphCache);

    console.log("💾 Graphe sauvegardé en cache");
  } catch (e) {
    console.log("❌ initGraph failed:", e?.message || e);
    graphCache = null;
  }
}





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


/**
 * Retourne le graphe complet
 */
app.get("/api/graph", (_req, res) => {
  if (!graphCache) {
    return res.status(503).json({ ok: false });
  }

  res.json({
    ok: true,
    graph: graphCache
  });
});


/**
 * Appel robot à partir d'une lettre de position.
 * Exemple:
 *   POST /api/call-node
 *   { "node": "C" }
 *
 * Le serveur cherche le nœud dans graphCache,
 * récupère ses coordonnées, puis déclenche un appel normal.
 */
app.post("/api/call-node", (req, res) => {
  console.log("📍 /api/call-node body=", req.body, "busy(before)=", busy);

  if (busy) {
    return res.status(409).json({ error: "robot_busy" });
  }

  // On accepte "node", "letter" ou "id"
  const rawNode = req.body?.node ?? req.body?.letter ?? req.body?.id;

  if (typeof rawNode !== "string" || !rawNode.trim()) {
    return res.status(400).json({ error: "node requis (ex: A, B, C...)" });
  }

  // Normalisation : " c " -> "C"
  const nodeId = rawNode.trim().toUpperCase();

  if (!graphCache || !Array.isArray(graphCache.nodes) || graphCache.nodes.length === 0) {
    return res.status(503).json({ error: "graph_not_ready" });
  }

  // Recherche du nœud par id logique
  const node = graphCache.nodes.find((n) => String(n.id).toUpperCase() === nodeId);

  if (!node) {
    return res.status(404).json({
      error: "node_not_found",
      node: nodeId,
    });
  }

  // Vérification coords
  if (typeof node.lat !== "number" || typeof node.lon !== "number") {
    return res.status(500).json({
      error: "node_coordinates_invalid",
      node: nodeId,
    });
  }

  // On convertit le nœud en target géographique
  updateTarget({
    x: node.lat,
    y: node.lon,
  });

  busy = true;

  // Diffusion aux clients
  broadcast({ type: "target", data: lastTarget });
  broadcast({ type: "state", data: { busy } });
  broadcast({
    type: "appel",
    data: {
      t: Date.now(),
      source: "http-call-node",
      node: nodeId,
    },
  });

  persist();

  console.log("✅ call-node OK =>", {
    node: nodeId,
    lat: node.lat,
    lon: node.lon,
    busy,
  });

  res.json({
    status: "ok",
    node: {
      id: node.id,
      label: node.label ?? null,
      lat: node.lat,
      lon: node.lon,
    },
    target: lastTarget,
    busy: true,
  });
});

// Initialisation du graphe au démarrage du serveur
initGraph();


/* =========================================================
 * 9) DÉMARRAGE SERVEUR HTTP
 * ========================================================= */

app.listen(PORT_HTTP, () => {
  console.log(`✅ HTTP prêt : http://localhost:${PORT_HTTP}`);
  console.log(`✅ WS prêt   : ws://localhost:${PORT_WS}`);
  console.log(`✅ STATE_FILE: ${STATE_FILE}`);





});