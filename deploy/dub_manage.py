import sys, os
os.chdir(sys.argv[1])

def patch(path, pairs):
    s = open(path).read()
    for a, b in pairs:
        assert s.count(a) == 1, f"{path}: anchor not unique/found: {a[:80]!r}"
        s = s.replace(a, b)
    open(path, 'w').write(s)

patch('public/manage.js', [
("""      <section class="manage">
        <div class="card">
          <h2>Packs</h2>""",
"""      <section class="manage">
        <div class="stack">
        <div class="card">
          <h2>Packs</h2>"""),
("""            <button class="btn">Create pack</button>
          </form>
        </div>
        <div class="card" id="editor">""",
"""            <button class="btn">Create pack</button>
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
        <div class="card" id="editor">"""),
("""    await refresh();
  }

  async function refresh() {""",
"""    await refresh();
    setupImports();
  }

  async function refresh() {"""),
("""<span class="pname">${esc(p.title)}</span><span class="badge">${p.count} line${p.count === 1 ? '' : 's'}</span>""",
"""<span class="pname">${esc(p.title)}</span>${p.type === 'dub' ? '<span class="badge">Scene</span>' : ''}<span class="badge">${p.count} line${p.count === 1 ? '' : 's'}</span>"""),
("""    const pack = await (await fetch(`/api/packs/${encodeURIComponent(id)}`)).json();
    const ed = $('#editor');""",
"""    const pack = await (await fetch(`/api/packs/${encodeURIComponent(id)}`)).json();
    const ed = $('#editor');
    if (pack.type === 'dub') return renderSceneInfo(pack, id, ed);"""),
("""  // ------------------------------------------------------------ boot""",
"""  // ------------------------------------------------------------ scene packs (read-only)
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
      : '<p class="hint">Got a lot of packs? Copy the zips into <code>~/dub-club/inbox</code> on the server and they\\'ll show up here to import in one go.</p>';
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

  // ------------------------------------------------------------ boot"""),
])

with open('public/style.css', 'a') as f:
    f.write("""
/* ---------- scenes (dub mode) */
.center-text { text-align: center; }
.dubwrap { display: flex; flex-direction: column; gap: 16px; width: 100%; }
.dubstage { position: relative; width: 100%; max-width: 960px; margin: 0 auto; border-radius: 10px; overflow: hidden; background: #000; box-shadow: 0 0 0 4px var(--edge); }
.dubscreen video { display: block; width: 100%; height: auto; }
.dubcap {
  position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%);
  width: max-content; max-width: 88%; padding: 10px 18px; border-radius: 10px;
  background: rgba(20, 6, 24, .84); color: var(--cream);
  font-size: clamp(16px, 2.3vw, 26px); font-weight: 800; line-height: 1.25; text-align: center;
}
.dubcap:empty { display: none; }
.dubcap .who { display: block; font-size: .6em; font-weight: 700; color: var(--lilac); margin-bottom: 2px; }
.dubcap.soon { opacity: .85; }
.dubcap.yours { background: var(--bulb); color: #2b1300; }
.dubcap.yours .who { color: #7a3a10; }
.dubcap.yours.now { background: var(--tally); color: #fff; box-shadow: 0 0 34px rgba(255, 61, 61, .6); }
.dubcap.yours.now .who { color: #ffe1e1; }
.dubbar { position: absolute; left: 0; right: 0; bottom: 0; height: 5px; background: rgba(255, 255, 255, .12); }
.dubfill { height: 100%; width: 0; background: var(--bulb); }
.center progress { max-width: 320px; }

.rolepick { display: flex; flex-direction: column; gap: 10px; }
.rolehead { margin: 0; font-size: 17px; }
.rolerow { display: grid; grid-template-columns: 1fr 1.4fr; gap: 10px; align-items: center; color: var(--cream); font-size: 17px; }
.rolerow select { font-size: 16px; padding: 10px 12px; }

.jobs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.job { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border-radius: 8px; background: #1b0b20; font-size: 14px; border-left: 4px solid var(--edge); }
.job span { color: var(--lilac); }
.job.working, .job.queued { border-left-color: var(--bulb); }
.job.done { border-left-color: #6ad38b; }
.job.failed { border-left-color: var(--tally); }
.job.failed span { color: #ff9a9a; }
code { background: #1b0b20; padding: 1px 6px; border-radius: 4px; }
.scenevid { width: 100%; border-radius: 8px; background: #000; }
.cues li { grid-template-columns: 56px 1fr auto; }
""")
print("manage patched")
