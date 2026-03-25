const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const ROOM_CODE_LENGTH = 6;
const ROOM_TTL_MS = 1000 * 60 * 60 * 4;
const MAX_MESSAGE_SIZE = 16 * 1024;
const CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_PSEUDO = 'JOUEUR';
const DEFAULT_CHARACTER = 'ryder';
const DEFAULT_MODE = 'coop2';
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ALLOWED_MODES = new Map([
  ['coop2', 2],
  ['coop3', 3],
  ['coop4', 4],
  ['1v1', 2],
  ['1v2', 3],
  ['2v2', 4],
  ['1v4', 5],
]);

const rooms = new Map();
const clients = new Map();

const server = http.createServer((req, res) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
  };

  if (req.url === '/health') {
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size }));
    return;
  }

  res.writeHead(200, {
    ...headers,
    'Content-Type': 'text/plain',
  });
  res.end('Bandana Fighters WebSocket server is running.');
});

const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_MESSAGE_SIZE,
});

function now() {
  return Date.now();
}

function randomId(length = 12) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

function randomInt(max) {
  return crypto.randomInt(0, max);
}

function randomRoomCode() {
  let out = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    out += ROOM_CODE_CHARS[randomInt(ROOM_CODE_CHARS.length)];
  }
  return out;
}

function createUniqueRoomCode() {
  let code = randomRoomCode();
  while (rooms.has(code)) code = randomRoomCode();
  return code;
}

function sanitizeString(value, fallback, maxLength = 24) {
  if (typeof value !== 'string') return fallback;
  const sanitized = value.trim().slice(0, maxLength);
  return sanitized || fallback;
}

function sanitizeMode(mode) {
  return ALLOWED_MODES.has(mode) ? mode : DEFAULT_MODE;
}

function getModePlayerLimit(mode) {
  return ALLOWED_MODES.get(mode) || ALLOWED_MODES.get(DEFAULT_MODE);
}

function getRoomByClient(client) {
  return client.roomCode ? rooms.get(client.roomCode) : null;
}

function buildRoomSnapshot(room, type) {
  return {
    t: type,
    code: room.code,
    mode: room.mode,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    players: roomPlayerList(room),
  };
}

function roomPlayerList(room) {
  let slot = 0;
  return Array.from(room.players.values(), (player) => {
    slot += 1;
    return {
      id: player.id,
      pseudo: player.pseudo,
      character: player.character,
      ready: player.ready,
      slot,
      isHost: player.id === room.hostId,
    };
  });
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function broadcastRoom(room, payload, exceptClientId = null) {
  for (const player of room.players.values()) {
    if (player.id === exceptClientId) continue;
    safeSend(player.ws, payload);
  }
}

function updateRoomTimestamp(room) {
  room.updatedAt = now();
}

function attachPlayerToRoom(room, client, payload = {}) {
  room.players.set(client.id, {
    id: client.id,
    ws: client.ws,
    pseudo: sanitizeString(payload.pseudo, DEFAULT_PSEUDO),
    character: sanitizeString(payload.character, DEFAULT_CHARACTER),
    ready: false,
    joinedAt: now(),
    lastState: null,
  });

  client.roomCode = room.code;
}

function createRoom(client, payload = {}) {
  if (client.roomCode) leaveRoom(client, 'switch_room');

  const mode = sanitizeMode(payload.mode);
  const roomCode = createUniqueRoomCode();
  const createdAt = now();
  const room = {
    code: roomCode,
    mode,
    maxPlayers: getModePlayerLimit(mode),
    hostId: client.id,
    players: new Map(),
    createdAt,
    updatedAt: createdAt,
    gameState: {
      started: false,
      seed: null,
    },
  };

  attachPlayerToRoom(room, client, payload);
  client.role = 'host';
  rooms.set(roomCode, room);

  safeSend(client.ws, buildRoomSnapshot(room, 'room_created'));
}

function joinRoom(client, payload = {}) {
  if (client.roomCode) leaveRoom(client, 'switch_room');

  const code = sanitizeString(String(payload.code || '').toUpperCase(), '', ROOM_CODE_LENGTH);
  const room = rooms.get(code);

  if (!room) {
    safeSend(client.ws, { t: 'error', message: 'Salle introuvable.' });
    return;
  }

  if (room.gameState.started) {
    safeSend(client.ws, { t: 'error', message: 'La partie a déjà commencé.' });
    return;
  }

  if (room.players.size >= room.maxPlayers) {
    safeSend(client.ws, { t: 'error', message: 'Salle pleine.' });
    return;
  }

  attachPlayerToRoom(room, client, payload);
  client.role = 'guest';
  updateRoomTimestamp(room);

  const joinedSnapshot = buildRoomSnapshot(room, 'room_joined');
  const roomUpdate = buildRoomSnapshot(room, 'room_update');

  safeSend(client.ws, joinedSnapshot);
  broadcastRoom(room, roomUpdate, client.id);
  broadcastRoom(room, {
    t: 'player_joined',
    playerId: client.id,
    players: roomUpdate.players,
  });
}

function leaveRoom(client, reason = 'left') {
  const room = getRoomByClient(client);
  if (!room) {
    client.roomCode = null;
    client.role = null;
    return;
  }

  const wasHost = room.hostId === client.id;
  room.players.delete(client.id);
  client.roomCode = null;
  client.role = null;
  updateRoomTimestamp(room);

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  if (wasHost) {
    const nextHost = room.players.values().next().value;
    room.hostId = nextHost.id;
    safeSend(nextHost.ws, { t: 'host_changed', hostId: nextHost.id });
  }

  broadcastRoom(room, {
    t: 'player_left',
    playerId: client.id,
    reason,
    hostId: room.hostId,
    players: roomPlayerList(room),
  });
}

function updatePlayerMeta(client, payload = {}) {
  const room = getRoomByClient(client);
  if (!room) return;

  const player = room.players.get(client.id);
  if (!player) return;

  if (payload.pseudo !== undefined) {
    player.pseudo = sanitizeString(payload.pseudo, player.pseudo);
  }

  if (payload.character !== undefined) {
    player.character = sanitizeString(payload.character, player.character);
  }

  if (typeof payload.ready === 'boolean') {
    player.ready = payload.ready;
  }

  updateRoomTimestamp(room);
  broadcastRoom(room, buildRoomSnapshot(room, 'room_update'));
}

function startGame(client) {
  const room = getRoomByClient(client);
  if (!room) return;

  if (room.hostId !== client.id) {
    safeSend(client.ws, { t: 'error', message: "Seul l'hôte peut lancer la partie." });
    return;
  }

  room.gameState.started = true;
  room.gameState.seed = randomInt(1_000_000_000);
  updateRoomTimestamp(room);

  broadcastRoom(room, {
    t: 'game_started',
    code: room.code,
    mode: room.mode,
    seed: room.gameState.seed,
    players: roomPlayerList(room),
  });
}

function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function handlePlayerState(client, payload = {}) {
  const room = getRoomByClient(client);
  if (!room) return;

  const player = room.players.get(client.id);
  if (!player) return;

  player.lastState = {
    x: toFiniteNumber(payload.x, 0),
    y: toFiniteNumber(payload.y, 0),
    vx: toFiniteNumber(payload.vx, 0),
    vy: toFiniteNumber(payload.vy, 0),
    hp: toFiniteNumber(payload.hp, 0),
    facing: toFiniteNumber(payload.facing, 1),
    anim: sanitizeString(payload.anim, 'idle', 32),
    ts: now(),
  };

  broadcastRoom(
    room,
    {
      t: 'player_state',
      playerId: client.id,
      state: player.lastState,
    },
    client.id,
  );
}

function handleAction(client, payload = {}) {
  const room = getRoomByClient(client);
  if (!room) return;

  broadcastRoom(
    room,
    {
      t: 'player_action',
      playerId: client.id,
      action: sanitizeString(payload.action, 'unknown', 32),
      data: payload.data ?? null,
      ts: now(),
    },
    client.id,
  );
}

const messageHandlers = {
  create_room: (client, payload) => createRoom(client, payload),
  join_room: (client, payload) => joinRoom(client, payload),
  leave_room: (client) => leaveRoom(client, 'left'),
  update_profile: (client, payload) => updatePlayerMeta(client, payload),
  set_ready: (client, payload) => updatePlayerMeta(client, { ready: !!payload.ready }),
  start_game: (client) => startGame(client),
  player_state: (client, payload) => handlePlayerState(client, payload),
  player_action: (client, payload) => handleAction(client, payload),
  ping: (client, payload) => safeSend(client.ws, { t: 'pong', ts: payload.ts || now() }),
};

function handleMessage(client, raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    safeSend(client.ws, { t: 'error', message: 'Message invalide.' });
    return;
  }

  if (!payload || typeof payload !== 'object') {
    safeSend(client.ws, { t: 'error', message: 'Message invalide.' });
    return;
  }

  const handler = messageHandlers[payload.t];
  if (!handler) {
    safeSend(client.ws, { t: 'error', message: 'Type de message inconnu.' });
    return;
  }

  handler(client, payload);
}

function removeClient(client, reason) {
  leaveRoom(client, reason);
  clients.delete(client.id);
}

wss.on('connection', (ws) => {
  const client = {
    id: randomId(12),
    ws,
    roomCode: null,
    role: null,
    connectedAt: now(),
  };

  clients.set(client.id, client);
  safeSend(ws, { t: 'connected', clientId: client.id });

  ws.on('message', (raw) => {
    handleMessage(client, raw.toString());
  });

  ws.on('close', () => {
    removeClient(client, 'disconnect');
  });

  ws.on('error', () => {
    removeClient(client, 'error');
  });
});

setInterval(() => {
  const expirationLimit = now() - ROOM_TTL_MS;

  for (const [code, room] of rooms.entries()) {
    if (room.updatedAt < expirationLimit && room.players.size === 0) {
      rooms.delete(code);
    }
  }
}, CLEANUP_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`Bandana Fighters server listening on http://localhost:${PORT}`);
});
