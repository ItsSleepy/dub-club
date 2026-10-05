import sys, os
os.chdir(sys.argv[1])

def patch(path, pairs):
    s = open(path).read()
    for a, b in pairs:
        assert s.count(a) == 1, f"{path}: anchor not unique/found: {a[:80]!r}"
        s = s.replace(a, b)
    open(path, 'w').write(s)

patch('public/solo.js', [
("""  async function renderSetup() {
    resetRec();
    clearTakes();""",
"""  async function renderSetup() {
    resetRec();
    clearTakes();
    scene.cleanup();"""),
("""        <label>Lines<select id="count">
          <option value="5">5 lines</option><option value="10">10 lines</option><option value="0">Every line</option>
        </select></label>
        <label class="check"><input id="shuffle" type="checkbox" checked> Shuffle the order</label>""",
"""        <div id="lineOpts" class="stack">
          <label>Lines<select id="count">
            <option value="5">5 lines</option><option value="10">10 lines</option><option value="0">Every line</option>
          </select></label>
          <label class="check"><input id="shuffle" type="checkbox" checked> Shuffle the order</label>
        </div>
        <div id="soloRoles" class="rolepick" hidden></div>"""),
("""    try {
      const packs = await (await fetch('/api/packs')).json();
      $('#pack').innerHTML = packs.length
        ? packs.map((p) => `<option value="${esc(p.id)}">${esc(p.title)} (${p.count} lines)</option>`).join('')
        : '<option value="">No packs yet. Add one in Manage packs.</option>';
    } catch { toast('Packs failed to load. Check the server.'); }

    $('#start').onclick = async () => {
      const id = $('#pack').value;
      if (!id) return toast('Pick a pack first.');""",
"""    let packs = [];
    const showRoles = () => {
      const p = packs.find((x) => x.id === $('#pack').value);
      const isDub = p?.type === 'dub';
      $('#lineOpts').hidden = isDub;
      $('#soloRoles').hidden = !isDub;
      if (isDub) {
        $('#soloRoles').innerHTML = `<h3 class="rolehead">Which roles are you playing?</h3>${p.characters.map((c, i) => `
          <label class="check"><input type="checkbox" value="${esc(c)}"${i === 0 ? ' checked' : ''}> ${esc(c)}</label>`).join('')}
          <p class="hint">Anyone you don't pick uses the original voice.</p>`;
      }
    };
    try {
      packs = await (await fetch('/api/packs')).json();
      const opt = (p) => `<option value="${esc(p.id)}">${esc(p.title)} (${p.type === 'dub'
        ? `${p.characters.length} role${p.characters.length === 1 ? '' : 's'}` : `${p.count} lines`})</option>`;
      const scenes = packs.filter((p) => p.type === 'dub');
      const lines = packs.filter((p) => p.type !== 'dub');
      $('#pack').innerHTML = packs.length
        ? (scenes.length ? `<optgroup label="Scenes (dub mode)">${scenes.map(opt).join('')}</optgroup>` : '')
          + (lines.length ? `<optgroup label="Voice lines">${lines.map(opt).join('')}</optgroup>` : '')
        : '<option value="">No packs yet. Add one in Manage packs.</option>';
      showRoles();
    } catch { toast('Packs failed to load. Check the server.'); }
    $('#pack').onchange = showRoles;

    $('#start').onclick = async () => {
      const id = $('#pack').value;
      if (!id) return toast('Pick a pack first.');
      if (packs.find((x) => x.id === id)?.type === 'dub') {
        const roles = $$('#soloRoles input:checked').map((i) => i.value);
        if (!roles.length) return toast('Pick at least one role to play.');
        return startScene(id, roles);
      }"""),
("""    $('#again').onclick = renderSetup;
  }

  renderSetup();""",
"""    $('#again').onclick = renderSetup;
  }

  // ------------------------------------------------------------ scenes (dub mode)
  const scene = {
    pack: null, media: null, mine: null, stream: null, take: null, view: null,
    setTake(t) {
      if (this.take) URL.revokeObjectURL(this.take.url);
      this.take = { url: URL.createObjectURL(t.blob), mime: t.mime, lead: t.lead };
    },
    cleanup() {
      Dub.stopRecording();
      this.view?.destroy();
      if (this.media) Dub.stopAll(this.media);
      this.stream?.getTracks().forEach((t) => t.stop());
      if (this.take) URL.revokeObjectURL(this.take.url);
      Object.assign(this, { pack: null, media: null, mine: null, stream: null, take: null, view: null });
    },
  };

  async function startScene(id, roles) {
    resetRec();
    clearTakes();
    scene.cleanup();
    app.innerHTML = `<main class="stage host">
      <header class="bar">
        <h1 class="logo small">Dub Club</h1>
        <div class="round" id="sceneTitle">Scene</div>
        <button id="exit" class="btn ghost small">Choose another</button>
      </header>
      <div id="scene" class="dubwrap"><div class="center">
        <progress id="loadprog" max="100" value="0"></progress><p class="hint">Loading the scene…</p>
      </div></div>
    </main>`;
    $('#exit').onclick = renderSetup;
    try {
      const pack = await Dub.loadPack(id);
      scene.pack = pack;
      $('#sceneTitle').textContent = pack.title;
      const media = await Dub.preload(pack, (p) => { const el = $('#loadprog'); if (el) el.value = p * 100; });
      if (scene.pack !== pack) return;
      scene.media = media;
    } catch (e) {
      const box = $('#scene');
      if (box) box.innerHTML = `<p class="error center-text">${esc(e.message)}</p>`;
      return;
    }
    scene.mine = new Set(roles);
    sceneReady();
  }

  function sceneReady() {
    const others = scene.pack.characters.filter((c) => !scene.mine.has(c));
    $('#scene').innerHTML = `<div class="center">
      <h2>You're playing ${esc([...scene.mine].join(' and '))}</h2>
      <p>${others.length ? `${esc(others.join(', '))} will use the original voice. ` : ''}Put your headphones on,
        then roll camera. Your lines light up as the scene plays.</p>
      <button id="roll" class="btn primary">Roll camera</button><p id="msg" class="hint"></p></div>`;
    $('#roll').onclick = async () => {
      try {
        if (!scene.stream?.active) scene.stream = await getMic();
      } catch (e) { $('#msg').textContent = micError(e); return; }
      const pack = scene.pack;
      let take;
      try {
        take = await Dub.record({ pack, media: scene.media, mine: scene.mine, stream: scene.stream, el: $('#scene') });
      } catch (e) { $('#msg').textContent = e.message; return; }
      if (scene.pack !== pack || !$('#scene')) return; // left the scene while recording
      scene.setTake(take);
      showSceneResult();
    };
  }

  function showSceneResult() {
    $('#scene').innerHTML = `<div id="dubview"></div>
      <div class="actions">
        <button id="dlVoice" class="btn ghost">Download my voice</button>
        <button id="retake" class="btn primary">Record it again</button>
      </div>`;
    scene.view = Dub.playback({
      pack: scene.pack, media: scene.media, el: $('#dubview'),
      tracks: [{ url: scene.take.url, characters: [...scene.mine], lead: scene.take.lead, name: 'you' }],
    });
    $('#retake').onclick = () => { scene.view.destroy(); scene.view = null; sceneReady(); };
    $('#dlVoice').onclick = () => download(scene.take.url, `my-voice-${[...scene.mine].join('-')}.${extFor(scene.take.mime)}`);
  }

  renderSetup();"""),
])
print("solo patched")
