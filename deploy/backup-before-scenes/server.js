'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const multer = require('multer');

const PORT = Number(process.env.PORT) || 3000;
const PACKS_DIR = process.env.PACKS_DIR || path.join(__dirname, 'packs');
const RECORD_WINDOW_MS = 60_000;          // hard cap for the whole record phase
const MAX_TAKE_BYTES = 8 * 1024 * 1024;   // per recording
const HOST_GRACE_MS = 15 * 60_000;        // room survives this long without a host
const MAX_PLAYERS = 12;
const UPLOAD_KEY = process.env.UPLOAD_KEY || '';   // unset = uploads disabled
const MAX_UPLOAD_BYTES = 19 * 1024 * 1024;       // stays under nginx's 20m limit
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: MAX_TAKE_BYTES + 64 * 1024 });

app.use(express.json({ limit: '64kb' }));

// Pages are served with versioned script/style URLs so browsers pick up
// every deploy immediately instead of using a cached copy for hours.
const BUILD = Date.now().toString(36);
const PUBLIC_DIR = path.join(__dirname, 'public');
const pageCache = new Map();
const sendPage = (name) => (_req, res) => {
  if (!pageCache.has(name)) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8')
      .replace(/(src|href)="(\/[\w.-]+\.(?:js|css))"/g, `$1="$2?v=${BUILD}"`);
    pageCache.set(name, html);
  }
  res.set('Cache-Control', 'no-cache').type('html').send(pageCache.get(name));
};
app.get(['/', '/index.html'], sendPage('index.html'));
app.get('/solo.html', sendPage('solo.html'));
app.get('/manage.html', sendPage('manage.html'));

app.use(express.static(PUBLIC_DIR));
app.use('/packs', express.static(PACKS_DIR, { fallthrough: false }));

// ---------------------------------------------------------------- packs
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus']);
const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT]);

function loadPacks(includeEmpty = false) {
  if (!fs.existsSync(PACKS_DIR)) return [];
  return fs.readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, d.name, 'pack.json'), 'utf8'));
        const prompts = (meta.prompts || []).filter((p) => p && (p.text || p.media));
        return { id: d.name, title: meta.title || d.name, prompts };
      } catch (err) {
        console.warn(`[packs] skipping ${d.name}: ${err.message}`);
        return null;
      }
    })
    .filter((p) => p && (includeEmpty || p.prompts.length));
}

function promptView(packId, p) {
  const ext = p.media ? path.extname(p.media).toLowerCase() : '';
  return {
    text: p.text || '',
    note: p.note || '',
    media: p.media
      ? `/packs/${encodeURIComponent(packId)}/${p.media.split('/').map(encodeURIComponent).join('/')}`
      : null,
    mediaType: VIDEO_EXT.has(ext) ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : null,
    recordSeconds: Math.min(Math.max(Number(p.recordSeconds) || 15, 3), 45),
  };
}

app.get('/api/packs', (req, res) => {
  res.json(loadPacks(req.query.all === '1').map((p) => ({ id: p.id, title: p.title, count: p.prompts.length })));
});

// ---------------------------------------------------------------- pack editing
const packDir = (id) => path.join(PACKS_DIR, id);
const readPack = (id) => JSON.parse(fs.readFileSync(path.join(packDir(id), 'pack.json'), 'utf8'));
function writePack(id, meta) {
  const file = path.join(packDir(id), 'pack.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(meta, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function requireKey(req, res, next) {
  if (!UPLOAD_KEY) return res.status(503).json({ error: 'Uploads are turned off on this server.' });
  const got = Buffer.from(String(req.get('x-upload-key') || ''));
  const want = Buffer.from(UPLOAD_KEY);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(401).json({ error: 'That upload key is wrong.' });
  }
  next();
}

function packParam(req, res, next) {
  const id = String(req.params.id || '');
  if (!PACK_ID.test(id) || !fs.existsSync(path.join(packDir(id), 'pack.json'))) {
    return res.status(404).json({ error: 'That pack does not exist.' });
  }
  req.packId = id;
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, packDir(req.packId)),
    filename: (_req, file, cb) => cb(null,
      `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = MEDIA_EXT.has(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only video or audio files work: mp4, webm, mov, mp3, wav, ogg or m4a.'), ok);
  },
});

app.get('/api/uploads', (_req, res) => res.json({ enabled: !!UPLOAD_KEY }));
app.post('/api/auth', requireKey, (_req, res) => res.json({ ok: true }));

app.get('/api/packs/:id', packParam, (req, res) => {
  const meta = readPack(req.packId);
  res.json({
    id: req.packId,
    title: meta.title || req.packId,
    prompts: (meta.prompts || []).map((p) => ({ ...promptView(req.packId, p), file: p.media || null })),
  });
});

app.post('/api/packs', requireKey, (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 60);
  if (!title) return res.status(400).json({ error: 'Give the pack a name.' });
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'pack';
  let id = base;
  for (let i = 2; fs.existsSync(packDir(id)); i++) id = `${base}-${i}`;
  fs.mkdirSync(packDir(id), { recursive: true });
  writePack(id, { title, prompts: [] });
  res.json({ ok: true, id });
});

app.delete('/api/packs/:id', requireKey, packParam, (req, res) => {
  fs.rmSync(packDir(req.packId), { recursive: true, force: true });
  res.json({ ok: true });
});

app.post('/api/packs/:id/prompts', requireKey, packParam, (req, res) => {
  upload.single('media')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 19 MB. Trim or compress it, then try again.' : err.message;
      return res.status(400).json({ error: msg });
    }
    const text = String(req.body.text || '').trim().slice(0, 200);
    const note = String(req.body.note || '').trim().slice(0, 120);
    if (!text && !req.file) return res.status(400).json({ error: 'Add a line, a clip, or both.' });
    const meta = readPack(req.packId);
    meta.prompts = meta.prompts || [];
    const prompt = {};
    if (text) prompt.text = text;
    if (note) prompt.note = note;
    if (req.file) prompt.media = req.file.filename;
    prompt.recordSeconds = Math.min(Math.max(Number(req.body.recordSeconds) || 15, 3), 45);
    meta.prompts.push(prompt);
    writePack(req.packId, meta);
    res.json({ ok: true });
  });
});

app.delete('/api/packs/:id/prompts/:index', requireKey, packParam, (req, res) => {
  const meta = readPack(req.packId);
  const i = Number(req.params.index);
  const [removed] = Number.isInteger(i) && i >= 0 ? (meta.prompts || []).splice(i, 1) : [];
  if (!removed) return res.status(404).json({ error: 'That line no longer exists.' });
  writePack(req.packId, meta);
  if (removed.media && !meta.prompts.some((p) => p.media === removed.media)) {
    fs.rm(path.join(packDir(req.packId), path.basename(removed.media)), { force: true }, () => {});
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- rooms
const rooms = new Map();

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function newCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do code = Array.from({ length: 4 }, () => L[crypto.randomInt(L.length)]).join('');
  while (rooms.has(code));
  return code;
}

function createRoom(hostSocketId) {
  const room = {
    code: newCode(),
    hostKey: crypto.randomBytes(16).toString('hex'),
    hostSocket: hostSocketId,
    hostGone: null,
    players: new Map(),      // pid -> { pid, name, score, socketId }
    phase: 'lobby',          // lobby | listen | record | playback | vote | results | final
    packId: null,
    prompts: [],
    roundIndex: -1,
    roundPlayers: new Set(), // pids expected to act this phase
    takes: new Map(),        // pid -> { data, mime }
    takeOrder: [],           // shuffled pids; take number = index + 1
    votes: new Map(),        // voter pid -> target pid
    results: null,
    deadline: null,
    timer: null,
  };
  rooms.set(room.code, room);
  return room;
}

const connected = (room, pids) => [...pids].filter((pid) => room.players.get(pid)?.socketId);

function baseState(room) {
  const raw = room.prompts[room.roundIndex];
  const showPrompt = raw && !['lobby', 'final'].includes(room.phase);
  return {
    code: room.code,
    phase: room.phase,
    round: room.roundIndex + 1,
    totalRounds: room.prompts.length,
    prompt: showPrompt ? promptView(room.packId, raw) : null,
    remainingMs: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    takeCount: room.takeOrder.length,
    results: room.results,
    players: [...room.players.values()].map((p) => ({
      name: p.name,
      score: p.score,
      connected: !!p.socketId,
      submitted: room.takes.has(p.pid),
      voted: room.votes.has(p.pid),
    })),
  };
}

function broadcast(room) {
  const base = baseState(room);
  if (room.hostSocket) io.to(room.hostSocket).emit('state', { ...base, role: 'host' });
  for (const p of room.players.values()) {
    if (!p.socketId) continue;
    const idx = room.takeOrder.indexOf(p.pid);
    io.to(p.socketId).emit('state', {
      ...base,
      role: 'player',
      me: {
        name: p.name,
        score: p.score,
        submitted: room.takes.has(p.pid),
        voted: room.votes.has(p.pid),
        myTake: idx >= 0 ? idx + 1 : null,
      },
    });
  }
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
}

function resetRound(room) {
  clearTimer(room);
  room.takes.clear();
  room.takeOrder = [];
  room.votes.clear();
  room.results = null;
  room.roundPlayers = new Set();
}

function startRound(room, i) {
  resetRound(room);
  room.roundIndex = i;
  room.phase = 'listen';
  broadcast(room);
}

function startRecording(room) {
  if (room.phase !== 'listen') return;
  room.phase = 'record';
  room.roundPlayers = new Set(connected(room, room.players.keys()));
  room.deadline = Date.now() + RECORD_WINDOW_MS;
  room.timer = setTimeout(() => toPlayback(room), RECORD_WINDOW_MS + 3000);
  broadcast(room);
}

function sendTakes(room) {
  if (!room.hostSocket) return;
  io.to(room.hostSocket).emit('takes', room.takeOrder.map((pid, i) => {
    const t = room.takes.get(pid);
    return { n: i + 1, mime: t.mime, data: t.data };
  }));
}

function toPlayback(room) {
  if (room.phase !== 'record') return;
  clearTimer(room);
  room.takeOrder = shuffle([...room.takes.keys()]);
  room.phase = 'playback';
  sendTakes(room);
  broadcast(room);
}

function startVoting(room) {
  if (room.phase !== 'playback') return;
  room.phase = 'vote';
  room.roundPlayers = new Set(connected(room, room.players.keys()));
  broadcast(room);
  maybeAdvance(room);
}

function toResults(room) {
  if (room.phase !== 'vote') return;
  const tally = new Map();
  for (const target of room.votes.values()) tally.set(target, (tally.get(target) || 0) + 1);
  room.results = room.takeOrder.map((pid, i) => {
    const p = room.players.get(pid);
    const votes = tally.get(pid) || 0;
    if (p) p.score += votes * 100;
    return { n: i + 1, name: p ? p.name : 'Someone', votes };
  });
  room.phase = 'results';
  broadcast(room);
}

function nextRound(room) {
  if (room.phase !== 'results') return;
  if (room.roundIndex + 1 < room.prompts.length) return startRound(room, room.roundIndex + 1);
  room.phase = 'final';
  broadcast(room);
}

const canVote = (room, pid) => room.takeOrder.some((t) => t !== pid);

function maybeAdvance(room) {
  if (room.phase === 'record') {
    const waiting = connected(room, room.roundPlayers).filter((pid) => !room.takes.has(pid));
    if (room.takes.size > 0 && waiting.length === 0) toPlayback(room);
  } else if (room.phase === 'vote') {
    const waiting = connected(room, room.roundPlayers)
      .filter((pid) => canVote(room, pid) && !room.votes.has(pid));
    if (waiting.length === 0) toResults(room);
  }
}

// ---------------------------------------------------------------- sockets
io.on('connection', (socket) => {
  const reply = (ack, payload) => typeof ack === 'function' && ack(payload);
  const hostRoom = () => {
    const r = rooms.get(socket.data.code);
    return r && socket.data.role === 'host' && r.hostSocket === socket.id ? r : null;
  };
  const playerCtx = () => {
    const r = rooms.get(socket.data.code);
    const p = r?.players.get(socket.data.pid);
    return r && p && p.socketId === socket.id ? { room: r, player: p } : null;
  };

  // ---- host
  socket.on('host:create', (ack) => {
    const room = createRoom(socket.id);
    socket.data = { code: room.code, role: 'host' };
    reply(ack, { ok: true, code: room.code, hostKey: room.hostKey });
    broadcast(room);
  });

  socket.on('host:resume', ({ code, hostKey } = {}, ack) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room || room.hostKey !== hostKey) return reply(ack, { ok: false, error: 'That room has closed.' });
    if (room.hostSocket && room.hostSocket !== socket.id) {
      io.to(room.hostSocket).emit('kicked', 'The host screen was opened somewhere else.');
    }
    room.hostSocket = socket.id;
    clearTimeout(room.hostGone);
    room.hostGone = null;
    socket.data = { code: room.code, role: 'host' };
    reply(ack, { ok: true, code: room.code });
    if (['playback', 'vote', 'results'].includes(room.phase)) sendTakes(room);
    broadcast(room);
  });

  socket.on('host:start', ({ packId, rounds } = {}, ack) => {
    const room = hostRoom();
    if (!room || !['lobby', 'final'].includes(room.phase)) return reply(ack, { ok: false });
    const pack = loadPacks().find((p) => p.id === packId);
    if (!pack) return reply(ack, { ok: false, error: 'Pick a pack first.' });
    if (!connected(room, room.players.keys()).length) return reply(ack, { ok: false, error: 'Nobody has joined yet.' });
    const n = Math.min(Math.max(parseInt(rounds, 10) || 5, 1), pack.prompts.length);
    room.packId = pack.id;
    room.prompts = shuffle(pack.prompts).slice(0, n);
    for (const p of room.players.values()) p.score = 0;
    reply(ack, { ok: true });
    startRound(room, 0);
  });

  socket.on('host:record', () => { const r = hostRoom(); if (r) startRecording(r); });
  socket.on('host:endRecording', () => { const r = hostRoom(); if (r) toPlayback(r); });
  socket.on('host:vote', () => { const r = hostRoom(); if (r) startVoting(r); });
  socket.on('host:endVoting', () => { const r = hostRoom(); if (r) toResults(r); });
  socket.on('host:next', () => { const r = hostRoom(); if (r) nextRound(r); });

  socket.on('host:lobby', () => {
    const r = hostRoom();
    if (!r) return;
    resetRound(r);
    r.phase = 'lobby';
    r.roundIndex = -1;
    r.prompts = [];
    broadcast(r);
  });

  socket.on('host:close', () => {
    const r = hostRoom();
    if (!r) return;
    clearTimer(r);
    clearTimeout(r.hostGone);
    for (const p of r.players.values()) {
      if (p.socketId) io.to(p.socketId).emit('kicked', 'The host closed the room.');
    }
    rooms.delete(r.code);
    socket.data = {};
  });

  socket.on('host:kick', ({ name } = {}) => {
    const r = hostRoom();
    if (!r || r.phase !== 'lobby') return;
    for (const [pid, p] of r.players) {
      if (p.name !== name) continue;
      if (p.socketId) io.to(p.socketId).emit('kicked', 'The host removed you from the room.');
      r.players.delete(pid);
    }
    broadcast(r);
  });

  // ---- players
  socket.on('player:join', ({ code, name, pid } = {}, ack) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return reply(ack, { ok: false, error: 'No room with that code. Check the big screen.' });
    pid = String(pid || '').slice(0, 64);
    name = String(name || '').trim().slice(0, 16);
    if (!pid || !name) return reply(ack, { ok: false, error: 'Enter a name to join.' });

    let p = room.players.get(pid);
    if (!p) {
      const taken = [...room.players.values()].some((x) => x.name.toLowerCase() === name.toLowerCase());
      if (taken) return reply(ack, { ok: false, error: 'Someone in this room already has that name.' });
      if (room.players.size >= MAX_PLAYERS) return reply(ack, { ok: false, error: 'This room is full.' });
      p = { pid, name, score: 0, socketId: null };
      room.players.set(pid, p);
    }
    if (p.socketId && p.socketId !== socket.id) io.to(p.socketId).emit('kicked', 'You joined from another tab.');
    p.socketId = socket.id;
    socket.data = { code: room.code, role: 'player', pid };
    reply(ack, { ok: true, code: room.code, name: p.name });
    broadcast(room);
  });

  socket.on('player:leave', () => {
    const ctx = playerCtx();
    if (!ctx) return;
    const { room, player } = ctx;
    room.players.delete(player.pid);
    room.roundPlayers.delete(player.pid);
    room.votes.delete(player.pid);
    socket.data = {};
    broadcast(room);
    maybeAdvance(room);
  });

  socket.on('player:take', ({ data, mime } = {}, ack) => {
    const ctx = playerCtx();
    if (!ctx) return reply(ack, { ok: false, error: 'You are not in a room.' });
    const { room, player } = ctx;
    if (room.phase !== 'record') return reply(ack, { ok: false, error: 'Recording has closed for this round.' });
    if (!Buffer.isBuffer(data) || !data.length) return reply(ack, { ok: false, error: 'The recording was empty.' });
    if (data.length > MAX_TAKE_BYTES) return reply(ack, { ok: false, error: 'The recording is too large.' });
    const safeMime = /^audio\/[\w.+-]+(;.*)?$/.test(String(mime)) ? String(mime) : 'audio/webm';
    room.takes.set(player.pid, { data, mime: safeMime });
    reply(ack, { ok: true });
    broadcast(room);
    maybeAdvance(room);
  });

  socket.on('player:vote', ({ n } = {}, ack) => {
    const ctx = playerCtx();
    if (!ctx) return reply(ack, { ok: false, error: 'You are not in a room.' });
    const { room, player } = ctx;
    if (room.phase !== 'vote') return reply(ack, { ok: false, error: 'Voting has closed.' });
    const target = room.takeOrder[Number(n) - 1];
    if (!target || target === player.pid) return reply(ack, { ok: false, error: "You can't vote for that take." });
    room.votes.set(player.pid, target);
    reply(ack, { ok: true });
    broadcast(room);
    maybeAdvance(room);
  });

  // ---- disconnects
  socket.on('disconnect', () => {
    const room = rooms.get(socket.data?.code);
    if (!room) return;
    if (socket.data.role === 'host' && room.hostSocket === socket.id) {
      room.hostSocket = null;
      room.hostGone = setTimeout(() => {
        clearTimer(room);
        for (const p of room.players.values()) {
          if (p.socketId) io.to(p.socketId).emit('kicked', 'The host left, so the room closed.');
        }
        rooms.delete(room.code);
      }, HOST_GRACE_MS);
    } else if (socket.data.role === 'player') {
      const p = room.players.get(socket.data.pid);
      if (p && p.socketId === socket.id) {
        p.socketId = null;
        broadcast(room);
        maybeAdvance(room);
      }
    }
  });
});

server.listen(PORT, () => console.log(`Dub Club listening on :${PORT}`));
