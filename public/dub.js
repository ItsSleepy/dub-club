// Dub scene engine: loads a scene pack, records a performer over it,
// and plays back the finished dub with everyone's voices.
window.Dub = (() => {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cueLength = (c) => Math.max(c.dur || 2, 1.2);
  let stopActive = null; // ends the take that is currently recording, if any

  async function loadPack(id) {
    const res = await fetch(`/api/packs/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error('That scene failed to load.');
    const pack = await res.json();
    if (pack.type !== 'dub') throw new Error('That pack is not a scene.');
    return pack;
  }

  // ------------------------------------------------------------ media
  function waitFor(el, ev) {
    return new Promise((resolve) => {
      if (el.readyState >= 4) return resolve();
      const done = () => { el.removeEventListener(ev, done); el.removeEventListener('error', done); resolve(); };
      el.addEventListener(ev, done);
      el.addEventListener('error', done);
      setTimeout(done, 45_000);
    });
  }

  async function preload(pack, onProgress) {
    const video = document.createElement('video');
    video.src = pack.video;
    video.preload = 'auto';
    video.playsInline = true;
    video.muted = true;
    const backing = pack.backing ? new Audio(pack.backing) : null;
    if (backing) backing.preload = 'auto';
    const originals = new Map();
    for (const c of pack.cues) {
      if (c.audio && !originals.has(c.audio)) {
        const a = new Audio(c.audio);
        a.preload = 'auto';
        originals.set(c.audio, a);
      }
    }
    const all = [video, backing, ...originals.values()].filter(Boolean);
    let done = 0;
    onProgress?.(0);
    await Promise.all(all.map((el) => waitFor(el, 'canplaythrough').then(() => onProgress?.(++done / all.length))));
    if (video.error) throw new Error('The scene video could not be loaded.');
    return { video, backing, originals };
  }

  function stopAll(media) {
    media.video.pause();
    media.backing?.pause();
    media.originals.forEach((a) => a.pause());
  }

  // ------------------------------------------------------------ stage + captions
  function mountStage(el, media, controls) {
    el.innerHTML = `<div class="dubstage">
        <div class="dubscreen"></div>
        <div class="dubcap" aria-live="polite"></div>
        <div class="dubbar"><div class="dubfill"></div></div>
      </div>
      <div class="actions dubcontrols">${controls}</div>`;
    const v = media.video;
    v.muted = true;
    v.controls = false;
    el.querySelector('.dubscreen').append(v);
    return {
      cap: el.querySelector('.dubcap'),
      fill: el.querySelector('.dubfill'),
      btn: (sel) => el.querySelector(sel),
    };
  }

  function captionDrawer(pack, stage, { mine = null, who = null } = {}) {
    let last = '';
    const label = (c) => c.characters.map((ch) => {
      if (mine?.has(ch)) return `${ch} (you)`;
      if (who?.has(ch)) return `${ch} (${who.get(ch)})`;
      return ch;
    }).join(' & ');
    return (t, duration) => {
      stage.fill.style.width = `${Math.min(100, (t / (duration || 1)) * 100)}%`;
      const active = pack.cues.find((c) => t >= c.time - 0.05 && t < c.time + cueLength(c) + 0.3);
      const next = pack.cues.find((c) => c.time > t);
      let key = '';
      let cls = 'dubcap';
      let html = '';
      const yours = (c) => mine && c.characters.some((ch) => mine.has(ch));
      if (active) {
        cls += yours(active) ? ' yours now' : ' theirs';
        key = `a${pack.cues.indexOf(active)}`;
        html = `<span class="who">${esc(label(active))}</span>${esc(active.caption)}`;
      } else if (next && next.time - t < 2.5) {
        const secs = Math.ceil(next.time - t);
        cls += yours(next) ? ' yours soon' : ' theirs soon';
        key = `n${pack.cues.indexOf(next)}-${secs}`;
        html = `<span class="who">${esc(label(next))} in ${secs}</span>${esc(next.caption)}`;
      }
      if (key !== last) {
        last = key;
        stage.cap.className = cls;
        stage.cap.innerHTML = html;
      }
    };
  }

  // ------------------------------------------------------------ recording
  function pickMime() {
    if (!window.MediaRecorder) return null;
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
      .find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  }

  // Records `stream` while the scene plays. Returns { blob, mime, lead } where
  // lead = seconds of recording that happened before the scene started.
  async function record({ pack, media, mine, stream, el }) {
    const mimeType = pickMime();
    if (mimeType === null) throw new Error('This browser cannot record audio. Try Chrome or Edge.');
    const stage = mountStage(el, media, '<button class="btn ghost dubstop">Stop early</button>');
    const draw = captionDrawer(pack, stage, { mine });
    const { video, backing, originals } = media;
    stopAll(media);

    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    const started = new Promise((r) => { rec.onstart = r; });
    rec.start(250);
    await started;
    const recStart = performance.now();

    video.currentTime = 0;
    if (backing) backing.currentTime = 0;
    const playing = new Promise((r) => video.addEventListener('playing', r, { once: true }));
    video.play().catch(() => {});
    backing?.play().catch(() => {});
    await playing;
    const lead = (performance.now() - recStart) / 1000;

    const fired = new Set();
    const timer = setInterval(() => {
      const t = video.currentTime;
      if (backing && Math.abs(backing.currentTime - t) > 0.25) backing.currentTime = t;
      pack.cues.forEach((c, i) => {
        if (fired.has(i) || t < c.time) return;
        fired.add(i);
        const theirs = !c.characters.some((ch) => mine.has(ch));
        if (theirs && c.audio && t - c.time < 0.5) {
          const a = originals.get(c.audio);
          a.currentTime = 0;
          a.play().catch(() => {});
        }
      });
      draw(t, video.duration);
    }, 30);

    await new Promise((r) => {
      stopActive = r;
      video.onended = r;
      stage.btn('.dubstop').onclick = r;
    });
    stopActive = null;
    video.onended = null;
    clearInterval(timer);
    await sleep(300);
    rec.stop();
    await stopped;
    stopAll(media);
    const mime = rec.mimeType || mimeType || 'audio/webm';
    return { blob: new Blob(chunks, { type: mime }), mime, lead };
  }

  // ------------------------------------------------------------ playback
  // tracks: [{ url, characters: [...], lead, name }]
  // Voice tracks are decoded into memory and scheduled on the audio clock, which
  // keeps them in sync with the video far better than seeking <audio> elements.
  function playback({ pack, media, tracks, el }) {
    const stage = mountStage(el, media,
      '<button class="btn primary dubplay">Play the dub</button><button class="btn ghost dubrestart">From the start</button>');
    const { video, backing, originals } = media;
    stopAll(media);
    video.currentTime = 0;

    const covered = new Set(tracks.flatMap((t) => t.characters));
    const who = new Map();
    tracks.forEach((t) => t.characters.forEach((c) => who.set(c, t.name)));
    const draw = captionDrawer(pack, stage, { who });

    const tr = tracks.map((t) => ({
      ...t,
      buffer: null, src: null, gain: null, startCtx: 0, startOff: 0,
      windows: pack.cues
        .filter((c) => c.characters.some((ch) => t.characters.includes(ch)))
        .map((c) => [c.time - 0.4, c.time + cueLength(c) + 1.2]),
    }));

    let ctx = null;
    let ctxReady = null;
    function ensureCtx() {
      if (!ctxReady) {
        ctx = new AudioContext();
        ctxReady = Promise.all(tr.map(async (x) => {
          x.gain = ctx.createGain();
          x.gain.gain.value = 0;
          x.gain.connect(ctx.destination);
          try {
            const bytes = await (await fetch(x.url)).arrayBuffer();
            x.buffer = await ctx.decodeAudioData(bytes);
          } catch { x.buffer = null; }
        }));
      }
      return ctxReady;
    }

    function stopTrack(x) {
      if (!x.src) return;
      try { x.src.stop(); } catch { /* already stopped */ }
      x.src.disconnect();
      x.src = null;
    }
    function startTrack(x, t) {
      stopTrack(x);
      const off = t + x.lead;
      if (!x.buffer || off >= x.buffer.duration) return;
      x.src = ctx.createBufferSource();
      x.src.buffer = x.buffer;
      x.src.connect(x.gain);
      x.startCtx = ctx.currentTime;
      x.startOff = off;
      x.src.start(0, off);
    }

    let fired = new Set();
    let lastT = 0;
    let timer = null;
    const playBtn = stage.btn('.dubplay');

    function tick() {
      const t = video.currentTime;
      if (t < lastT - 0.3) fired = new Set(pack.cues.map((c, i) => (c.time < t ? i : -1)).filter((i) => i >= 0));
      lastT = t;
      const running = !video.paused;
      if (backing && running && Math.abs(backing.currentTime - t) > 0.25) backing.currentTime = t;
      for (const x of tr) {
        if (!x.gain) continue;
        if (running && x.src) {
          const pos = x.startOff + (ctx.currentTime - x.startCtx);
          if (Math.abs(pos - (t + x.lead)) > 0.12) startTrack(x, t); // resync after a video stall
        }
        const on = x.windows.some(([s, e]) => t >= s && t <= e);
        x.gain.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.03);
      }
      pack.cues.forEach((c, i) => {
        if (fired.has(i) || t < c.time) return;
        fired.add(i);
        if (!running || t - c.time > 0.5) return;
        if (!c.characters.some((ch) => covered.has(ch)) && c.audio) {
          const a = originals.get(c.audio);
          a.currentTime = 0;
          a.play().catch(() => {});
        }
      });
      draw(t, video.duration);
    }

    async function play() {
      playBtn.disabled = true;
      await ensureCtx();
      await ctx.resume();
      playBtn.disabled = false;
      if (video.ended) { video.currentTime = 0; fired = new Set(); lastT = 0; }
      if (backing) backing.currentTime = video.currentTime;
      await video.play().catch(() => {});
      backing?.play().catch(() => {});
      tr.forEach((x) => startTrack(x, video.currentTime));
      if (!timer) timer = setInterval(tick, 30);
      playBtn.textContent = 'Pause';
    }

    function pause() {
      video.pause();
      backing?.pause();
      originals.forEach((a) => a.pause());
      tr.forEach(stopTrack);
      playBtn.textContent = 'Play the dub';
    }

    video.onended = () => { pause(); playBtn.textContent = 'Play it again'; };
    playBtn.onclick = () => (video.paused ? play() : pause());
    stage.btn('.dubrestart').onclick = () => {
      pause();
      video.currentTime = 0;
      fired = new Set();
      lastT = 0;
      play();
    };

    return {
      destroy() {
        clearInterval(timer);
        pause();
        video.onended = null;
        ctx?.close();
      },
    };
  }

  const stopRecording = () => stopActive?.();

  return { loadPack, preload, record, playback, stopAll, stopRecording, esc };
})();
