(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const extFor = (mime) => (/mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm');

  const S = { title: '', prompts: [], i: 0, takes: new Map() }; // takes: index -> { url, mime }
  const R = { rec: null, stream: null, chunks: [], url: null, mime: '', stopT: null, elapsedT: null, startAt: 0 };

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function getMic() {
    if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('insecure'));
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  }
  function micError(e) {
    if (e?.message === 'insecure') return 'Your mic only works over HTTPS. Open the https:// address instead.';
    if (e?.name === 'NotAllowedError') return 'Mic access was blocked. Allow it in your browser settings, then try again.';
    return 'No microphone was found on this device.';
  }

  function download(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function clearTakes() {
    S.takes.forEach((t) => URL.revokeObjectURL(t.url));
    S.takes.clear();
  }

  // ------------------------------------------------------------ setup
  async function renderSetup() {
    resetRec();
    clearTakes();
    app.innerHTML = `<main class="stage home">
      <h1 class="logo">Dub Club</h1>
      <p class="tag">Solo practice. Nobody's judging but you.</p>
      <div class="card join">
        <label>Pack<select id="pack"><option>Loading…</option></select></label>
        <label>Lines<select id="count">
          <option value="5">5 lines</option><option value="10">10 lines</option><option value="0">Every line</option>
        </select></label>
        <label class="check"><input id="shuffle" type="checkbox" checked> Shuffle the order</label>
        <button id="start" class="btn primary">Start practising</button>
      </div>
      <a class="btn ghost" href="/">Back to multiplayer</a>
    </main>`;
    try {
      const packs = await (await fetch('/api/packs')).json();
      $('#pack').innerHTML = packs.length
        ? packs.map((p) => `<option value="${esc(p.id)}">${esc(p.title)} (${p.count} lines)</option>`).join('')
        : '<option value="">No packs yet. Add one in Manage packs.</option>';
    } catch { toast('Packs failed to load. Check the server.'); }

    $('#start').onclick = async () => {
      const id = $('#pack').value;
      if (!id) return toast('Pick a pack first.');
      try {
        const pack = await (await fetch(`/api/packs/${encodeURIComponent(id)}`)).json();
        let prompts = [...pack.prompts];
        if ($('#shuffle').checked) prompts.sort(() => Math.random() - 0.5);
        const n = Number($('#count').value);
        if (n) prompts = prompts.slice(0, n);
        if (!prompts.length) return toast('That pack has no lines yet.');
        Object.assign(S, { title: pack.title, prompts, i: 0 });
        renderPrompt();
      } catch { toast('That pack failed to load.'); }
    };
  }

  // ------------------------------------------------------------ one line
  function renderPrompt() {
    resetRec();
    const p = S.prompts[S.i];
    const isVideo = p.mediaType === 'video';
    const media = isVideo
      ? `<video id="ref" class="ref" src="${esc(p.media)}" controls playsinline preload="auto"></video>`
      : p.mediaType === 'audio' ? `<audio id="ref" src="${esc(p.media)}" controls preload="auto"></audio>` : '';
    const last = S.i === S.prompts.length - 1;

    app.innerHTML = `<main class="stage host">
      <header class="bar">
        <h1 class="logo small">Dub Club</h1>
        <div class="round">Line ${S.i + 1} of ${S.prompts.length}</div>
        <button id="exit" class="btn ghost small">End session</button>
      </header>
      <div class="prompt">${media}
        ${p.text ? `<p class="line">${esc(p.text)}</p>` : ''}
        ${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
      </div>
      ${isVideo ? '<label class="check center-check"><input id="over" type="checkbox" checked> Play the clip muted while I record, so I can dub over it</label>' : ''}
      <div id="recorder" class="recorder"></div>
      <div class="actions">
        ${S.i > 0 ? '<button id="prev" class="btn ghost">Previous line</button>' : ''}
        <button id="skip" class="btn ghost">${last ? 'Finish' : 'Skip this line'}</button>
      </div>
    </main>`;

    $('#exit').onclick = renderDone;
    $('#skip').onclick = () => go(1);
    if ($('#prev')) $('#prev').onclick = () => go(-1);
    drawRecorder(S.takes.has(S.i) ? 'saved' : 'idle');
  }

  function go(step) {
    const next = S.i + step;
    if (next >= S.prompts.length) return renderDone();
    S.i = Math.max(0, next);
    renderPrompt();
  }

  const ref = () => $('#ref');
  const overClip = () => $('#over')?.checked && ref()?.tagName === 'VIDEO';

  function stopRef() {
    const v = ref();
    if (!v) return;
    v.pause();
    v.muted = false;
    v.onended = null;
  }

  // ------------------------------------------------------------ recorder
  function resetRec() {
    if (R.rec && R.rec.state !== 'inactive') { R.rec.onstop = null; R.rec.stop(); }
    R.stream?.getTracks().forEach((t) => t.stop());
    clearTimeout(R.stopT);
    clearInterval(R.elapsedT);
    // R.url is owned by S.takes once kept; only revoke unkept takes
    if (R.url && ![...S.takes.values()].some((t) => t.url === R.url)) URL.revokeObjectURL(R.url);
    Object.assign(R, { rec: null, stream: null, chunks: [], url: null, mime: '' });
  }

  function drawRecorder(mode, msg = '') {
    const el = $('#recorder');
    if (!el) return;
    const p = S.prompts[S.i];
    const isVideo = p.mediaType === 'video';
    const kept = S.takes.get(S.i);
    const url = mode === 'saved' ? kept?.url : R.url;
    const mime = mode === 'saved' ? kept?.mime : R.mime;
    const last = S.i === S.prompts.length - 1;

    const listenTools = `<audio id="mine" src="${url}" controls></audio>
      <div class="row">
        ${isVideo ? '<button id="watch" class="btn">Watch with my voice</button>' : ''}
        ${p.media ? '<button id="orig" class="btn ghost">Play the original</button>' : ''}
        <button id="dl" class="btn ghost">Download</button>
      </div>`;

    const views = {
      idle: `<button id="recBtn" class="recbtn">Record</button>
        <p class="hint">${esc(msg) || (isVideo ? 'The clip starts when you hit record.' : `Up to ${p.recordSeconds} seconds.`)}</p>`,
      recording: `<button id="stopBtn" class="recbtn live">Stop</button><p class="hint"><span id="elapsed">0.0</span> seconds</p>`,
      review: `${listenTools}
        <div class="row"><button id="redo" class="btn ghost">Record again</button>
        <button id="keep" class="btn primary">${last ? 'Keep it and finish' : 'Keep it, next line'}</button></div>`,
      saved: `<p class="big">Take kept</p>${listenTools}
        <div class="row"><button id="redo" class="btn ghost">Record it again</button>
        <button id="next" class="btn primary">${last ? 'Finish' : 'Next line'}</button></div>`,
    };
    el.innerHTML = views[mode];

    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('#recBtn', startRec);
    on('#stopBtn', stopRec);
    on('#redo', () => { stopRef(); resetRec(); drawRecorder('idle'); });
    on('#keep', () => {
      stopRef();
      const old = S.takes.get(S.i);
      if (old && old.url !== R.url) URL.revokeObjectURL(old.url);
      S.takes.set(S.i, { url: R.url, mime: R.mime });
      R.url = null;
      go(1);
    });
    on('#next', () => { stopRef(); go(1); });
    on('#dl', () => download(url, `line${S.i + 1}-take.${extFor(mime)}`));
    on('#orig', () => {
      const v = ref();
      $('#mine').pause();
      v.muted = false;
      v.currentTime = 0;
      v.play();
    });
    on('#watch', () => {
      const v = ref();
      const mine = $('#mine');
      v.muted = true;
      v.currentTime = 0;
      mine.currentTime = 0;
      v.onended = () => { v.muted = false; v.onended = null; };
      Promise.all([v.play(), mine.play()]).catch(() => toast('Playback was blocked. Click once on the page and try again.'));
    });
  }

  async function startRec() {
    resetRec();
    try { R.stream = await getMic(); } catch (e) { return drawRecorder('idle', micError(e)); }
    if (!window.MediaRecorder) { resetRec(); return drawRecorder('idle', 'This browser cannot record audio. Try Chrome or Edge.'); }

    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
      .find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
    const rec = new MediaRecorder(R.stream, mime ? { mimeType: mime } : undefined);
    R.rec = rec;
    R.chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) R.chunks.push(e.data); };
    rec.onstop = () => {
      clearTimeout(R.stopT);
      clearInterval(R.elapsedT);
      stopRef();
      R.stream?.getTracks().forEach((t) => t.stop());
      R.mime = rec.mimeType || mime || 'audio/webm';
      R.url = URL.createObjectURL(new Blob(R.chunks, { type: R.mime }));
      drawRecorder('review');
    };

    const p = S.prompts[S.i];
    let limit = p.recordSeconds;
    const v = ref();
    if (overClip()) {
      v.muted = true;
      v.currentTime = 0;
      v.onended = stopRec;
      if (Number.isFinite(v.duration) && v.duration > 0) limit = Math.min(v.duration + 0.5, 60);
    }

    rec.start(250);
    if (overClip()) v.play().catch(() => {});
    R.startAt = performance.now();
    drawRecorder('recording');
    R.elapsedT = setInterval(() => {
      const e = $('#elapsed');
      if (e) e.textContent = ((performance.now() - R.startAt) / 1000).toFixed(1);
    }, 100);
    R.stopT = setTimeout(stopRec, limit * 1000);
  }

  function stopRec() { if (R.rec && R.rec.state !== 'inactive') R.rec.stop(); }

  // ------------------------------------------------------------ summary
  function renderDone() {
    stopRef();
    resetRec();
    const rows = [...S.takes.entries()].sort((a, b) => a[0] - b[0]);
    app.innerHTML = `<main class="stage host">
      <header class="bar"><h1 class="logo small">Dub Club</h1><div class="round">${esc(S.title)}</div><span></span></header>
      <h2 class="phase">${rows.length ? 'Your takes' : 'No takes kept'}</h2>
      <ol class="results">${rows.map(([i, t]) => `
        <li><span class="tn">Line ${i + 1}</span><b>${esc(S.prompts[i].text || S.prompts[i].file || 'Clip')}</b><span></span>
          <div class="rtake"><audio src="${t.url}" controls></audio>
            <button class="btn small" data-dl="${i}">Download</button></div></li>`).join('')}</ol>
      <div class="actions">
        ${rows.length ? '<button id="dlAll" class="btn">Download all takes</button>' : ''}
        <button id="again" class="btn primary">Practise again</button>
      </div>
    </main>`;
    const fileFor = (i) => { const t = S.takes.get(i); return [t.url, `line${i + 1}-take.${extFor(t.mime)}`]; };
    $$('[data-dl]').forEach((b) => { b.onclick = () => download(...fileFor(Number(b.dataset.dl))); });
    if ($('#dlAll')) {
      $('#dlAll').onclick = () => rows.forEach(([i], n) => setTimeout(() => download(...fileFor(i)), n * 400));
    }
    $('#again').onclick = renderSetup;
  }

  renderSetup();
})();
