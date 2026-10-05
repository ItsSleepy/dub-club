(() => {
  'use strict';

  const socket = io();
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const params = new URLSearchParams(location.search);

  const pid = localStorage.getItem('dub.pid') ||
    (self.crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  localStorage.setItem('dub.pid', pid);

  let state = null;
  let screenKey = null;
  let localDeadline = null;
  let tick = null;
  let takes = []; // host only: [{ n, url }]
  // scene (dub) mode
  let dub = { packId: null, pack: null, media: null, loading: null, progress: null, tracks: null, view: null, stream: null };
  let packsCache = [];
  let hostRoles = {};
  let touchedRoles = new Set();
  let rolesKey = '';
  let lastPackId = '';

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // ------------------------------------------------------------ session
  const store = (key) => ({
    get: () => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } },
    set: (v) => (v ? sessionStorage.setItem(key, JSON.stringify(v)) : sessionStorage.removeItem(key)),
  });
  const hostSession = store('dub.host');
  const playerSession = store('dub.player');

  socket.on('connect', () => {
    const h = hostSession.get();
    const p = playerSession.get();
    if (h) {
      socket.emit('host:resume', h, (res) => { if (!res?.ok) { hostSession.set(null); renderHome(res?.error); } });
    } else if (p) {
      socket.emit('player:join', { ...p, pid }, (res) => { if (!res?.ok) { playerSession.set(null); renderHome(res?.error); } });
    } else {
      renderHome();
    }
  });

  socket.on('disconnect', () => toast('Connection lost. Reconnecting…'));
  socket.on('kicked', (msg) => {
    hostSession.set(null);
    playerSession.set(null);
    resetRec();
    clearDub();
    renderHome(msg);
  });
  socket.on('state', (s) => { state = s; render(); });
  socket.on('takes', (list) => {
    takes.forEach((t) => URL.revokeObjectURL(t.url));
    takes = list.map((t) => ({ n: t.n, mime: t.mime, url: URL.createObjectURL(new Blob([t.data], { type: t.mime })) }));
    renderTakes();
    if (state?.role === 'host' && state.phase === 'results') HOST.results(state);
  });

  socket.on('dubtracks', (list) => {
    (dub.tracks || []).forEach((t) => URL.revokeObjectURL(t.url));
    dub.tracks = list.map((t) => ({
      name: t.name, characters: t.characters, lead: t.lead, mime: t.mime,
      url: URL.createObjectURL(new Blob([t.data], { type: t.mime })),
    }));
    if (state?.phase === 'dubview') showDubView();
  });

  // ------------------------------------------------------------ downloads
  const extFor = (mime) => (/mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm');
  const fileSafe = (s) => String(s).trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'player';
  function download(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ------------------------------------------------------------ shared bits
  const logo = (small) => `<h1 class="logo${small ? ' small' : ''}">Dub Club</h1>`;

  function promptBlock(p, withMedia) {
    if (!p) return '';
    let media = '';
    if (withMedia && p.media) {
      if (p.mediaType === 'video') media = `<video id="ref" class="ref" src="${esc(p.media)}" controls playsinline></video>`;
      else if (p.mediaType === 'audio') {
        media = `${p.image ? `<img class="ref" src="${esc(p.image)}" alt="">` : ''}<audio id="ref" src="${esc(p.media)}" controls></audio>`;
      }
    }
    return `<div class="prompt">${media}
      ${p.text ? `<p class="line">${esc(p.text)}</p>` : ''}
      ${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}</div>`;
  }

  function startTick() {
    const f = () => {
      const el = $('#timer');
      if (!el || !localDeadline) return;
      const ms = Math.max(0, localDeadline - Date.now());
      el.textContent = Math.ceil(ms / 1000);
      el.classList.toggle('low', ms < 10000);
    };
    f();
    tick = setInterval(f, 250);
  }
  const stopTick = () => { clearInterval(tick); tick = null; };

  function getMic() {
    if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('insecure'));
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  }
  function micError(e) {
    if (e?.message === 'insecure') return 'Your mic only works over HTTPS. Open the https:// address instead.';
    if (e?.name === 'NotAllowedError') return 'Mic access was blocked. Allow it in your browser settings, then try again.';
    return 'No microphone was found on this device.';
  }

  // ------------------------------------------------------------ home
  function renderHome(err) {
    state = null;
    screenKey = null;
    stopTick();
    const code = params.get('room') || '';
    app.innerHTML = `
      <main class="stage home">
        ${logo()}
        <p class="tag">Hear a line. Perform it. Let your friends judge.</p>
        <form id="joinForm" class="card join">
          <label>Room code<input id="code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(code)}" required></label>
          <label>Your name<input id="name" maxlength="16" autocomplete="nickname" value="${esc(localStorage.getItem('dub.name') || '')}" required></label>
          <button class="btn primary">Join room</button>
          ${err ? `<p class="error">${esc(err)}</p>` : ''}
        </form>
        <button id="hostBtn" class="btn ghost">Host a room on this screen</button>
        <nav class="homelinks"><a href="/solo.html">Practise solo</a><a href="/manage.html">Manage packs</a></nav>
      </main>`;

    $('#joinForm').onsubmit = (e) => {
      e.preventDefault();
      const codeVal = $('#code').value.trim().toUpperCase();
      const name = $('#name').value.trim();
      localStorage.setItem('dub.name', name);
      socket.emit('player:join', { code: codeVal, name, pid }, (res) => {
        if (!res?.ok) return renderHome(res?.error || 'Could not join that room.');
        playerSession.set({ code: res.code, name: res.name });
      });
    };
    $('#hostBtn').onclick = () => socket.emit('host:create', (res) => {
      if (res?.ok) hostSession.set({ code: res.code, hostKey: res.hostKey });
    });
  }

  // ------------------------------------------------------------ render loop
  function render() {
    const s = state;
    if (!s) return;
    const key = `${s.role}|${s.phase}|${s.round}`;
    if (key !== screenKey) {
      screenKey = key;
      localDeadline = s.remainingMs != null ? Date.now() + s.remainingMs : null;
      stopTick();
      leaveDubScreen(s);
      if (s.role === 'player' && s.phase !== 'record') resetRec();
      (s.role === 'host' ? HOST : PLAYER)[s.phase]?.(s);
      const leave = $('#leaveRoom');
      if (leave) leave.onclick = leaveRoom;
      if (localDeadline) startTick();
    }
    update(s);
  }

  function leaveRoom() {
    const isHost = state?.role === 'host';
    const msg = isHost
      ? 'Close this room? Everyone in it will be sent back to the start screen.'
      : 'Leave this room? You can rejoin with the same code and name.';
    if (!confirm(msg)) return;
    socket.emit(isHost ? 'host:close' : 'player:leave');
    hostSession.set(null);
    playerSession.set(null);
    resetRec();
    clearDub();
    renderHome();
  }

  function update(s) {
    if (s.role === 'host') {
      renderPlayers(s);
      if (s.phase === 'lobby') renderRoles(s);
      if (s.phase === 'dubload' || s.phase === 'dubrec') renderDubStatus(s);
      return;
    }
    if (s.phase === 'vote' && s.me.voted) {
      const v = $('#votes'); if (v) v.hidden = true;
      const d = $('#voted'); if (d) d.hidden = false;
    }
  }

  // ------------------------------------------------------------ host
  const hostBar = (s) => `
    <header class="bar">
      ${logo(true)}
      <div class="round">${s.phase === 'lobby' || s.phase === 'final' ? '' : `Round ${s.round} of ${s.totalRounds}`}</div>
      <div class="roomcode">Room <b class="code">${esc(s.code)}</b>
        <button id="leaveRoom" class="btn ghost small">Close room</button></div>
    </header>`;

  function renderPlayers(s) {
    const ul = $('#players');
    if (!ul) return;
    const list = s.phase === 'lobby' ? s.players : [...s.players].sort((a, b) => b.score - a.score);
    ul.innerHTML = list.map((p) => {
      let badge = '';
      if (s.phase === 'record') badge = p.submitted ? 'Sent' : 'Recording';
      else if (s.phase === 'vote') badge = p.voted ? 'Voted' : 'Deciding';
      const done = (s.phase === 'record' && p.submitted) || (s.phase === 'vote' && p.voted);
      return `<li class="${p.connected ? '' : 'off'}">
        <span class="pname">${esc(p.name)}${p.connected ? '' : ' (away)'}</span>
        ${badge ? `<span class="badge${done ? ' done' : ''}">${badge}</span>` : ''}
        ${s.phase === 'lobby' ? '' : `<span class="pscore">${p.score}</span>`}
        ${s.phase === 'lobby' && !p.connected ? `<button class="x" data-kick="${esc(p.name)}" aria-label="Remove ${esc(p.name)}">Remove</button>` : ''}
      </li>`;
    }).join('') || '<li class="empty">Nobody here yet. Share the room code.</li>';
    $$('[data-kick]', ul).forEach((b) => { b.onclick = () => socket.emit('host:kick', { name: b.dataset.kick }); });
  }

  function renderTakes() {
    const el = $('#takes');
    if (!el) return;
    el.innerHTML = takes.length
      ? takes.map((t) => `<div class="take"><span class="tnum">Take ${t.n}</span><audio src="${t.url}" controls preload="auto"></audio></div>`).join('')
      : '<p class="hint">No takes came in this round.</p>';
  }

  function stopAll() {
    $$('#takes audio').forEach((a) => { a.pause(); a.onended = null; a.closest('.take')?.classList.remove('playing'); });
  }
  function playAll() {
    stopAll();
    const auds = $$('#takes audio');
    let i = 0;
    const next = () => {
      if (i >= auds.length) return;
      const a = auds[i++];
      const box = a.closest('.take');
      box.classList.add('playing');
      a.onended = () => { box.classList.remove('playing'); a.onended = null; next(); };
      a.currentTime = 0;
      a.play().catch(() => { box.classList.remove('playing'); next(); });
    };
    next();
  }

  const HOST = {
    lobby(s) {
      takes = [];
      clearDub();
      rolesKey = '';
      app.innerHTML = `<main class="stage host">${hostBar(s)}
        <section class="marquee">
          <p>Join on your phone at <b>${esc(location.host)}</b></p>
          <div class="sign"><span class="bigcode">${esc(s.code)}</span></div>
        </section>
        <section class="grid2">
          <div class="card"><h2>Players</h2><ul id="players" class="players"></ul></div>
          <div class="card"><h2>Game setup</h2>
            <label>Pack<select id="pack"><option>Loading…</option></select></label>
            <label id="roundsWrap">Rounds<input id="rounds" type="number" min="1" max="20" value="5"></label>
            <div id="roles" class="rolepick" hidden></div>
            <button id="start" class="btn primary">Start game</button>
          </div>
        </section></main>`;
      fetch('/api/packs').then((r) => r.json()).then((packs) => {
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
      };
    },

    listen(s) {
      takes = [];
      app.innerHTML = `<main class="stage host">${hostBar(s)}
        <h2 class="phase">Listen closely</h2>
        ${promptBlock(s.prompt, true)}
        <div class="actions"><button id="go" class="btn primary">Start recording</button></div></main>`;
      const ref = $('#ref');
      ref?.play().catch(() => {});
      $('#go').onclick = () => { ref?.pause(); socket.emit('host:record'); };
    },

    record(s) {
      app.innerHTML = `<main class="stage host">${hostBar(s)}
        <div class="timer" id="timer"></div>
        <h2 class="phase">Record on your phones</h2>
        ${promptBlock(s.prompt, true)}
        <div class="card narrow"><ul id="players" class="players"></ul></div>
        <div class="actions"><button id="end" class="btn ghost">End recording now</button></div></main>`;
      $('#end').onclick = () => socket.emit('host:endRecording');
    },

    playback(s) {
      app.innerHTML = `<main class="stage host">${hostBar(s)}
        <h2 class="phase">The takes</h2>
        ${promptBlock(s.prompt, false)}
        <div id="takes" class="takes"></div>
        <div class="actions">
          <button id="playAll" class="btn">Play all takes</button>
          <button id="vote" class="btn primary">Open voting</button>
        </div></main>`;
      renderTakes();
      $('#playAll').onclick = playAll;
      $('#vote').onclick = () => { stopAll(); socket.emit('host:vote'); };
    },

    vote(s) {
      app.innerHTML = `<main class="stage host">${hostBar(s)}
        <h2 class="phase">Vote on your phones</h2>
        <div id="takes" class="takes"></div>
        <div class="card narrow"><ul id="players" class="players"></ul></div>
        <div class="actions"><button id="end" class="btn ghost">Close voting</button></div></main>`;
      renderTakes();
      $('#end').onclick = () => socket.emit('host:endVoting');
    },

    results(s) {
      const r = [...(s.results || [])].sort((a, b) => b.votes - a.votes);
      const last = s.round >= s.totalRounds;
      const fileFor = (x) => {
        const t = takes.find((t) => t.n === x.n);
        return t && { url: t.url, name: `round${s.round}-${fileSafe(x.name)}.${extFor(t.mime)}` };
      };
      app.innerHTML = `<main class="stage host">${hostBar(s)}
        <h2 class="phase">Round ${s.round} results</h2>
        <ol class="results">${r.map((x, i) => {
          const f = fileFor(x);
          return `<li class="${i === 0 && x.votes > 0 ? 'win' : ''}">
            <span class="tn">Take ${x.n}</span><b>${esc(x.name)}</b>
            <span>${x.votes} vote${x.votes === 1 ? '' : 's'}, +${x.votes * 100}</span>
            ${f ? `<div class="rtake"><audio src="${f.url}" controls></audio>
              <button class="btn small" data-dl="${esc(f.url)}" data-name="${esc(f.name)}">Download</button></div>` : ''}
          </li>`;
        }).join('') || '<li class="empty">No takes this round.</li>'}</ol>
        <div class="card narrow"><h2>Scores</h2><ul id="players" class="players"></ul></div>
        <div class="actions">
          ${takes.length ? '<button id="dlAll" class="btn">Download all takes</button>' : ''}
          <button id="next" class="btn primary">${last ? 'See final scores' : 'Next round'}</button>
        </div></main>`;
      renderPlayers(s);
      $$('[data-dl]').forEach((b) => { b.onclick = () => download(b.dataset.dl, b.dataset.name); });
      const all = $('#dlAll');
      if (all) {
        all.onclick = () => $$('[data-dl]').forEach((b, i) => setTimeout(() => download(b.dataset.dl, b.dataset.name), i * 400));
      }
      $('#next').onclick = () => socket.emit('host:next');
    },

    final(s) {
      const sorted = [...s.players].sort((a, b) => b.score - a.score);
      app.innerHTML = `<main class="stage host">${hostBar(s)}
        <h2 class="phase">Final scores</h2>
        <ol class="results podium">${sorted.map((p, i) => `
          <li class="${i === 0 ? 'win' : ''}"><span class="tn">${i + 1}</span><b>${esc(p.name)}</b><span class="pts">${p.score}</span></li>`).join('')}</ol>
        <div class="actions"><button id="again" class="btn primary">Back to lobby</button></div></main>`;
      $('#again').onclick = () => socket.emit('host:lobby');
    },

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

  // ------------------------------------------------------------ recorder (players)
  const R = { rec: null, stream: null, chunks: [], blob: null, url: null, mime: '', stopT: null, elapsedT: null, startAt: 0 };

  function resetRec() {
    if (R.rec && R.rec.state !== 'inactive') { R.rec.onstop = null; R.rec.stop(); }
    R.stream?.getTracks().forEach((t) => t.stop());
    clearTimeout(R.stopT);
    clearInterval(R.elapsedT);
    if (R.url) URL.revokeObjectURL(R.url);
    Object.assign(R, { rec: null, stream: null, chunks: [], blob: null, url: null, mime: '' });
  }

  function drawRecorder(mode, msg = '') {
    const el = $('#recorder');
    if (!el) return;
    const max = state?.prompt?.recordSeconds || 15;
    const dl = R.url
      ? `<a class="btn ghost small" href="${R.url}" download="my-take-round${state?.round || 1}.${extFor(R.mime)}">Download my take</a>`
      : '';
    const views = {
      idle: `<button id="recBtn" class="recbtn">Record</button><p class="hint">${esc(msg) || `Tap to record, up to ${max} seconds.`}</p>`,
      recording: `<button id="stopBtn" class="recbtn live">Stop</button><p class="hint"><span id="elapsed">0.0</span> of ${max} seconds</p>`,
      review: `<audio src="${R.url}" controls></audio>
        <div class="row"><button id="redo" class="btn ghost">Record again</button><button id="send" class="btn primary">Submit take</button></div>
        ${dl}
        ${msg ? `<p class="error">${esc(msg)}</p>` : ''}`,
      sending: '<p class="big">Submitting take…</p>',
      done: `<p class="big">Take submitted</p><p class="hint">Waiting for everyone else.</p>${dl}`,
    };
    el.innerHTML = views[mode];
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('#recBtn', () => startRec(max));
    on('#stopBtn', stopRec);
    on('#redo', () => { resetRec(); drawRecorder('idle'); });
    on('#send', submitTake);
  }

  async function startRec(max) {
    resetRec();
    try { R.stream = await getMic(); } catch (e) { return drawRecorder('idle', micError(e)); }
    if (!window.MediaRecorder) { resetRec(); return drawRecorder('idle', 'This browser cannot record audio. Try Chrome or Safari.'); }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
      .find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
    const rec = new MediaRecorder(R.stream, mime ? { mimeType: mime } : undefined);
    R.rec = rec;
    R.chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) R.chunks.push(e.data); };
    rec.onstop = () => {
      clearTimeout(R.stopT);
      clearInterval(R.elapsedT);
      R.stream?.getTracks().forEach((t) => t.stop());
      R.mime = rec.mimeType || mime || 'audio/webm';
      R.blob = new Blob(R.chunks, { type: R.mime });
      R.url = URL.createObjectURL(R.blob);
      if (state?.phase === 'record' && !state.me.submitted) drawRecorder('review');
    };
    rec.start(250);
    R.startAt = performance.now();
    drawRecorder('recording');
    R.elapsedT = setInterval(() => {
      const e = $('#elapsed');
      if (e) e.textContent = ((performance.now() - R.startAt) / 1000).toFixed(1);
    }, 100);
    R.stopT = setTimeout(stopRec, max * 1000);
  }

  function stopRec() { if (R.rec && R.rec.state !== 'inactive') R.rec.stop(); }

  async function submitTake() {
    if (!R.blob) return;
    drawRecorder('sending');
    const data = await R.blob.arrayBuffer();
    socket.timeout(20000).emit('player:take', { data, mime: R.mime }, (err, res) => {
      if (err || !res?.ok) return drawRecorder('review', res?.error || 'The upload timed out. Submit again.');
      drawRecorder('done');
    });
  }

  // ------------------------------------------------------------ player screens
  const shell = (s, inner) => `<main class="stage phone">
    <header class="pbar">${logo(true)}<span>${esc(s.me.name)}, ${s.me.score} pts</span>
      <button id="leaveRoom" class="btn ghost small">Leave</button></header>${inner}</main>`;

  const PLAYER = {
    lobby(s) {
      clearDub();
      app.innerHTML = shell(s, `<div class="center">
        <h2>You're in</h2><p>The host will start the game from the big screen.</p>
        <button id="mic" class="btn">Test my mic</button><p id="micmsg" class="hint"></p></div>`);
      $('#mic').onclick = async () => {
        try {
          const st = await getMic();
          st.getTracks().forEach((t) => t.stop());
          $('#micmsg').textContent = 'Your mic is ready.';
        } catch (e) { $('#micmsg').textContent = micError(e); }
      };
    },
    listen(s) {
      app.innerHTML = shell(s, `<div class="center"><h2>Watch the big screen</h2>${promptBlock(s.prompt, false)}</div>`);
    },
    record(s) {
      app.innerHTML = shell(s, `<div class="center">
        <div class="timer small" id="timer"></div>
        ${promptBlock(s.prompt, false)}
        <div id="recorder" class="recorder"></div></div>`);
      drawRecorder(s.me.submitted ? 'done' : 'idle');
    },
    playback(s) {
      app.innerHTML = shell(s, `<div class="center"><h2>Listen to the takes</h2><p>Takes are anonymous, so keep a straight face.</p></div>`);
    },
    vote(s) {
      const opts = Array.from({ length: s.takeCount }, (_, i) => i + 1).filter((n) => n !== s.me.myTake);
      app.innerHTML = shell(s, `<div class="center">
        <h2>Which take was best?</h2>
        <div id="votes" class="votes">${opts.map((n) => `<button class="btn vote" data-n="${n}">Take ${n}</button>`).join('') ||
          '<p class="hint">There is nothing to vote on this round.</p>'}</div>
        <p id="voted" class="big" hidden>Vote locked in</p>
        ${s.me.myTake ? `<p class="hint">Yours was take ${s.me.myTake}.</p>` : ''}</div>`);
      $$('.vote').forEach((b) => {
        b.onclick = () => socket.emit('player:vote', { n: Number(b.dataset.n) },
          (res) => { if (!res?.ok) toast(res?.error || 'Your vote did not go through.'); });
      });
    },
    results(s) {
      const mine = s.results?.find((r) => r.n === s.me.myTake);
      app.innerHTML = shell(s, `<div class="center">
        ${mine ? `<p class="bignum">+${mine.votes * 100}</p><p>Your take got ${mine.votes} vote${mine.votes === 1 ? '' : 's'}.</p>`
               : '<h2>You sat this one out</h2>'}
        <p class="hint">Total: ${s.me.score} points</p></div>`);
    },
    final(s) {
      const rank = [...s.players].sort((a, b) => b.score - a.score).findIndex((p) => p.name === s.me.name) + 1;
      app.innerHTML = shell(s, `<div class="center">
        <p class="bignum">#${rank}</p><p>You finished with ${s.me.score} points.</p></div>`);
    },

    dubload(s) {
      const mine = s.me.roles;
      app.innerHTML = shell(s, `<div class="center">
        <h2>${mine.length ? `You're playing ${esc(mine.join(' and '))}` : "You're watching this one"}</h2>
        <p>${mine.length ? 'Put your headphones on. Your lines light up on screen as the scene plays.'
          : 'The finished dub will play here when the others are done.'}</p>
        <progress id="loadprog" max="100" value="0"></progress>
        <p id="loadmsg" class="hint">Loading the scene…</p>
        ${mine.length ? '<button id="ready" class="btn primary" disabled>I\'m ready</button>' : ''}
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
    const key = `${pack.id}|${names.join('\u0000')}`;
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
})();
