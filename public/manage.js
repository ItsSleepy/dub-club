(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const MAX_MB = 19;

  let key = localStorage.getItem('dub.uploadKey') || '';
  let current = null; // selected pack id

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, 3500);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'x-upload-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { lock('That upload key is wrong.'); throw new Error('locked'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong on the server.');
    return data;
  }

  // ------------------------------------------------------------ unlock
  function lock(err) {
    key = '';
    localStorage.removeItem('dub.uploadKey');
    renderLock(err);
  }

  function renderLock(err) {
    app.innerHTML = `<main class="stage home">
      <h1 class="logo">Dub Club</h1>
      <p class="tag">Manage packs</p>
      <form id="unlock" class="card join">
        <label>Upload key<input id="key" type="password" autocomplete="current-password" required></label>
        <button class="btn primary">Unlock</button>
        ${err ? `<p class="error">${esc(err)}</p>` : ''}
      </form>
      <a class="btn ghost" href="/">Back to the game</a>
    </main>`;
    $('#unlock').onsubmit = async (e) => {
      e.preventDefault();
      key = $('#key').value.trim();
      try {
        await api('POST', '/api/auth');
        localStorage.setItem('dub.uploadKey', key);
        renderManager();
      } catch (ex) { if (ex.message !== 'locked') renderLock(ex.message); }
    };
  }

  // ------------------------------------------------------------ manager
  async function renderManager() {
    app.innerHTML = `<main class="stage host">
      <header class="bar">
        <h1 class="logo small">Dub Club</h1>
        <div class="round">Manage packs</div>
        <div class="row-inline"><a class="btn ghost small" href="/">Game</a><a class="btn ghost small" href="/solo.html">Practise solo</a></div>
      </header>
      <section class="manage">
        <div class="stack">
        <div class="card">
          <h2>Packs</h2>
          <ul id="packs" class="players packlist"></ul>
          <form id="newPack" class="stack">
            <label>New pack<input id="packTitle" maxlength="60" placeholder="e.g. Friday night clips" required></label>
            <button class="btn">Create pack</button>
          </form>
        </div>
        <div class="card">
          <h2>Import packs</h2>
          <p class="hint">Choicer Voicer pack zips, like the ones on GameBanana. Scenes and voice-line packs both work. Pick as many as you like.</p>
          <input id="zips" type="file" accept=".zip,application/zip" multiple>
          <button id="importBtn" class="btn primary">Import</button>
          <ul id="uploads" class="jobs"></ul>
          <div id="inbox"></div>
          <ul id="jobs" class="jobs"></ul>
        </div>
        </div>
        <div class="card" id="editor"><p class="hint">Pick a pack on the left, or create one.</p></div>
      </section>
    </main>`;
    $('#newPack').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const { id } = await api('POST', '/api/packs', { title: $('#packTitle').value });
        current = id;
        $('#packTitle').value = '';
        await refresh();
      } catch (ex) { if (ex.message !== 'locked') toast(ex.message); }
    };
    await refresh();
    setupImports();
  }

  async function refresh() {
    const packs = await (await fetch('/api/packs?all=1')).json();
    const ul = $('#packs');
    ul.innerHTML = packs.map((p) => `
      <li class="${p.id === current ? 'active' : ''}"><button class="packbtn" data-id="${esc(p.id)}">
        <span class="pname">${esc(p.title)}</span>${p.type === 'dub' ? '<span class="badge">Scene</span>' : ''}<span class="badge">${p.count} line${p.count === 1 ? '' : 's'}</span></button></li>`).join('')
      || '<li class="empty">No packs yet.</li>';
    $$('.packbtn', ul).forEach((b) => { b.onclick = () => { current = b.dataset.id; refresh(); }; });
    if (current && packs.some((p) => p.id === current)) await renderEditor(current);
    else { current = null; $('#editor').innerHTML = '<p class="hint">Pick a pack on the left, or create one.</p>'; }
  }

  async function renderEditor(id) {
    const pack = await (await fetch(`/api/packs/${encodeURIComponent(id)}`)).json();
    const ed = $('#editor');
    if (pack.type === 'dub') return renderSceneInfo(pack, id, ed);
    ed.innerHTML = `
      <div class="edhead"><h2>${esc(pack.title)}</h2><button id="delPack" class="btn ghost small">Delete pack</button></div>
      <ol class="lines">${pack.prompts.map((p, i) => `
        <li>
          <div class="lmedia">${p.mediaType === 'video' ? `<video src="${esc(p.media)}" preload="metadata" controls playsinline></video>`
            : p.mediaType === 'audio' ? `<audio src="${esc(p.media)}" preload="none" controls></audio>` : '<span class="hint">Text only</span>'}</div>
          <div class="ltext">${p.text ? `<b>${esc(p.text)}</b>` : ''}${p.note ? `<span class="hint">${esc(p.note)}</span>` : ''}
            <span class="hint">${p.recordSeconds}s to record</span></div>
          <button class="x" data-del="${i}">Remove</button>
        </li>`).join('') || '<li class="empty hint">No lines yet. Add the first one below.</li>'}</ol>

      <form id="addLine" class="stack addline">
        <h2>Add a line</h2>
        <label>Clip (optional, video or audio, up to ${MAX_MB} MB)<input id="file" type="file" accept="video/*,audio/*"></label>
        <label>Line to perform<input id="text" maxlength="200" placeholder="&quot;We ride at dawn!&quot;"></label>
        <label>Direction (optional)<input id="note" maxlength="120" placeholder="as an extremely tired knight"></label>
        <label>Seconds to record<input id="secs" type="number" min="3" max="45" value="15"></label>
        <progress id="prog" max="100" value="0" hidden></progress>
        <button id="addBtn" class="btn primary">Add line</button>
      </form>`;

    $('#delPack').onclick = async () => {
      if (!confirm(`Delete "${pack.title}" and all of its clips? This can't be undone.`)) return;
      try { await api('DELETE', `/api/packs/${encodeURIComponent(id)}`); current = null; refresh(); }
      catch (ex) { if (ex.message !== 'locked') toast(ex.message); }
    };
    $$('[data-del]', ed).forEach((b) => {
      b.onclick = async () => {
        try { await api('DELETE', `/api/packs/${encodeURIComponent(id)}/prompts/${b.dataset.del}`); refresh(); }
        catch (ex) { if (ex.message !== 'locked') toast(ex.message); }
      };
    });

    $('#file').onchange = () => {
      const f = $('#file').files[0];
      if (f && f.size > MAX_MB * 1024 * 1024) { toast(`That file is over ${MAX_MB} MB. Trim or compress it first.`); $('#file').value = ''; }
    };

    $('#addLine').onsubmit = (e) => {
      e.preventDefault();
      const f = $('#file').files[0];
      const text = $('#text').value.trim();
      if (!f && !text) return toast('Add a line, a clip, or both.');
      const fd = new FormData();
      fd.append('text', text);
      fd.append('note', $('#note').value.trim());
      fd.append('recordSeconds', $('#secs').value);
      if (f) fd.append('media', f);

      // XHR rather than fetch so the upload can show progress
      const xhr = new XMLHttpRequest();
      const prog = $('#prog');
      const btn = $('#addBtn');
      xhr.open('POST', `/api/packs/${encodeURIComponent(id)}/prompts`);
      xhr.setRequestHeader('x-upload-key', key);
      xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) prog.value = (ev.loaded / ev.total) * 100; };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
        if (xhr.status === 401) return lock('That upload key is wrong.');
        if (xhr.status === 413) return done('That file is too large for the server.');
        if (xhr.status >= 400) return done(data.error || 'The upload failed.');
        toast('Line added.');
        refresh();
      };
      xhr.onerror = () => done('The upload failed. Check your connection.');
      const done = (msg) => { toast(msg); prog.hidden = true; btn.disabled = false; };
      prog.hidden = !f;
      prog.value = 0;
      btn.disabled = true;
      xhr.send(fd);
    };
  }

  // ------------------------------------------------------------ scene packs (read-only)
  const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  function renderSceneInfo(pack, id, ed) {
    const bits = [
      pack.authors?.length ? `by ${esc(pack.authors.join(', '))}` : '',
      pack.videoDur ? `${clock(pack.videoDur)} long` : '',
      `${pack.characters.length} role${pack.characters.length === 1 ? '' : 's'}: ${esc(pack.characters.join(', '))}`,
    ].filter(Boolean);
    ed.innerHTML = `
      <div class="edhead"><h2>${esc(pack.title)}</h2><button id="delPack" class="btn ghost small">Delete pack</button></div>
      <p class="hint">Scene ${bits.join(', ')}</p>
      <video class="scenevid" src="${esc(pack.video)}" controls preload="metadata" playsinline></video>
      <ol class="lines cues">${pack.cues.map((c) => `
        <li><span class="tn">${clock(c.time)}</span>
          <div class="ltext"><b>${esc(c.characters.join(' & '))}</b><span>${esc(c.caption)}</span></div><span></span></li>`).join('')}</ol>`;
    $('#delPack').onclick = async () => {
      if (!confirm(`Delete "${pack.title}"? This can't be undone.`)) return;
      try { await api('DELETE', `/api/packs/${encodeURIComponent(id)}`); current = null; refresh(); }
      catch (ex) { if (ex.message !== 'locked') toast(ex.message); }
    };
  }

  // ------------------------------------------------------------ importing zips
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CHUNK = 8 * 1024 * 1024; // stays under the server's 20 MB request limit
  let jobsTimer = null;
  let seenDone = -1;

  async function uploadZip(file, onProgress) {
    const { id } = await api('POST', '/api/imports', { name: file.name, size: file.size });
    let offset = 0;
    while (offset < file.size) {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(`/api/imports/${id}?offset=${offset}`, {
            method: 'PUT',
            headers: { 'x-upload-key': key, 'content-type': 'application/octet-stream' },
            body: file.slice(offset, offset + CHUNK),
          });
          const data = await res.json().catch(() => ({}));
          if (res.status === 401) { lock('That upload key is wrong.'); throw new Error('locked'); }
          if (res.status === 409 && Number.isFinite(data.size)) { offset = data.size; break; }
          if (!res.ok) throw new Error(data.error || 'The upload failed.');
          offset = data.size;
          break;
        } catch (ex) {
          if (ex.message === 'locked' || attempt >= 3) throw ex;
          await sleep(1000 * (attempt + 1));
        }
      }
      onProgress(offset / file.size);
    }
    return api('POST', `/api/imports/${id}/finish`);
  }

  function uploadRow(name) {
    const li = document.createElement('li');
    li.className = 'job working';
    li.innerHTML = `<b>${esc(name)}</b><span>Starting upload…</span>`;
    $('#uploads')?.append(li);
    return {
      set(msg, failed) { li.lastElementChild.textContent = msg; if (failed) li.className = 'job failed'; },
      remove() { li.remove(); },
    };
  }

  function setupImports() {
    $('#importBtn').onclick = async () => {
      const files = [...$('#zips').files];
      if (!files.length) return toast('Pick one or more .zip files first.');
      $('#importBtn').disabled = true;
      for (const f of files) {
        const row = uploadRow(f.name);
        try {
          await uploadZip(f, (p) => row.set(`Uploading ${Math.round(p * 100)}%`));
          row.remove();
          pollJobs();
        } catch (ex) {
          if (ex.message === 'locked') return;
          row.set(ex.message, true);
        }
      }
      $('#zips').value = '';
      $('#importBtn').disabled = false;
    };
    loadInbox();
    pollJobs();
  }

  async function pollJobs() {
    clearTimeout(jobsTimer);
    let list;
    try { list = await api('GET', '/api/jobs'); } catch { return; }
    const ul = $('#jobs');
    if (!ul) return;
    const label = { queued: 'Waiting', working: '', done: '', failed: 'Failed: ' };
    ul.innerHTML = list.slice(0, 25).map((j) => `
      <li class="job ${j.state}"><b>${esc(j.name)}</b><span>${esc(label[j.state] + j.message)}</span></li>`).join('');
    const done = list.filter((j) => j.state === 'done').length;
    if (seenDone >= 0 && done !== seenDone) { refresh(); loadInbox(); }
    seenDone = done;
    if (list.some((j) => j.state === 'queued' || j.state === 'working')) jobsTimer = setTimeout(pollJobs, 1500);
  }

  async function loadInbox() {
    const box = $('#inbox');
    if (!box) return;
    let items = [];
    try { ({ items } = await api('GET', '/api/inbox')); } catch { return; }
    box.innerHTML = items.length
      ? `<p class="hint">${items.length} pack${items.length === 1 ? ' is' : 's are'} waiting in the server's inbox folder.</p>
         <button id="inboxBtn" class="btn">Import everything in the inbox</button>`
      : '<p class="hint">Got a lot of packs? Copy the zips into <code>~/dub-club/inbox</code> on the server and they\'ll show up here to import in one go.</p>';
    const b = $('#inboxBtn');
    if (b) {
      b.onclick = async () => {
        b.disabled = true;
        try { await api('POST', '/api/inbox/import'); } catch (ex) { if (ex.message !== 'locked') toast(ex.message); }
        loadInbox();
        pollJobs();
      };
    }
  }

  // ------------------------------------------------------------ boot
  (async () => {
    try {
      const { enabled } = await (await fetch('/api/uploads')).json();
      if (!enabled) {
        app.innerHTML = `<main class="stage home"><h1 class="logo">Dub Club</h1>
          <p class="tag">Uploads are turned off on this server.</p><a class="btn ghost" href="/">Back to the game</a></main>`;
        return;
      }
    } catch { /* fall through to the lock screen */ }
    if (key) {
      try { await api('POST', '/api/auth'); return renderManager(); } catch (ex) { if (ex.message !== 'locked') renderLock(ex.message); return; }
    }
    renderLock();
  })();
})();
