import sys, os
os.chdir(sys.argv[1])

def patch(path, pairs):
    s = open(path).read()
    for a, b in pairs:
        assert s.count(a) == 1, f"{path}: anchor not unique/found: {a[:80]!r}"
        s = s.replace(a, b)
    open(path, 'w').write(s)

# ---------------------------------------------------------------- dub.js: allow aborting a take
patch('public/dub.js', [
("""  const cueLength = (c) => Math.max(c.dur || 2, 1.2);
""",
"""  const cueLength = (c) => Math.max(c.dur || 2, 1.2);
  let stopActive = null; // ends the take that is currently recording, if any
"""),
("""    await new Promise((r) => {
      video.onended = r;
      stage.btn('.dubstop').onclick = r;
    });
    video.onended = null;""",
"""    await new Promise((r) => {
      stopActive = r;
      video.onended = r;
      stage.btn('.dubstop').onclick = r;
    });
    stopActive = null;
    video.onended = null;"""),
("""  return { loadPack, preload, record, playback, stopAll, esc };""",
"""  const stopRecording = () => stopActive?.();

  return { loadPack, preload, record, playback, stopAll, stopRecording, esc };"""),
])

# ---------------------------------------------------------------- index.html / solo.html load dub.js
for page, script in (('public/index.html', '/app.js'), ('public/solo.html', '/solo.js')):
    patch(page, [(f'  <script src="{script}"></script>', f'  <script src="/dub.js"></script>\n  <script src="{script}"></script>')])

# ---------------------------------------------------------------- app.js
patch('public/app.js', [
("""  let takes = []; // host only: [{ n, url }]
""",
"""  let takes = []; // host only: [{ n, url }]
  // scene (dub) mode
  let dub = { packId: null, pack: null, media: null, loading: null, progress: null, tracks: null, view: null, stream: null };
  let packsCache = [];
  let hostRoles = {};
  let touchedRoles = new Set();
  let rolesKey = '';
  let lastPackId = '';
"""),

("""  socket.on('kicked', (msg) => {
    hostSession.set(null);
    playerSession.set(null);
    resetRec();""",
"""  socket.on('kicked', (msg) => {
    hostSession.set(null);
    playerSession.set(null);
    resetRec();
    clearDub();"""),

("""  // ------------------------------------------------------------ downloads""",
"""  socket.on('dubtracks', (list) => {
    (dub.tracks || []).forEach((t) => URL.revokeObjectURL(t.url));
    dub.tracks = list.map((t) => ({
      name: t.name, characters: t.characters, lead: t.lead, mime: t.mime,
      url: URL.createObjectURL(new Blob([t.data], { type: t.mime })),
    }));
    if (state?.phase === 'dubview') showDubView();
  });

  // ------------------------------------------------------------ downloads"""),

("""      else if (p.mediaType === 'audio') media = `<audio id="ref" src="${esc(p.media)}" controls></audio>`;""",
"""      else if (p.mediaType === 'audio') {
        media = `${p.image ? `<img class="ref" src="${esc(p.image)}" alt="">` : ''}<audio id="ref" src="${esc(p.media)}" controls></audio>`;
      }"""),

("""      stopTick();
      if (s.role === 'player' && s.phase !== 'record') resetRec();""",
"""      stopTick();
      leaveDubScreen(s);
      if (s.role === 'player' && s.phase !== 'record') resetRec();"""),

("""    resetRec();
    renderHome();
  }""",
"""    resetRec();
    clearDub();
    renderHome();
  }"""),

("""    if (s.role === 'host') return renderPlayers(s);""",
"""    if (s.role === 'host') {
      renderPlayers(s);
      if (s.phase === 'lobby') renderRoles(s);
      if (s.phase === 'dubload' || s.phase === 'dubrec') renderDubStatus(s);
      return;
    }"""),

# host lobby: pack picker knows about scenes and roles
("""    lobby(s) {
      takes = [];
      app.innerHTML = `<main class="stage host">${hostBar(s)}""",
"""    lobby(s) {
      takes = [];
      clearDub();
      rolesKey = '';
      app.innerHTML = `<main class="stage host">${hostBar(s)}"""),
("""            <label>Rounds<input id="rounds" type="number" min="1" max="20" value="5"></label>
            <button id="start" class="btn primary">Start game</button>""",
"""            <label id="roundsWrap">Rounds<input id="rounds" type="number" min="1" max="20" value="5"></label>
            <div id="roles" class="rolepick" hidden></div>
            <button id="start" class="btn primary">Start game</button>"""),
("""      fetch('/api/packs').then((r) => r.json()).then((packs) => {
        $('#pack').innerHTML = packs.length
          ? packs.map((p) => `<option value="${esc(p.id)}">${esc(p.title)} (${p.count} lines)</option>`).join('')
          : '<option value="">No packs found in /packs</option>';
      }).catch(() => toast('Packs failed to load. Check the server.'));
      $('#start').onclick = () => socket.emit('host:start', { packId: $('#pack').value, rounds: $('#rounds').value },
        (res) => { if (!res?.ok) toast(res?.error || 'The game could not start.'); });""",
"""      fetch('/api/packs').then((r) => r.json()).then((packs) => {
        packsCache = packs;
        const scenes = packs.filter((p) => p.type === 'dub');
        const lines = packs.filter((p) => p.type !== 'dub');
        const opt = (p) => `<option value="${esc(p.id)}">${esc(p.title)} (${p.type === 'dub'
          ? `${p.characters.length} role${p.characters.length === 1 ? '' : 's'}` : `${p.count} lines`})</option>`;
        $('#pack').innerHTML = packs.length
          ? (scenes.length ? `<optgroup label="Scenes (dub mode)">${scenes.map(opt).join('')}</optgroup>` : '')
            + (lines.length ? `<optgroup label="Voice lines">${lines.map(opt).join('')}</optgroup>` : '')
          : '<option value="">No packs yet. Add some in Manage packs.</option>';
        if (lastPackId && packs.some((p) => p.id === lastPackId)) $('#pack').value = lastPackId;
        onPackChange();
      }).catch(() => toast('Packs failed to load. Check the server.'));
      $('#pack').onchange = onPackChange;
      $('#start').onclick = () => {
        const pack = currentPack();
        socket.emit('host:start', {
          packId: $('#pack').value,
          rounds: $('#rounds').value,
          roles: pack?.type === 'dub' ? hostRoles : undefined,
        }, (res) => { if (!res?.ok) toast(res?.error || 'The game could not start.'); });
      };"""),

# host dub screens
("""  };

  // ------------------------------------------------------------ recorder (players)""",
"""
    dubload(s) {
      app.innerHTML = `<main class="stage host">${hostBar(s)}
        <h2 class="phase" id="sceneTitle">Scene</h2>
        <p class="hint center-text">Everyone recording should wear headphones, so the scene doesn't leak into their take.</p>
        <div class="card narrow"><h2>Cast</h2><ul id="dubstatus" class="players"></ul><p id="dubOriginals" class="hint"></p></div>
        <p class="hint center-text" id="hostload">Loading the scene on this screen…</p>
        <div class="actions">
          <button id="toLobby" class="btn ghost">Back to lobby</button>
          <button id="go" class="btn primary">Roll camera</button>
        </div></main>`;
      $('#toLobby').onclick = () => socket.emit('host:lobby');
      $('#go').onclick = () => {
        if (!allReady(state) && !confirm('Not everyone is ready yet. Start anyway?')) return;
        socket.emit('host:dubGo');
      };
      ensureDubMedia(s.dub.packId, (p) => {
        const el = $('#hostload');
        if (el) el.textContent = p >= 1 ? 'Scene loaded on this screen.' : `Loading the scene on this screen… ${Math.round(p * 100)}%`;
      }).then(() => { const t = $('#sceneTitle'); if (t) t.textContent = dub.pack.title; })
        .catch((e) => toast(e.message));
    },

    dubrec(s) {
      app.innerHTML = `<main class="stage host">${hostBar(s)}
        <h2 class="phase">Recording</h2>
        <p class="hint center-text">Everyone is performing on their own screen. The dub plays here when they're done.</p>
        <div class="card narrow"><ul id="dubstatus" class="players"></ul><p id="dubOriginals" class="hint"></p></div>
        <div class="actions"><button id="end" class="btn ghost">Stop and show the dub</button></div></main>`;
      $('#end').onclick = () => socket.emit('host:dubEnd');
    },

    dubview(s) {
      app.innerHTML = `<main class="stage host">${hostBar(s)}
        <div id="dubview" class="dubwrap"><p class="hint center-text">Putting the dub together…</p></div>
        <div class="actions">
          <button id="dlTracks" class="btn ghost">Download voice tracks</button>
          <button id="again" class="btn">Record it again</button>
          <button id="toLobby" class="btn primary">Back to lobby</button>
        </div></main>`;
      $('#again').onclick = () => socket.emit('host:dubAgain');
      $('#toLobby').onclick = () => socket.emit('host:lobby');
      $('#dlTracks').onclick = () => (dub.tracks || []).forEach((t, i) => setTimeout(() => download(t.url,
        `${fileSafe(t.name)}-${fileSafe(t.characters.join('-'))}.${extFor(t.mime)}`), i * 400));
      showDubView();
    },
  };

  // ------------------------------------------------------------ recorder (players)"""),

("""  const PLAYER = {
    lobby(s) {
""",
"""  const PLAYER = {
    lobby(s) {
      clearDub();
"""),

# player dub screens + scene helpers
("""        <p class="bignum">#${rank}</p><p>You finished with ${s.me.score} points.</p></div>`);
    },
  };
})();""",
"""        <p class="bignum">#${rank}</p><p>You finished with ${s.me.score} points.</p></div>`);
    },

    dubload(s) {
      const mine = s.me.roles;
      app.innerHTML = shell(s, `<div class="center">
        <h2>${mine.length ? `You're playing ${esc(mine.join(' and '))}` : "You're watching this one"}</h2>
        <p>${mine.length ? 'Put your headphones on. Your lines light up on screen as the scene plays.'
          : 'The finished dub will play here when the others are done.'}</p>
        <progress id="loadprog" max="100" value="0"></progress>
        <p id="loadmsg" class="hint">Loading the scene…</p>
        ${mine.length ? '<button id="ready" class="btn primary" disabled>I\\'m ready</button>' : ''}
        <p id="readymsg" class="big" hidden>Ready. Waiting for the host to roll camera.</p></div>`);
      const markReady = () => {
        const b = $('#ready'); if (b) b.hidden = true;
        const m = $('#readymsg'); if (m) m.hidden = false;
      };
      ensureDubMedia(s.dub.packId, (p) => { const el = $('#loadprog'); if (el) el.value = p * 100; })
        .then(() => {
          const m = $('#loadmsg'); if (m) m.textContent = 'Scene loaded.';
          const b = $('#ready'); if (b) b.disabled = false;
          if (mine.length && state?.dub?.ready.includes(s.me.name)) markReady();
        })
        .catch((e) => { const m = $('#loadmsg'); if (m) m.textContent = e.message; });
      const b = $('#ready');
      if (b) {
        b.onclick = async () => {
          try {
            if (!dub.stream || !dub.stream.active) dub.stream = await getMic();
          } catch (e) { return toast(micError(e)); }
          socket.emit('player:dubReady');
          markReady();
        };
      }
    },

    dubrec(s) {
      const mine = new Set(s.me.roles);
      if (!mine.size) {
        app.innerHTML = shell(s, '<div class="center"><h2>Recording in progress</h2><p>The finished dub will play here soon.</p></div>');
        return;
      }
      if (s.dub.uploaded.includes(s.me.name)) {
        app.innerHTML = shell(s, '<div class="center"><p class="big">Take sent</p><p class="hint">Waiting for everyone else.</p></div>');
        return;
      }
      app.innerHTML = shell(s, '<div id="dubrec" class="dubwrap"><p class="hint center-text">Starting…</p></div>');
      runDubTake(mine);
    },

    dubview(s) {
      const performed = s.me.roles.length > 0;
      app.innerHTML = shell(s, `<div id="dubview" class="dubwrap"><p class="hint center-text">Putting the dub together…</p></div>
        ${performed ? '<div class="actions"><button id="dlMine" class="btn ghost">Download my voice</button></div>' : ''}`);
      const dl = $('#dlMine');
      if (dl) {
        dl.onclick = () => {
          const t = (dub.tracks || []).find((x) => x.name === s.me.name);
          if (!t) return toast('Your take did not make it into this dub.');
          download(t.url, `my-voice-${fileSafe(t.characters.join('-'))}.${extFor(t.mime)}`);
        };
      }
      showDubView();
    },
  };

  // ------------------------------------------------------------ scene (dub) helpers
  function clearDub() {
    Dub.stopRecording();
    dub.view?.destroy();
    if (dub.media) Dub.stopAll(dub.media);
    dub.stream?.getTracks().forEach((t) => t.stop());
    (dub.tracks || []).forEach((t) => URL.revokeObjectURL(t.url));
    dub = { packId: null, pack: null, media: null, loading: null, progress: null, tracks: null, view: null, stream: null };
  }

  // Runs on every screen change: stop whatever the previous screen was playing.
  function leaveDubScreen(s) {
    Dub.stopRecording();
    if (dub.view) { dub.view.destroy(); dub.view = null; }
    if (dub.media) Dub.stopAll(dub.media);
    if (s.phase === 'dubload' || s.phase === 'dubrec') {
      (dub.tracks || []).forEach((t) => URL.revokeObjectURL(t.url));
      dub.tracks = null;
    }
  }

  function ensureDubMedia(packId, onProgress) {
    dub.progress = onProgress;
    if (dub.packId !== packId) {
      if (dub.media) Dub.stopAll(dub.media);
      Object.assign(dub, { packId, pack: null, media: null });
      dub.loading = (async () => {
        dub.pack = await Dub.loadPack(packId);
        dub.media = await Dub.preload(dub.pack, (p) => dub.progress?.(p));
      })();
      dub.loading.catch(() => { if (dub.packId === packId) dub.packId = null; });
    } else if (dub.media) {
      onProgress?.(1);
    }
    return dub.loading;
  }

  async function showDubView() {
    if (!$('#dubview') || dub.view || !dub.tracks || !state?.dub) return;
    try {
      await ensureDubMedia(state.dub.packId);
    } catch (e) {
      const box = $('#dubview');
      if (box) box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      return;
    }
    const box = $('#dubview');
    if (!box || dub.view || state?.phase !== 'dubview') return;
    dub.view = Dub.playback({ pack: dub.pack, media: dub.media, tracks: dub.tracks, el: box });
  }

  async function runDubTake(mine) {
    const token = screenKey;
    const box = () => $('#dubrec');
    try {
      await ensureDubMedia(state.dub.packId);
      if (!dub.stream || !dub.stream.active) dub.stream = await getMic();
      if (screenKey !== token || !box()) return;
      const take = await Dub.record({ pack: dub.pack, media: dub.media, mine, stream: dub.stream, el: box() });
      if (screenKey !== token || !box()) return; // the host moved on before this finished
      box().innerHTML = '<p class="big center-text">Sending your take…</p>';
      const data = await take.blob.arrayBuffer();
      socket.timeout(30000).emit('player:dubTrack', { data, mime: take.mime, lead: take.lead }, (err, res) => {
        if (!box()) return;
        box().innerHTML = err || !res?.ok
          ? `<p class="error center-text">${esc(res?.error || 'Your take did not upload. Ask the host to record it again.')}</p>`
          : '<div class="center"><p class="big">Take sent</p><p class="hint">Waiting for everyone else.</p></div>';
      });
    } catch (e) {
      if (box()) box().innerHTML = `<p class="error center-text">${esc(e?.message === 'insecure' || e?.name ? micError(e) : e.message)}</p>`;
    }
  }

  const currentPack = () => packsCache.find((p) => p.id === $('#pack')?.value);

  function onPackChange() {
    const pack = currentPack();
    const isDub = pack?.type === 'dub';
    if (pack?.id !== lastPackId) { hostRoles = {}; touchedRoles = new Set(); }
    lastPackId = pack?.id || '';
    $('#roundsWrap').hidden = isDub;
    $('#roles').hidden = !isDub;
    rolesKey = '';
    if (state) renderRoles(state);
  }

  function renderRoles(s) {
    const box = $('#roles');
    const pack = currentPack();
    if (!box || !pack || pack.type !== 'dub') return;
    const names = s.players.filter((p) => p.connected).map((p) => p.name);
    const key = `${pack.id}|${names.join('\\u0000')}`;
    if (key === rolesKey) return;
    rolesKey = key;
    for (const c of pack.characters) {
      if (hostRoles[c] && !names.includes(hostRoles[c])) hostRoles[c] = '';
    }
    for (const c of pack.characters) {
      if (hostRoles[c] || touchedRoles.has(c)) continue;
      const taken = new Set(Object.values(hostRoles).filter(Boolean));
      hostRoles[c] = names.find((n) => !taken.has(n)) || '';
    }
    box.innerHTML = `<h3 class="rolehead">Roles</h3>${pack.characters.map((c) => `
      <label class="rolerow"><span>${esc(c)}</span><select data-role="${esc(c)}">
        <option value="">Original voice</option>
        ${names.map((n) => `<option value="${esc(n)}"${hostRoles[c] === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}
      </select></label>`).join('')}
      <p class="hint">One person can play several roles. Roles left on "Original voice" use the real line.</p>`;
    $$('[data-role]', box).forEach((sel) => {
      sel.onchange = () => { hostRoles[sel.dataset.role] = sel.value; touchedRoles.add(sel.dataset.role); };
    });
  }

  function castOf(s) {
    const byName = new Map();
    for (const [c, n] of Object.entries(s.dub.roles)) if (n) byName.set(n, [...(byName.get(n) || []), c]);
    return byName;
  }
  const allReady = (s) => { const cast = castOf(s); return cast.size > 0 && [...cast.keys()].every((n) => s.dub.ready.includes(n)); };

  function renderDubStatus(s) {
    const ul = $('#dubstatus');
    if (!ul || !s.dub) return;
    const cast = castOf(s);
    const loading = s.phase === 'dubload';
    ul.innerHTML = [...cast].map(([n, chars]) => {
      const p = s.players.find((x) => x.name === n);
      const done = loading ? s.dub.ready.includes(n) : s.dub.uploaded.includes(n);
      const label = loading ? (done ? 'Ready' : 'Getting ready') : (done ? 'Sent' : 'Recording');
      return `<li class="${p?.connected ? '' : 'off'}"><span class="pname">${esc(n)}</span>
        <span class="hint">${esc(chars.join(', '))}</span><span class="badge${done ? ' done' : ''}">${label}</span></li>`;
    }).join('');
    const originals = Object.entries(s.dub.roles).filter(([, n]) => !n).map(([c]) => c);
    const o = $('#dubOriginals');
    if (o) o.textContent = originals.length ? `Original voice: ${originals.join(', ')}` : '';
    const go = $('#go');
    if (go && loading) {
      const ready = [...cast.keys()].filter((n) => s.dub.ready.includes(n)).length;
      go.textContent = allReady(s) ? 'Roll camera' : `Roll camera (${ready} of ${cast.size} ready)`;
    }
  }
})();"""),
])
print("app patched")
