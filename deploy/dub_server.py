import sys, os
os.chdir(sys.argv[1])

def patch(path, pairs):
    s = open(path).read()
    for a, b in pairs:
        assert s.count(a) == 1, f"{path}: anchor not unique/found: {a[:80]!r}"
        s = s.replace(a, b)
    open(path, 'w').write(s)

patch('server.js', [
# --- requires + dirs
("""const multer = require('multer');
""",
"""const multer = require('multer');
const importer = require('./importer');
"""),
("""const PACK_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
""",
"""const PACK_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const INBOX_DIR = process.env.INBOX_DIR || path.join(__dirname, 'inbox');
const INCOMING_DIR = path.join(PACKS_DIR, '.incoming');
const MAX_DUB_TRACK_BYTES = 8 * 1024 * 1024;
"""),

# --- pack listing understands dub packs, skips work folders
("""    .filter((d) => d.isDirectory())
    .map((d) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, d.name, 'pack.json'), 'utf8'));
        const prompts = (meta.prompts || []).filter((p) => p && (p.text || p.media));
        return { id: d.name, title: meta.title || d.name, prompts };""",
"""    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, d.name, 'pack.json'), 'utf8'));
        if (meta.type === 'dub') {
          const cues = meta.cues || [];
          return { id: d.name, title: meta.title || d.name, type: 'dub', prompts: [], cues,
            characters: meta.characters || [], videoDur: meta.videoDur || null, count: cues.length };
        }
        const prompts = (meta.prompts || []).filter((p) => p && (p.text || p.media));
        return { id: d.name, title: meta.title || d.name, type: 'lines', prompts, count: prompts.length };"""),
("""    .filter((p) => p && (includeEmpty || p.prompts.length));""",
"""    .filter((p) => p && (includeEmpty || p.count));"""),

# --- prompt view: images, shared url helper
("""function promptView(packId, p) {
  const ext = p.media ? path.extname(p.media).toLowerCase() : '';
  return {""",
"""const fileUrl = (packId, f) => (f ? `/packs/${encodeURIComponent(packId)}/${String(f).split('/').map(encodeURIComponent).join('/')}` : null);

function promptView(packId, p) {
  const ext = p.media ? path.extname(p.media).toLowerCase() : '';
  return {
    image: fileUrl(packId, p.image),"""),

("""  res.json(loadPacks(req.query.all === '1').map((p) => ({ id: p.id, title: p.title, count: p.prompts.length })));""",
"""  res.json(loadPacks(req.query.all === '1').map((p) => ({
    id: p.id, title: p.title, type: p.type, count: p.count,
    ...(p.type === 'dub' ? { characters: p.characters, videoDur: p.videoDur } : {}),
  })));"""),

# --- full pack view for dub packs
("""  const meta = readPack(req.packId);
  res.json({
    id: req.packId,
    title: meta.title || req.packId,
    prompts:""",
"""  const meta = readPack(req.packId);
  const u = (f) => fileUrl(req.packId, f);
  if (meta.type === 'dub') {
    return res.json({
      id: req.packId, type: 'dub', title: meta.title || req.packId, authors: meta.authors || [],
      icon: u(meta.icon), video: u(meta.video), backing: u(meta.backing), videoDur: meta.videoDur || null,
      characters: meta.characters || [],
      cues: (meta.cues || []).map((c) => ({ ...c, audio: u(c.audio), image: u(c.image) })),
    });
  }
  res.json({
    id: req.packId,
    type: 'lines',
    title: meta.title || req.packId,
    authors: meta.authors || [],
    prompts:"""),

# --- no hand-adding lines to dub packs
("""app.post('/api/packs/:id/prompts', requireKey, packParam, (req, res) => {
  upload.single('media')(req, res, (err) => {""",
"""app.post('/api/packs/:id/prompts', requireKey, packParam, (req, res) => {
  if (readPack(req.packId).type === 'dub') return res.status(400).json({ error: 'Scene packs can only be changed by re-importing them.' });
  upload.single('media')(req, res, (err) => {"""),

# --- imports: chunked uploads, server inbox, job queue
("""// ---------------------------------------------------------------- rooms""",
"""// ---------------------------------------------------------------- pack imports
for (const d of [INCOMING_DIR, path.join(PACKS_DIR, '.work')]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(INCOMING_DIR, { recursive: true });

const uploads = new Map(); // id -> { name, file }
const jobs = [];           // newest first
let jobsRunning = false;

function queueJob(name, src, onDone) {
  const job = { id: crypto.randomBytes(4).toString('hex'), name, state: 'queued', message: 'Waiting its turn…', packs: [], src, onDone };
  jobs.unshift(job);
  if (jobs.length > 300) jobs.length = 300;
  runJobs();
  return job;
}

async function runJobs() {
  if (jobsRunning) return;
  jobsRunning = true;
  try {
    for (;;) {
      const job = [...jobs].reverse().find((j) => j.state === 'queued');
      if (!job) break;
      job.state = 'working';
      job.message = 'Starting…';
      let ok = false;
      try {
        const ids = await importer.importSource(job.src, PACKS_DIR, (m) => { job.message = m; });
        job.packs = ids.map((id) => { try { return readPack(id).title; } catch { return id; } });
        job.state = 'done';
        job.message = `Imported ${job.packs.join(', ')}`;
        ok = true;
      } catch (err) {
        job.state = 'failed';
        job.message = err.message;
      }
      try { await job.onDone?.(ok); } catch (err) { console.warn('[import] cleanup failed:', err.message); }
    }
  } finally {
    jobsRunning = false;
  }
}

const uploadParam = (req, res, next) => {
  const id = String(req.params.id || '');
  const up = /^[a-f0-9]{16}$/.test(id) && uploads.get(id);
  if (!up) return res.status(404).json({ error: 'That upload has expired. Start it again.' });
  req.upload = up;
  req.uploadId = id;
  next();
};

app.post('/api/imports', requireKey, (req, res) => {
  const name = String(req.body?.name || 'pack.zip').slice(0, 160);
  const id = crypto.randomBytes(8).toString('hex');
  const file = path.join(INCOMING_DIR, `${id}.zip`);
  fs.writeFileSync(file, '');
  uploads.set(id, { name, file });
  res.json({ id });
});

app.put('/api/imports/:id', requireKey, uploadParam,
  express.raw({ type: 'application/octet-stream', limit: '10mb' }), (req, res) => {
    const size = fs.statSync(req.upload.file).size;
    if (Number(req.query.offset) !== size) return res.status(409).json({ error: 'Upload out of step.', size });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty chunk.' });
    fs.appendFileSync(req.upload.file, req.body);
    res.json({ ok: true, size: size + req.body.length });
  });

app.post('/api/imports/:id/finish', requireKey, uploadParam, (req, res) => {
  const { name, file } = req.upload;
  uploads.delete(req.uploadId);
  const job = queueJob(name, file, () => fs.promises.rm(file, { force: true }));
  res.json({ ok: true, job: job.id });
});

app.get('/api/jobs', requireKey, (_req, res) => {
  res.json(jobs.map(({ id, name, state, message, packs }) => ({ id, name, state, message, packs })));
});

function inboxItems() {
  if (!fs.existsSync(INBOX_DIR)) return [];
  return fs.readdirSync(INBOX_DIR, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !['imported', 'failed'].includes(e.name)
      && (e.isDirectory() || (e.isFile() && e.name.toLowerCase().endsWith('.zip'))))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

app.get('/api/inbox', requireKey, (_req, res) => res.json({ items: inboxItems() }));

app.post('/api/inbox/import', requireKey, (_req, res) => {
  const queued = new Set(jobs.filter((j) => ['queued', 'working'].includes(j.state)).map((j) => j.src));
  const items = inboxItems().filter((name) => !queued.has(path.join(INBOX_DIR, name)));
  for (const name of items) {
    const src = path.join(INBOX_DIR, name);
    queueJob(name, src, async (ok) => {
      const dest = path.join(INBOX_DIR, ok ? 'imported' : 'failed');
      await fs.promises.mkdir(dest, { recursive: true });
      await fs.promises.rename(src, path.join(dest, name)).catch(() => {});
    });
  }
  res.json({ ok: true, queued: items.length });
});

// ---------------------------------------------------------------- rooms"""),

# --- room fields
("""    results: null,
    deadline: null,
    timer: null,
  };
  rooms.set(room.code, room);""",
"""    results: null,
    deadline: null,
    timer: null,
    mode: 'lines',           // lines | dub
    dub: null,               // { roles: Map(character -> pid|null), ready: Set(pid), tracks: Map(pid -> track), videoDur }
  };
  rooms.set(room.code, room);"""),

# --- state: dub info
("""    takeCount: room.takeOrder.length,
    results: room.results,""",
"""    takeCount: room.takeOrder.length,
    results: room.results,
    mode: room.mode,
    dub: room.dub ? {
      packId: room.packId,
      roles: Object.fromEntries([...room.dub.roles].map(([c, pid]) => [c, pid ? room.players.get(pid)?.name ?? null : null])),
      ready: [...room.dub.ready].map((pid) => room.players.get(pid)?.name).filter(Boolean),
      uploaded: [...room.dub.tracks.keys()].map((pid) => room.players.get(pid)?.name).filter(Boolean),
    } : null,"""),
("""        myTake: idx >= 0 ? idx + 1 : null,
      },""",
"""        myTake: idx >= 0 ? idx + 1 : null,
        roles: room.dub ? [...room.dub.roles].filter(([, pid]) => pid === p.pid).map(([c]) => c) : [],
      },"""),

# --- dub flow helpers + advance
("""const canVote = (room, pid) => room.takeOrder.some((t) => t !== pid);

function maybeAdvance(room) {""",
"""const canVote = (room, pid) => room.takeOrder.some((t) => t !== pid);

// ---- dub mode
const performers = (room) => [...new Set([...room.dub.roles.values()].filter(Boolean))];

function dubTracksPayload(room) {
  return [...room.dub.tracks].map(([pid, t]) => ({
    name: room.players.get(pid)?.name ?? 'Someone',
    characters: [...room.dub.roles].filter(([, p]) => p === pid).map(([c]) => c),
    mime: t.mime, lead: t.lead, data: t.data,
  }));
}

function sendDubTracks(room, socketId) {
  const payload = dubTracksPayload(room);
  const targets = socketId ? [socketId]
    : [room.hostSocket, ...[...room.players.values()].map((p) => p.socketId)].filter(Boolean);
  for (const id of targets) io.to(id).emit('dubtracks', payload);
}

function toDubView(room) {
  if (room.phase !== 'dubrec') return;
  clearTimer(room);
  room.phase = 'dubview';
  sendDubTracks(room);
  broadcast(room);
}

function maybeAdvance(room) {
  if (room.phase === 'dubrec') {
    const waiting = connected(room, performers(room)).filter((pid) => !room.dub.tracks.has(pid));
    if (room.dub.tracks.size > 0 && waiting.length === 0) toDubView(room);
    return;
  }"""),

# --- resume: resend dub tracks
("""    if (['playback', 'vote', 'results'].includes(room.phase)) sendTakes(room);
    broadcast(room);
  });""",
"""    if (['playback', 'vote', 'results'].includes(room.phase)) sendTakes(room);
    broadcast(room);
    if (room.phase === 'dubview') sendDubTracks(room, socket.id);
  });"""),

# --- start: dub branch
("""  socket.on('host:start', ({ packId, rounds } = {}, ack) => {
    const room = hostRoom();
    if (!room || !['lobby', 'final'].includes(room.phase)) return reply(ack, { ok: false });
    const pack = loadPacks().find((p) => p.id === packId);
    if (!pack) return reply(ack, { ok: false, error: 'Pick a pack first.' });
    if (!connected(room, room.players.keys()).length) return reply(ack, { ok: false, error: 'Nobody has joined yet.' });""",
"""  socket.on('host:start', ({ packId, rounds, roles } = {}, ack) => {
    const room = hostRoom();
    if (!room || !['lobby', 'final'].includes(room.phase)) return reply(ack, { ok: false });
    const pack = loadPacks().find((p) => p.id === packId);
    if (!pack) return reply(ack, { ok: false, error: 'Pick a pack first.' });
    if (!connected(room, room.players.keys()).length) return reply(ack, { ok: false, error: 'Nobody has joined yet.' });
    if (pack.type === 'dub') {
      const assigned = new Map();
      for (const c of pack.characters) {
        const name = roles && typeof roles === 'object' ? roles[c] : null;
        const p = name ? [...room.players.values()].find((x) => x.name === name) : null;
        assigned.set(c, p ? p.pid : null);
      }
      if (![...assigned.values()].some(Boolean)) return reply(ack, { ok: false, error: 'Give at least one role to a player.' });
      resetRound(room);
      room.mode = 'dub';
      room.packId = pack.id;
      room.prompts = [];
      room.roundIndex = -1;
      room.dub = { roles: assigned, ready: new Set(), tracks: new Map(), videoDur: pack.videoDur || 180 };
      room.phase = 'dubload';
      reply(ack, { ok: true });
      broadcast(room);
      return;
    }
    room.mode = 'lines';
    room.dub = null;"""),

# --- lobby reset + dub host controls
("""    resetRound(r);
    r.phase = 'lobby';
    r.roundIndex = -1;
    r.prompts = [];
    broadcast(r);
  });""",
"""    resetRound(r);
    r.phase = 'lobby';
    r.roundIndex = -1;
    r.prompts = [];
    r.mode = 'lines';
    r.dub = null;
    broadcast(r);
  });

  socket.on('host:dubGo', () => {
    const r = hostRoom();
    if (!r || r.phase !== 'dubload') return;
    r.dub.tracks.clear();
    r.phase = 'dubrec';
    r.timer = setTimeout(() => toDubView(r), (r.dub.videoDur + 60) * 1000);
    broadcast(r);
  });

  socket.on('host:dubEnd', () => { const r = hostRoom(); if (r) toDubView(r); });

  socket.on('host:dubAgain', () => {
    const r = hostRoom();
    if (!r || !['dubrec', 'dubview'].includes(r.phase)) return;
    clearTimer(r);
    r.dub.tracks.clear();
    r.phase = 'dubload';
    broadcast(r);
  });"""),

# --- players: dub ready/track; rejoin resend
("""    reply(ack, { ok: true, code: room.code, name: p.name });
    broadcast(room);
  });""",
"""    reply(ack, { ok: true, code: room.code, name: p.name });
    broadcast(room);
    if (room.phase === 'dubview') sendDubTracks(room, socket.id);
  });

  socket.on('player:dubReady', () => {
    const ctx = playerCtx();
    if (!ctx || ctx.room.phase !== 'dubload') return;
    ctx.room.dub.ready.add(ctx.player.pid);
    broadcast(ctx.room);
  });

  socket.on('player:dubTrack', ({ data, mime, lead } = {}, ack) => {
    const ctx = playerCtx();
    if (!ctx) return reply(ack, { ok: false, error: 'You are not in a room.' });
    const { room, player } = ctx;
    if (room.phase !== 'dubrec') return reply(ack, { ok: false, error: 'This take has already finished.' });
    if (!performers(room).includes(player.pid)) return reply(ack, { ok: false, error: 'You have no role in this scene.' });
    if (!Buffer.isBuffer(data) || !data.length) return reply(ack, { ok: false, error: 'The recording was empty.' });
    if (data.length > MAX_DUB_TRACK_BYTES) return reply(ack, { ok: false, error: 'The recording is too large.' });
    const safeMime = /^audio\\/[\\w.+-]+(;.*)?$/.test(String(mime)) ? String(mime) : 'audio/webm';
    room.dub.tracks.set(player.pid, { data, mime: safeMime, lead: Math.min(Math.max(Number(lead) || 0, 0), 5) });
    reply(ack, { ok: true });
    broadcast(room);
    maybeAdvance(room);
  });"""),
])
print("server patched")
