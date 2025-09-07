/**
 * good-fido: Multiplayer game server (experimental)
 * --------------------------------------
 * - Serves static assets and JSON world data over HTTP.
 * - Hosts a WebSocket hub for real-time player/NPC state.
 * - Persists lightweight state (time, players, objects, NPCs) to JSON.
 *
 * Core ideas:
 * - Game time: ticks → hours → days; season/year derived; broadcast to clients.
 * - Rooms/zones: tile-based maps; server streams deltas.
 * - Objects: defined in room JSON; live instances respawn on timers.
 * - NPCs: templated from npcs.json; optional behavior modules.
 * - Security: salted+hashed passwords; privilege-gated edits.
 *
 * Will Shaw <wsshaw@gmail.com>
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ms per tile for NPCs at rate=1
const NPC_BASE_TILE_DURATION = 320;
const crypto = require('crypto');

// --- HTTP API server for world data ---

// --- Error Handling and Logging ---

/**
 * Centralized error logging with categories and context
 */
function logError(category, error, context = {}) {
  const timestamp = new Date().toISOString();
  const errorMessage = error?.message || error || 'Unknown error';
  console.error(`[${timestamp}] ${category}:`, errorMessage, Object.keys(context).length ? context : '');
}

/**
 * Safe file write wrapper with error handling
 */
function safeFileWrite(filePath, data) {
  try {
    fs.writeFileSync(filePath, data);
    return { success: true };
  } catch (error) {
    logError('FILE_WRITE', error, { filePath });
    return { success: false, error: error.message };
  }
}

/**
 * Safe file read wrapper with error handling
 */
function safeFileRead(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return { success: true, data };
  } catch (error) {
    logError('FILE_READ', error, { filePath });
    return { success: false, error: error.message };
  }
}

// --- Timer Management for NPC Movement ---

// Track active NPC movement timers to prevent memory leaks
const npcTimers = new Map(); // instanceId -> timeoutId

/**
 * Start an NPC movement timer with cleanup tracking
 */
function startNpcMovementTimer(instanceId, callback, delay) {
  // Clear any existing timer for this NPC
  clearNpcMovementTimer(instanceId);
  
  const timerId = setTimeout(() => {
    npcTimers.delete(instanceId);
    callback();
  }, delay);
  
  npcTimers.set(instanceId, timerId);
}

/**
 * Clear NPC movement timer
 */
function clearNpcMovementTimer(instanceId) {
  const timerId = npcTimers.get(instanceId);
  if (timerId) {
    clearTimeout(timerId);
    npcTimers.delete(instanceId);
  }
}

/**
 * Clear all NPC timers (cleanup on shutdown)
 */
function clearAllNpcTimers() {
  for (const [instanceId, timerId] of npcTimers) {
    clearTimeout(timerId);
  }
  npcTimers.clear();
}

// --- Input Validation Functions ---

/**
 * Validate edit request coordinates and terrain values
 */
function validateEditRequest(msg, roomJson) {
  // Validate coordinates are integers
  if (!Number.isInteger(msg.x) || !Number.isInteger(msg.y)) {
    return { valid: false, error: 'Coordinates must be integers' };
  }
  
  // Validate coordinates are non-negative
  if (msg.x < 0 || msg.y < 0) {
    return { valid: false, error: 'Coordinates must be non-negative' };
  }
  
  // Validate coordinates are within room bounds
  if (!roomJson.tiles[msg.y] || !roomJson.tiles[msg.y][msg.x]) {
    return { valid: false, error: 'Coordinates out of room bounds' };
  }
  
  // Validate terrain string (alphanumeric, underscore, hyphen only)
  if (msg.terrain && (typeof msg.terrain !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(msg.terrain))) {
    return { valid: false, error: 'Invalid terrain value' };
  }
  
  return { valid: true };
}

/**
 * Validate room resize dimensions
 */
function validateResizeRequest(msg) {
  if (!Number.isInteger(msg.width) || !Number.isInteger(msg.height)) {
    return { valid: false, error: 'Dimensions must be integers' };
  }
  
  if (msg.width < 1 || msg.height < 1) {
    return { valid: false, error: 'Dimensions must be at least 1x1' };
  }
  
  if (msg.width > 100 || msg.height > 100) {
    return { valid: false, error: 'Dimensions too large (max 100x100)' };
  }
  
  return { valid: true };
}

/**
 * Validate and sanitize roomId to prevent path traversal
 */
function validateRoomId(roomId) {
  // Must be integer or integer string
  const parsed = parseInt(roomId, 10);
  if (isNaN(parsed) || parsed < 0) {
    return { valid: false, error: 'Invalid room ID' };
  }
  
  // Convert to string and check for path traversal attempts
  const roomIdStr = parsed.toString();
  if (roomIdStr.includes('.') || roomIdStr.includes('/') || roomIdStr.includes('\\')) {
    return { valid: false, error: 'Invalid room ID format' };
  }
  
  return { valid: true, sanitized: parsed };
}

/**
 * Validate tile exits structure
 */
function validateTileExits(tileExits) {
  if (tileExits === null || tileExits === undefined) {
    return { valid: true }; // null means delete exits
  }
  
  if (typeof tileExits !== 'object' || Array.isArray(tileExits)) {
    return { valid: false, error: 'Tile exits must be an object' };
  }
  
  const validDirections = ['up', 'down', 'left', 'right'];
  
  for (const [direction, exit] of Object.entries(tileExits)) {
    if (!validDirections.includes(direction)) {
      return { valid: false, error: `Invalid exit direction: ${direction}` };
    }
    
    if (!exit || typeof exit !== 'object') {
      return { valid: false, error: 'Exit must be an object' };
    }
    
    if (!Number.isInteger(exit.roomId) || !Number.isInteger(exit.x) || !Number.isInteger(exit.y)) {
      return { valid: false, error: 'Exit coordinates must be integers' };
    }
    
    if (exit.roomId < 0 || exit.x < 0 || exit.y < 0) {
      return { valid: false, error: 'Exit coordinates must be non-negative' };
    }
  }
  
  return { valid: true };
}

// --- Game time state ---
const stateFile = path.join(__dirname, 'state.json');
let gameTime = { tick: 0, hour: 0, day: 0 };

/** Format current in-game time into client-friendly payload. */
function getFormattedTimeMessage() {
  const year = Math.floor(gameTime.day / 360) + 1;
  const dayOfYear = gameTime.day % 360;
  let season = '❄️';
  if (dayOfYear >= 90 && dayOfYear < 180) {
    season = '🍃';
  } else if (dayOfYear >= 180 && dayOfYear < 270) {
    season = '🌞';
  } else if (dayOfYear >= 270) {
    season = '🍁';
  }

  let timeDisplay = '';
  let twelveHourFormat = gameTime.hour > 12 ? gameTime.hour - 12 : gameTime.hour;
  switch (gameTime.hour) {
    case 21:
    case 22:
    case 23:
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
      timeDisplay = '🌛 ' + twelveHourFormat + ':00';
      break;
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
    case 10:
    case 11:
      timeDisplay = '🌞 ' + twelveHourFormat + ':00';
      break;
    case 12:
      timeDisplay = '🌞 ' + twelveHourFormat + ':00';
      break;
    case 13:
    case 14:
    case 15:
    case 16:
    case 17:
      timeDisplay = '🌞 ' + twelveHourFormat + ':00';
      break;
    case 18:
    case 19:
    case 20:
      timeDisplay = '🌛 ' + twelveHourFormat + ':00';
      break;
  }
  timeDisplay += gameTime.hour >= 12 ? ' PM' : ' AM';

  return {
    type: 'time-update',
    hour: timeDisplay,
    day: gameTime.day,
    year,
    season,
  };
}

try {
  if (fs.existsSync(stateFile)) {
    const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (typeof loaded.tick === 'number') gameTime.tick = loaded.tick;
    if (typeof loaded.hour === 'number') gameTime.hour = loaded.hour;
    if (typeof loaded.day === 'number') gameTime.day = loaded.day;
    console.log(
      `Loaded game time: day ${gameTime.day}, hour ${gameTime.hour}, tick ${gameTime.tick}`
    );
  }
} catch (e) {
  console.warn('Failed to load game state:', e);
}
const express = require('express');
const app = express();
const worldDir = path.join(__dirname, 'world');

// Minimal "CSP:" static assets + WebSocket, tighten up for anything approaching production.
app.use(express.static(path.join(__dirname, '.')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Override Content Security Policy to allow our assets and WebSockets
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' data: blob: 'unsafe-inline'; " +
      "script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self' data:; " +
      "connect-src 'self' ws:;"
  );
  next();
});

// Serve all client files from the project root
app.use(express.static(path.join(__dirname)));

// REST-ish endpoints for world, zones, rooms, objects.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve the top-level world manifest
app.get('/api/world', (req, res) => {
  res.sendFile(path.join(worldDir, 'world.json'));
});

// Serve per-zone index.json (expects zones in worldDir/zones/<zoneName>/index.json)
app.get('/api/zones/:zoneName/index.json', (req, res) => {
  const zoneName = req.params.zoneName;
  res.sendFile(path.join(worldDir, 'zones', zoneName, 'index.json'));
});

// Serve individual room data files
app.get('/api/zones/:zoneName/:roomId.json', (req, res) => {
  const { zoneName, roomId } = req.params;
  res.sendFile(path.join(worldDir, 'zones', zoneName, `${roomId}.json`));
});

// Serve object data
app.get('/api/objects', (req, res) => {
  // returns an array of all loaded objects
  res.json(Object.values(objects));
});

// Create combined HTTP + WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

console.log(`Starting server.`);

const worldData = JSON.parse(fs.readFileSync(__dirname + '/world/world.json', 'utf8'));

const objectsManifestPath = path.join(__dirname, 'objects.json');
let objects = {};
if (fs.existsSync(objectsManifestPath)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(objectsManifestPath, 'utf8'));
    manifest.forEach((entry) => {
      const objFilePath = path.join(__dirname, entry.path);
      try {
        const objData = JSON.parse(fs.readFileSync(objFilePath, 'utf8'));
        objects[objData.id] = objData;
      } catch (err) {
        console.warn(`Failed to load object file ${entry.path}:`, err);
      }
    });
  } catch (err) {
    console.warn('Failed to parse objects.json:', err);
  }
} else {
  console.warn(`Object manifest not found at ${objectsManifestPath}`);
}

// --- Object state and spawn definitions ---
const objectsStatePath = path.join(__dirname, 'objects-state.json');
let objectInstances = [];
// Load existing object state if present
if (fs.existsSync(objectsStatePath)) {
  try {
    objectInstances = JSON.parse(fs.readFileSync(objectsStatePath, 'utf8'));
  } catch (e) {
    console.warn('Failed to parse objects-state.json:', e);
  }
}
// Gather spawn definitions from all room JSON files
const spawnDefs = [];
// Determine zone keys (array or object)
const zoneDefs = worldData.zones;
const zoneKeys = Array.isArray(zoneDefs)
  ? zoneDefs.map((_, idx) => idx.toString())
  : Object.keys(zoneDefs);
zoneKeys.forEach((zoneKey) => {
  const zoneDef = zoneDefs[zoneKey];
  const zonePath = typeof zoneDef === 'string' ? zoneDef : zoneDef.path;
  const zoneDir = path.join(worldDir, zonePath);
  fs.readdirSync(zoneDir).forEach((file) => {
    if (!file.endsWith('.json')) return;
    const roomFilePath = path.join(zoneDir, file);
    const roomJson = JSON.parse(fs.readFileSync(roomFilePath, 'utf8'));
    // Determine roomId: use JSON id if present, otherwise filename
    const rid =
      typeof roomJson.id === 'number' ? roomJson.id : parseInt(path.basename(file, '.json'), 10);
    if (!Array.isArray(roomJson.spawns)) return;
    roomJson.spawns.forEach((sp) => {
      spawnDefs.push({
        ...sp,
        zone: zoneKey,
        roomId: rid,
        respawnAfterSec: sp.respawnAfterSec || null,
      });
    });
  });
});
// Ensure every spawn has a live instance
spawnDefs.forEach((def) => {
  const exists = objectInstances.some(
    (i) =>
      i.typeId === def.typeId &&
      i.zone === def.zone &&
      i.roomId === def.roomId &&
      i.x === def.x &&
      i.y === def.y
  );
  if (!exists) {
    objectInstances.push({
      instanceId: crypto.randomBytes(8).toString('hex'),
      typeId: def.typeId,
      zone: def.zone,
      roomId: def.roomId,
      x: def.x,
      y: def.y,
      pickedUpBy: null,
      removedAt: null,
      respawnAfterSec: def.respawnAfterSec,
    });
  }
});

/**
 * Object lifecycle:
 * - Spawns defined in room JSON.
 * - Live instances tracked in objectInstances[].
 * - State persisted to objects-state.json across restarts.
 */
function saveObjectsState() {
  fs.writeFileSync(objectsStatePath, JSON.stringify(objectInstances, null, 2));
}
saveObjectsState();

/**
 * NPC Model
 * - Templates: from npcs.json, may link to behaviorModule.
 * - Instances: created per room’s npcs[] array.
 * - Behavior: optional { onTick, getContextMenu, onContextAction }.
 * - Movement: server picks random paths; clients animate.
 */
const npcsManifestPath = path.join(__dirname, 'npcs.json');
let npcTemplates = [];
try {
  if (fs.existsSync(npcsManifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(npcsManifestPath, 'utf8'));
    for (const entry of manifest) {
      const npcData = JSON.parse(fs.readFileSync(path.join(__dirname, entry.path), 'utf8'));
      // Load custom behavior module if specified
      if (npcData.behaviorModule) {
        try {
          const behaviorPath = path.join(__dirname, npcData.behaviorModule);
          npcData.behavior = require(behaviorPath);
        } catch (err) {
          console.warn(`Failed to load behavior module for NPC ${npcData.name}:`, err);
        }
      }
      npcTemplates.push(npcData);
    }
    // Diagnostic logging after loading npcTemplates
    console.log(
      'NPC templates loaded:',
      npcTemplates.map((t) => t.name || t.id)
    );
    if (npcTemplates.length === 0) {
      console.warn(
        '⚠️ No NPC templates found. Check that npcs.json and template paths are correct.'
      );
    }
  }
} catch (err) {
  console.warn('Failed to load NPC templates:', err);
}
const npcStatePath = path.join(__dirname, 'npcs-state.json');
let npcInstances = [];

// Attempt to load existing state; fall back to regeneration on missing/invalid JSON
let rawNpcState = null;
if (fs.existsSync(npcStatePath)) {
  try {
    rawNpcState = JSON.parse(fs.readFileSync(npcStatePath, 'utf8'));
  } catch (e) {
    console.warn('Failed to parse npcs-state.json, regenerating NPC state:', e);
  }
}

if (Array.isArray(rawNpcState) && rawNpcState.length > 0) {
  npcInstances = rawNpcState;
} else {
  // regenerate NPC instances from room definitions
  const zoneDefs = worldData.zones;
  const zoneKeys = Array.isArray(zoneDefs)
    ? zoneDefs.map((_, idx) => idx.toString())
    : Object.keys(zoneDefs);
  // Diagnostic logging after computing zoneKeys
  console.log('Regenerating NPC instances. zoneKeys:', zoneKeys);

  zoneKeys.forEach((zoneKey) => {
    const zoneDef = zoneDefs[zoneKey];
    const zonePath = typeof zoneDef === 'string' ? zoneDef : zoneDef.path;
    const zoneDir = path.join(worldDir, zonePath);
    // Diagnostic logging at start of each zone iteration
    console.log(`Scanning zone ${zoneKey} directory:`, zoneDir);

    fs.readdirSync(zoneDir).forEach((file) => {
      if (!file.endsWith('.json')) return;
      const roomFile = path.join(zoneDir, file);
      const roomJson = JSON.parse(fs.readFileSync(roomFile, 'utf8'));
      // Diagnostic logging before checking roomJson.npcs
      console.log(`Reading room file: ${roomFile}`);
      console.log('Room JSON npc definitions:', roomJson.npcs);
      const rid =
        typeof roomJson.id === 'number' ? roomJson.id : parseInt(path.basename(file, '.json'), 10);

      if (Array.isArray(roomJson.npcs)) {
        roomJson.npcs.forEach((def) => {
          const template = npcTemplates.find((t) => t.id === def.typeId);
          if (template) {
            npcInstances.push({
              instanceId: crypto.randomBytes(8).toString('hex'),
              typeId: template.id,
              name: template.name,
              sprite: template.sprite,
              zone: zoneKey,
              roomId: rid,
              x: def.x,
              y: def.y,
              roam: template.roam || null,
              lastRoamTick: 0,
            });
          }
        });
      }
    });
  });

  // persist the freshly generated state
  saveNpcState();
}
// Ensure movement state fields exist on each NPC
npcInstances.forEach((npc) => {
  if (!('movePath' in npc)) npc.movePath = null;
  if (!('moveStartTick' in npc)) npc.moveStartTick = 0;
  if (!('moveDuration' in npc)) npc.moveDuration = 0;
  // Attach behavior module from template, if any
  const tmpl = npcTemplates.find((t) => t.id === npc.typeId);
  npc.behavior = tmpl && tmpl.behavior ? tmpl.behavior : null;
});
// Persist NPCs
function saveNpcState() {
  fs.writeFileSync(npcStatePath, JSON.stringify(npcInstances, null, 2));
}
// Helper to broadcast NPC movement
function broadcastNpcMovement(npc) {
  broadcastToRoom(npc.zone, npc.roomId, {
    type: 'npc-move',
    npc,
  });
}

// Pick a random passable tile in the room
function pickRandomTile(roomDef, passableOnly = true) {
  const coords = [];
  for (let y = 0; y < roomDef.tiles.length; y++) {
    for (let x = 0; x < roomDef.tiles[y].length; x++) {
      // TODO: apply passability checks based on terrain and tileExits
      coords.push({ x, y });
    }
  }
  return coords[Math.floor(Math.random() * coords.length)];
}

/**
 * Breadth-first search pathfinder on a grid.
 * @param {[number,number]} start
 * @param {[number,number]} end
 * @param {Array<Array<{terrain:string}>>} tiles
 * @param {Object} tileExits    (ignored for now)
 * @returns {Array<[number,number]>|null}
 */
function findPath(start, end, tiles, tileExits) {
  const rows = tiles.length;
  const cols = tiles[0].length;
  const key = ([x, y]) => `${x},${y}`;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const visited = new Set([key(start)]);
  const queue = [[start]];

  while (queue.length) {
    const path = queue.shift();
    const [x, y] = path[path.length - 1];
    if (x === end[0] && y === end[1]) return path;
    for (const [dx, dy] of dirs) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const k2 = `${nx},${ny}`;
      if (visited.has(k2)) continue;
      const tile = tiles[ny][nx];
      if (tile.terrain === 'void') continue;
      visited.add(k2);
      queue.push(path.concat([[nx, ny]]));
    }
  }
  return null;
}

/** Send to all players in a room. */
function broadcastToRoom(zone, roomId, msg) {
  const data = JSON.stringify(msg);
  for (const [otherId, client] of clients) {
    const pos = positions.get(otherId);
    if (pos && pos.zone === zone && pos.roomId === roomId && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/**
 * Send a message to a single player by id.
 * @param {number} playerId
 * @param {Object} msg
 */
function sendToPlayer(playerId, msg) {
  const ws = clients.get(playerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Broadcast a message only to clients within a tile-radius of a center point.
 * @param {string} zone       – zone key
 * @param {number} roomId     – room number
 * @param {number} centerX    – X tile coordinate of the origin
 * @param {number} centerY    – Y tile coordinate of the origin
 * @param {number} radius     – tile radius (1 ⇒ 3×3 square)
 * @param {Object} msg        – message object to send
 */
function broadcastToProximity(zone, roomId, centerX, centerY, radius, msg) {
  const data = JSON.stringify(msg);
  for (const [otherId, client] of clients) {
    const pos = positions.get(otherId);
    if (pos && pos.zone === zone && pos.roomId === roomId && client.readyState === WebSocket.OPEN) {
      const dx = Math.abs(pos.x - centerX);
      const dy = Math.abs(pos.y - centerY);
      if (dx <= radius && dy <= radius) {
        client.send(data);
      }
    }
  }
}
const playerDir = path.join(__dirname, 'players');
fs.mkdirSync(playerDir, { recursive: true });

let clientId = 0;
const clients = new Map();
const positions = new Map();
const colors = ['red', 'green', 'blue', 'orange', 'purple', 'yellow'];
const nameMap = new Map(); // id -> name

/** Validate inbound player JSON. */
function isValidPlayerData(data) {
  return (
    data &&
    typeof data.x === 'number' &&
    typeof data.y === 'number' &&
    typeof data.roomX === 'number' &&
    typeof data.roomY === 'number' &&
    typeof data.color === 'string' &&
    typeof data.name === 'string' &&
    Array.isArray(data.inventory)
  );
}

/** Write player record to /players/<name>.json. */
function savePlayerData(data) {
  const playerFile = path.join(playerDir, `${data.name}.json`);
  const safeData = {
    name: data.name,
    x: data.x,
    y: data.y,
    roomId: data.roomId,
    color: data.color,
    inventory: data.inventory,
    privilege: data.privilege,
    salt: data.salt,
    hash: data.hash,
  };
  fs.writeFileSync(playerFile, JSON.stringify(safeData, null, 2));
}

/** Hash password with PBKDF2-SHA512 + random salt. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

/** Verify password against salt+hash. */
function verifyPassword(password, salt, hash) {
  const hashed = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === hashed;
}

/**
 * First message must be { name, password, create }.
 * - Auth or character creation.
 * - On success: init payload (players, time, objects, NPCs).
 * - Later messages: { type, ... } envelopes (update, pickup, etc.).
 */
wss.on('connection', (ws) => {
  // --- Client→Server message router ---
  ws.once('message', async (nameMsg) => {
    let parsed;
    try {
      parsed = JSON.parse(nameMsg);
    } catch (e) {
      ws.close();
      return;
    }
    const { name, password, create } = parsed;
    if (!name || !password) {
      ws.close();
      return;
    }

    const id = clientId++;
    const color = colors[id % colors.length];
    nameMap.set(id, name);
    clients.set(id, ws);

    const playerFile = path.join(playerDir, `${name}.json`);
    let initialPos = {
      name,
      x: 400,
      y: 300,
      roomId: 0,
      color,
      privilege: 0,
      inventory: [],
    };

    try {
      if (fs.existsSync(playerFile)) {
        const data = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
        if (!data.salt || !data.hash) {
          console.warn(`No password data for ${name}.`);
          ws.send(JSON.stringify({ type: 'error', message: 'Missing password data.' }));
          ws.close();
          return;
        }
        if (create) {
          ws.send(JSON.stringify({ type: 'error', message: 'Character already exists.' }));
          ws.close();
          return;
        }
        if (!verifyPassword(password, data.salt, data.hash)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Incorrect password.' }));
          ws.close();
          return;
        }
        // Fill in any valid fields from data, even if isValidPlayerData fails
        if (typeof data.x === 'number') initialPos.x = data.x;
        if (typeof data.y === 'number') initialPos.y = data.y;
        if (typeof data.roomId === 'number') initialPos.roomId = data.roomId;
        if (typeof data.color === 'string') initialPos.color = data.color;
        if (typeof data.privilege === 'number') initialPos.privilege = data.privilege;
        if (Array.isArray(data.inventory)) initialPos.inventory = data.inventory;
        initialPos.salt = data.salt;
        initialPos.hash = data.hash;
      } else {
        console.log(`Creating new character "${name}" (create=${create})`);
        const { salt, hash } = hashPassword(password);
        initialPos.salt = salt;
        initialPos.hash = hash;

        if (create) {
          console.log(`Writing new player file to: ${playerFile}`);
          savePlayerData(initialPos);
        }
        if (!create) {
          ws.send(JSON.stringify({ type: 'error', message: 'Character not found.' }));
          ws.close();
          return;
        }
      }
    } catch (e) {
      console.warn(`Failed to load player data for ${name}:`, e);
    }
    // Determine default zone key for single-zone use
    const defaultZone = Array.isArray(worldData.zones) ? '0' : Object.keys(worldData.zones)[0];
    positions.set(id, {
      name: initialPos.name,
      x: initialPos.x,
      y: initialPos.y,
      roomX: initialPos.roomX,
      roomY: initialPos.roomY,
      roomId: initialPos.roomId,
      privilege: initialPos.privilege,
      color: initialPos.color,
      inventory: initialPos.inventory,
      salt: initialPos.salt,
      hash: initialPos.hash,
      zone: defaultZone,
    });
    console.log(`Client ${id} (${name}) connected.`);

    ws.send(
      JSON.stringify({
        type: 'init',
        id,
        players: Object.fromEntries(positions),
        world: worldData.rooms,
        x: initialPos.x,
        y: initialPos.y,
        roomId: 0,
        privilege: 10,
      })
    );

    // Immediately send current game time to client
    ws.send(JSON.stringify(getFormattedTimeMessage()));

    // Send initial objects for this room
    const myZone = positions.get(id).zone;
    const initObjects = objectInstances.filter(
      (i) => i.zone === myZone && i.roomId === initialPos.roomId && i.pickedUpBy === null
    );
    console.log(`${JSON.stringify(initObjects)}`);
    ws.send(JSON.stringify({ type: 'init-objects', objects: initObjects }));

    // Send initial inventory for this player (by name)
    const initInventory = objectInstances.filter((inst) => inst.pickedUpBy === name);
    ws.send(JSON.stringify({ type: 'init-inventory', inventory: initInventory }));

    // Send initial NPCs in this room
    const initNpcs = npcInstances.filter(
      (n) => n.zone === myZone && n.roomId === initialPos.roomId
    );
    ws.send(JSON.stringify({ type: 'init-npcs', npcs: initNpcs }));

    for (let [otherId, client] of clients) {
      if (otherId !== id && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'join', id, pos: initialPos }));
      }
    }

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        // --- Updated 'update' handler using top-level fields ---
        if (msg.type === 'update') {
          // Update authoritative position, then broadcast.
          const player = positions.get(id);
          if (player) {
            player.x = msg.x;
            player.y = msg.y;
            player.roomId = msg.roomId;
          }
          // Broadcast to other clients with flat structure
          for (let [otherId, client] of clients) {
            if (otherId !== id && client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'update',
                  id,
                  x: player.x,
                  y: player.y,
                  roomId: player.roomId,
                  name: player.name,
                  privilege: player.privilege,
                })
              );
            }
          }
        }
        // Claim object instance; mark removal tick.
        else if (msg.type === 'pickup') {
          const zoneKey = msg.zone.toString();
          const roomNum = msg.roomId;
          console.log(
            `Received pickup request from player ${id} for instance ${msg.instanceId} in zone ${zoneKey}, room ${roomNum}`
          );
          const inst = objectInstances.find((i) => i.instanceId === msg.instanceId);
          if (
            inst &&
            inst.pickedUpBy === null &&
            inst.zone === zoneKey &&
            inst.roomId === roomNum
          ) {
            inst.pickedUpBy = name;
            inst.removedAt = gameTime.tick;
            saveObjectsState();
            console.log(`Object ${inst.instanceId} now picked by player ${name}`);
            broadcastToRoom(zoneKey, inst.roomId, {
              type: 'object-picked',
              instance: inst,
              playerId: id,
            });
          }
        }
        // Materialize item back into room; persist.
        else if (msg.type === 'drop') {
          const zoneKey = msg.zone.toString();
          const inst = objectInstances.find((i) => i.instanceId === msg.instanceId);
          if (inst && inst.pickedUpBy === name) {
            inst.pickedUpBy = null;
            inst.removedAt = null;
            inst.x = msg.x;
            inst.y = msg.y;
            inst.zone = zoneKey;
            inst.roomId = msg.roomId;
            saveObjectsState();
            broadcastToRoom(zoneKey, inst.roomId, {
              type: 'object-dropped',
              instance: inst,
            });
            // Persist updated inventory to player file
            const playerData = positions.get(id);
            playerData.inventory = objectInstances.filter((i) => i.pickedUpBy === name);
            savePlayerData(playerData);
          }
        } else if (msg.type === 'request-objects-and-npcs') {
          // Refresh visible objects + NPCs for a room.
          const zoneKey = msg.zone.toString();
          const list = objectInstances.filter(
            (i) => i.zone === zoneKey && i.roomId === msg.roomId && i.pickedUpBy === null
          );
          ws.send(JSON.stringify({ type: 'init-objects', objects: list }));
          // Send NPCs for this room as well
          const initNpcs = npcInstances.filter(
            (n) => n.zone === zoneKey && n.roomId === msg.roomId
          );
          ws.send(JSON.stringify({ type: 'init-npcs', npcs: initNpcs }));
        }
        // Ask behavior module for context options.
        else if (msg.type === 'get-context-menu') {
          const player = positions.get(id);
          const { targetType, instanceId } = msg;

          if (!player || !targetType || !instanceId) return;

          let entity = null;
          if (targetType === 'npc') {
            entity = npcInstances.find((n) => n.instanceId === instanceId);
          } else if (targetType === 'object') {
            entity = objectInstances.find((o) => o.instanceId === instanceId);
          }

          if (!entity || !entity.behavior || typeof entity.behavior.getContextMenu !== 'function') {
            ws.send(JSON.stringify({ type: 'context-menu', instanceId, options: [] }));
            return;
          }
          const options = entity.behavior.getContextMenu(entity, player, {
            playersInRoom: (z, r) =>
              Array.from(positions.values()).filter((p) => p.zone === z && p.roomId === r),
          });
          ws.send(JSON.stringify({ type: 'context-menu', instanceId, targetType, options }));
        }
        // Invoke behavior’s onContextAction handler.
        else if (msg.type === 'context-action') {
          console.log("It's nothing, really." + JSON.stringify(msg));
          const rawPlayer = positions.get(id);
          const player = { id, ...rawPlayer };
          const { targetType, instanceId, action } = msg;

          if (!player || !targetType || !instanceId || !action) return;

          // Server-side scaffolding for NPC context actions
          if (targetType === 'npc') {
            if (action === 'examine') {
              console.log(`Player ${player.name} examines NPC ${instanceId}`);
              // TODO: implement server-side examine logic
            } else if (action === 'talk') {
              console.log(`Player ${player.name} talks to NPC ${instanceId}`);
              // TODO: implement server-side talk logic
            }
          }

          let entity = null;
          if (targetType === 'npc') {
            entity = npcInstances.find((n) => n.instanceId === instanceId);
          } else if (targetType === 'object') {
            entity = objectInstances.find((o) => o.instanceId === instanceId);
          }

          if (!entity || !entity.behavior || typeof entity.behavior.onContextAction !== 'function')
            return;

          const gameState = {
            playersInRoom: (zone, roomId) =>
              Array.from(positions.entries())
                .filter(([pid, p]) => p.zone === zone && p.roomId === roomId)
                .map(([pid, p]) => ({ id: pid, ...p })),
            broadcastToRoom,
            sendToPlayer,
          };
          entity.behavior.onContextAction(action, entity, player, gameState);
        } else if (msg.type === 'edit-tile') {
          // Privileged: update terrain and broadcast patch.
          const player = positions.get(id);
          if (!player || player.privilege < 10) {
            ws.send(JSON.stringify({ type: 'error', message: 'Insufficient privileges' }));
            return;
          }
          
          // Validate roomId
          const roomIdValidation = validateRoomId(msg.roomId);
          if (!roomIdValidation.valid) {
            ws.send(JSON.stringify({ type: 'error', message: roomIdValidation.error }));
            return;
          }
          const roomId = roomIdValidation.sanitized;
          
          // Load the room JSON file
          const zoneId = msg.zoneId !== undefined ? msg.zoneId : 0;
          const zoneDef = worldData.zones[zoneId];
          if (!zoneDef) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown zone' }));
            return;
          }
          const roomFile = path.join(worldDir, zoneDef.path, `${roomId}.json`);
          let roomJson;
          try {
            roomJson = JSON.parse(fs.readFileSync(roomFile, 'utf8'));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to load room data' }));
            return;
          }
          
          // Validate edit request
          const validation = validateEditRequest(msg, roomJson);
          if (!validation.valid) {
            ws.send(JSON.stringify({ type: 'error', message: validation.error }));
            return;
          }
          
          // Apply the terrain change
          roomJson.tiles[msg.y][msg.x].terrain = msg.terrain;
          // Persist back to disk with error handling
          const writeResult = safeFileWrite(roomFile, JSON.stringify(roomJson, null, 2));
          if (!writeResult.success) {
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to save room changes' }));
            return;
          }
          // Broadcast the edit to all clients
          for (const client of clients.values()) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'room-updated',
                  roomId,
                  patch: msg,
                })
              );
            }
          }
        } else if (msg.type === 'edit-tile-exits') {
          // Privileged: update/remove tileExits.
          console.log('received tile exits data update.');
          const player = positions.get(id);
          // Only allow privilege ≥ 10
          if (!player || player.privilege < 10) {
            ws.send(JSON.stringify({ type: 'error', message: 'Insufficient privileges' }));
            return;
          }
          
          // Validate roomId
          const roomIdValidation = validateRoomId(msg.roomId);
          if (!roomIdValidation.valid) {
            ws.send(JSON.stringify({ type: 'error', message: roomIdValidation.error }));
            return;
          }
          const roomId = roomIdValidation.sanitized;
          
          // Validate tile exits structure
          const exitsValidation = validateTileExits(msg.tileExits);
          if (!exitsValidation.valid) {
            ws.send(JSON.stringify({ type: 'error', message: exitsValidation.error }));
            return;
          }
          
          const zoneId = msg.zoneId !== undefined ? msg.zoneId : 0;
          const zoneDef = worldData.zones[zoneId];
          if (!zoneDef) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown zone' }));
            return;
          }
          const roomFile = path.join(worldDir, zoneDef.path, `${roomId}.json`);
          console.log('[edit-tile-exits] writing to:', roomFile);
          let roomJson;
          try {
            roomJson = JSON.parse(fs.readFileSync(roomFile, 'utf8'));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to load room data' }));
            return;
          }
          
          // Validate coordinates using existing function
          const coordValidation = validateEditRequest(msg, roomJson);
          if (!coordValidation.valid) {
            ws.send(JSON.stringify({ type: 'error', message: coordValidation.error }));
            return;
          }
          
          // Apply tileExits update (null means delete)
          if (msg.tileExits === null) {
            delete roomJson.tiles[msg.y][msg.x].tileExits;
          } else {
            roomJson.tiles[msg.y][msg.x].tileExits = msg.tileExits;
          }
          // Persist back to disk with error handling
          const writeResult = safeFileWrite(roomFile, JSON.stringify(roomJson, null, 2));
          if (!writeResult.success) {
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to save tile exits' }));
            return;
          }
          // Broadcast the edit to all clients
          for (const client of clients.values()) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'room-updated',
                  roomId,
                  patch: msg,
                })
              );
            }
          }
        }
        // --- Handle privileged room resize ---
        else if (msg.type === 'resize-room') {
          // Privileged: grow/shrink room dimensions.
          const player = positions.get(id);
          // Only allow privilege >= 10
          if (!player || player.privilege < 10) {
            ws.send(JSON.stringify({ type: 'error', message: 'Insufficient privileges' }));
            return;
          }
          
          // Validate roomId
          const roomIdValidation = validateRoomId(msg.roomId);
          if (!roomIdValidation.valid) {
            ws.send(JSON.stringify({ type: 'error', message: roomIdValidation.error }));
            return;
          }
          const roomId = roomIdValidation.sanitized;
          
          // Validate resize dimensions
          const resizeValidation = validateResizeRequest(msg);
          if (!resizeValidation.valid) {
            ws.send(JSON.stringify({ type: 'error', message: resizeValidation.error }));
            return;
          }
          
          const newW = msg.width;
          const newH = msg.height;
          const zoneId = msg.zoneId !== undefined ? msg.zoneId : 0;
          const zoneDef = worldData.zones[zoneId];
          if (!zoneDef) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown zone' }));
            return;
          }
          const roomFile = path.join(worldDir, zoneDef.path, `${roomId}.json`);
          let roomJson;
          try {
            roomJson = JSON.parse(fs.readFileSync(roomFile, 'utf8'));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to load room data' }));
            return;
          }
          const oldW = roomJson.width;
          const oldH = roomJson.height;
          // Resize each existing row
          for (let y = 0; y < roomJson.tiles.length; y++) {
            const row = roomJson.tiles[y];
            if (newW > oldW) {
              for (let x = oldW; x < newW; x++) {
                row.push({ terrain: 'void', tileExits: {} });
              }
            } else if (newW < oldW) {
              row.length = newW;
            }
          }
          // Adjust number of rows
          if (newH > oldH) {
            for (let y = oldH; y < newH; y++) {
              const newRow = [];
              for (let x = 0; x < newW; x++) {
                newRow.push({ terrain: 'void', tileExits: {} });
              }
              roomJson.tiles.push(newRow);
            }
          } else if (newH < oldH) {
            roomJson.tiles.length = newH;
          }
          // Update metadata
          roomJson.width = newW;
          roomJson.height = newH;
          // Persist back to disk with error handling
          const writeResult = safeFileWrite(roomFile, JSON.stringify(roomJson, null, 2));
          if (!writeResult.success) {
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to save room resize' }));
            return;
          }
          // Broadcast the resize to all clients
          for (const client of clients.values()) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'room-resized',
                  roomId,
                  width: newW,
                  height: newH,
                })
              );
            }
          }
        }
      } catch (e) {
        logError('MESSAGE_PARSE', e, { 
          clientId: id, 
          playerName: nameMap.get(id),
          rawMessage: message.toString().substring(0, 200) // First 200 chars for debugging
        });
        // Send error response to client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Invalid message format' 
          }));
        }
      }
    });

    ws.on('close', () => {
      // Clean up any NPC timers for this player (if they were controlling NPCs)
      // Note: This is more for safety - in practice NPCs are server-controlled
      
      // Persist player snapshot + notify others.
      const data = positions.get(id);
      if (data) {
        try {
          savePlayerData(data);
        } catch (err) {
          logError('PLAYER_SAVE', err, { playerId: id, playerName: data.name });
        }
      }
      clients.delete(id);
      positions.delete(id);
      nameMap.delete(id);
      for (let client of clients.values()) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'leave', id }));
        }
      }
      console.log(`Client ${id} (${name}) disconnected.`);
    });
  });
});

/** Broadcast or unicast (id) wrapper around ws.send. */
function sendMessage(target, data) {
  const message = JSON.stringify(data);
  console.log(`message to send: ${message}`);
  if (typeof target === 'number') {
    const ws = clients.get(target);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  } else {
    for (const ws of clients.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}
/** Lookup player by name in memory. */
function getPlayerByName(name) {
  for (const [id, data] of positions.entries()) {
    if (data.name === name) return data;
  }
  return null;
}

// Start combined HTTP + WebSocket server
const port = process.env.PORT || 8081;
server.listen(port, () => {
  console.log(`HTTP + WebSocket server listening on port ${port}`);
});

/**
 * Main server tick (1 Hz)
 * - Advance ticks -> hours -> days.
 * - Persist time every minute.
 * - Broadcast hourly updates.
 * - Run object respawn cycle.
 * - Trigger NPC roaming.
 * - Call npc.behavior.onTick()
 */
setInterval(() => {
  gameTime.tick++;

  if (gameTime.tick % 60 === 0) {
    gameTime.hour++;
    console.log(`Hour ${gameTime.hour} begins.`);
    // --- Timekeeping ---
    if (gameTime.hour % 24 === 0) {
      gameTime.day++;
      gameTime.hour = 0;
      console.log(`Day ${gameTime.day} begins.`);
    }

    // Calculate season and year
    const year = Math.floor(gameTime.day / 360) + 1;
    const dayOfYear = gameTime.day % 360;
    let season = 'Winter';
    if (dayOfYear >= 90 && dayOfYear < 180) {
      season = 'Spring';
    } else if (dayOfYear >= 180 && dayOfYear < 270) {
      season = 'Summer';
    } else if (dayOfYear >= 270) {
      season = 'Fall';
    }

    // Broadcast time update
    sendMessage(null, getFormattedTimeMessage());
  }

  // Save to disk every minute
  if (gameTime.tick % 60 === 0) {
    fs.writeFile(stateFile, JSON.stringify(gameTime, null, 2), (err) => {
      if (err) console.error('Failed to save game time:', err);
    });
  }

  // --- Object respawn cycle ---
  objectInstances.forEach((inst) => {
    if (inst.pickedUpBy !== null && inst.respawnAfterSec && inst.removedAt) {
      const elapsed = gameTime.tick - inst.removedAt;
      if (elapsed >= inst.respawnAfterSec) {
        inst.pickedUpBy = null;
        inst.removedAt = null;
        saveObjectsState();
        broadcastToRoom(inst.zone, inst.roomId, {
          type: 'object-spawned',
          instance: inst,
        });
      }
    }
  });

  // --- NPC roaming around ---
  npcInstances.forEach((npc) => {
    const roam = npc.roam;
    if (!roam || roam.type !== 'random') return;

    // If already en route, let clients handle the walk
    if (npc.movePath) return;

    // Decide whether to start a new random move
    const randRoll = Math.random() * 100;
    if (randRoll < roam.frequency) {
      // Load room definition
      const zoneDef = worldData.zones[npc.zone];
      const roomFile = `${worldDir}/${zoneDef.path}/${npc.roomId}.json`;
      const roomDef = JSON.parse(fs.readFileSync(roomFile, 'utf8'));

      // Pick a random reachable tile and compute path
      const target = pickRandomTile(roomDef, true);
      const path = findPath([npc.x, npc.y], [target.x, target.y], roomDef.tiles, roomDef.tileExits);
      //console.log(`NPC ${npc.instanceId} selected target ${target.x},${target.y}, path:`, path);
      if (path && path.length > 1) {
        // Compute path length in tiles (edges)
        const pathLen = path.length - 1;
        const minLen = roam.minDuration;
        const maxLen = roam.maxDuration;
        const rate = roam.rate || 1;

        // Only start if within the configured min/max tiles
        if (pathLen >= minLen && pathLen <= maxLen) {
          // ms per tile adjusted by rate
          const segmentDuration = Math.floor(NPC_BASE_TILE_DURATION / rate);
          //console.log(`NPC ${npc.instanceId} roaming ${pathLen} tiles at rate=${rate}, segmentDuration=${segmentDuration}`);

          // Broadcast the full path to clients
          //console.log(`Broadcasting npc-start-path for ${npc.instanceId}`);
          broadcastToRoom(npc.zone, npc.roomId, {
            type: 'npc-start-path',
            instanceId: npc.instanceId,
            path,
            segmentDuration,
          });
          const totalTiles = path.length - 1;
          const totalMs = totalTiles * segmentDuration;

          // Use managed timer to prevent memory leaks
          startNpcMovementTimer(npc.instanceId, () => {
            // update official position
            const [tx, ty] = path[path.length - 1];
            npc.x = tx;
            npc.y = ty;
            saveNpcState();

            // inform any late-joining clients
            broadcastToRoom(npc.zone, npc.roomId, {
              type: 'npc-move',
              npc,
            });
          }, totalMs);
        }
      }
    }
  });

  // --- NPC custom behavior hooks (for javascript code in /scripts/) ---
  npcInstances.forEach((npc) => {
    if (npc.behavior && typeof npc.behavior.onTick === 'function') {
      try {
        const gameState = {
          playersInRoom: (zone, roomId) =>
            Array.from(positions.entries())
              .filter(([pid, p]) => p.zone === zone && p.roomId === roomId)
              .map(([pid, p]) => ({ id: pid, ...p })),
          broadcastToRoom,
          sendToPlayer,
        };
        npc.behavior.onTick(npc, gameState);
      } catch (err) {
        console.error(`Error in onTick for NPC ${npc.instanceId}:`, err);
      }
    }
  });
}, 1000);

// --- Graceful Shutdown Handling ---

/**
 * Clean shutdown procedure
 */
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
  
  // Clear all NPC movement timers to prevent memory leaks
  clearAllNpcTimers();
  
  // Close WebSocket server
  wss.close((err) => {
    if (err) {
      logError('SHUTDOWN', err, { phase: 'websocket_close' });
    } else {
      console.log('WebSocket server closed.');
    }
  });
  
  // Close HTTP server
  server.close((err) => {
    if (err) {
      logError('SHUTDOWN', err, { phase: 'http_close' });
    } else {
      console.log('HTTP server closed.');
    }
    
    // Save final state
    try {
      console.log('Saving final game state...');
      fs.writeFileSync(stateFile, JSON.stringify(gameTime, null, 2));
      console.log('Game state saved successfully.');
    } catch (error) {
      logError('SHUTDOWN', error, { phase: 'final_state_save' });
    }
    
    console.log('Graceful shutdown complete.');
    process.exit(0);
  });
  
  // Force exit after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error('Forceful shutdown after timeout');
    process.exit(1);
  }, 10000);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logError('UNCAUGHT_EXCEPTION', error, { fatal: true });
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  logError('UNHANDLED_REJECTION', reason, { promise: promise.toString() });
});

// End of server.js
