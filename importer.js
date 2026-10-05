'use strict';
// Imports Choicer Voicer packs (zip files or folders) into Dub Club's packs directory.
// Dub-mode packs (dub_video + timestamped lines) become type "dub";
// everything else becomes a regular "lines" pack.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const AUDIO = ['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.flac', '.aac'];
const IMAGE = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VIDEO = ['.ogv', '.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'];

function run(cmd, args, { okCodes = [0], timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 24, timeout }, (err, stdout, stderr) => {
      if (err && !okCodes.includes(err.code)) {
        const detail = String(stderr || err.message).trim().split('\n').slice(-3).join(' ');
        return reject(new Error(`${cmd} failed: ${detail}`));
      }
      resolve(String(stdout));
    });
  });
}

// ---------------------------------------------------------------- Godot ConfigFile parser
function parseCfg(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const out = {};
  let sec = (out._ = {});
  let i = 0;
  const n = text.length;
  const skip = () => { while (i < n && /\s/.test(text[i])) i++; };
  const skipInline = () => { while (i < n && (text[i] === ' ' || text[i] === '\t')) i++; };

  function str() {
    i++;
    let s = '';
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < n) {
        const e = text[++i];
        s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        i++;
      } else s += text[i++];
    }
    i++;
    return s;
  }

  function list(close) {
    i++;
    const arr = [];
    for (;;) {
      skip();
      if (i >= n) break;
      if (text[i] === close) { i++; break; }
      arr.push(value());
      skip();
      if (text[i] === ',') i++;
    }
    return arr;
  }

  function value() {
    skipInline();
    const c = text[i];
    if (c === '"') return str();
    if (c === '[') return list(']');
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        skip();
        if (i >= n) break;
        if (text[i] === '}') { i++; break; }
        const k = value();
        skip();
        if (text[i] === ':') i++;
        obj[k] = value();
        skip();
        if (text[i] === ',') i++;
      }
      return obj;
    }
    let j = i;
    while (j < n && /[A-Za-z0-9_.+\-]/.test(text[j])) j++;
    const tok = text.slice(i, j);
    i = j;
    if (!tok) { i++; return null; }
    if (text[i] === '(') return list(')'); // PackedStringArray("a","b") etc.
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    const num = Number(tok);
    return Number.isFinite(num) ? num : tok;
  }

  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === ';' || c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '[') {
      const j = text.indexOf(']', i);
      if (j < 0) break;
      const name = text.slice(i + 1, j).trim();
      sec = out[name] = out[name] || {};
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && text[j] !== '=' && text[j] !== '\n') j++;
    if (text[j] !== '=') { i = j; continue; }
    const key = text.slice(i, j).trim();
    i = j + 1;
    sec[key] = value();
  }
  return out;
}

// ---------------------------------------------------------------- helpers
const ext = (f) => path.extname(f).toLowerCase();
const stemOf = (f) => f.slice(0, f.length - path.extname(f).length);
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const safeName = (f) => f.replace(/[^\w.-]+/g, '_');
const toNums = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(Number).filter(Number.isFinite);
const toStrs = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);

async function probeDuration(file) {
  try {
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file], { timeout: 60_000 });
    const d = parseFloat(out);
    return Number.isFinite(d) ? Math.round(d * 1000) / 1000 : null;
  } catch { return null; }
}

function slugFor(title, packsDir) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'pack';
  let id = base;
  for (let i = 2; fs.existsSync(path.join(packsDir, id)); i++) id = `${base}-${i}`;
  return id;
}

async function findPackDirs(root, depth = 0) {
  const ents = await fsp.readdir(root, { withFileTypes: true });
  const files = ents.filter((e) => e.isFile()).map((e) => e.name);
  if (files.some((f) => f.toLowerCase() === '_pack_info.ini')) return [root];
  const out = [];
  if (depth < 5) {
    for (const e of ents) {
      if (e.isDirectory() && !e.name.startsWith('__MACOSX') && !e.name.startsWith('.')) {
        out.push(...await findPackDirs(path.join(root, e.name), depth + 1));
      }
    }
  }
  // A folder with line files but no ini still counts, if nothing deeper was found.
  if (!out.length && files.some((f) => AUDIO.includes(ext(f)))) return [root];
  return out;
}

// ---------------------------------------------------------------- import one pack folder
async function importDir(dir, packsDir, log) {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  const files = ents.filter((e) => e.isFile()).map((e) => e.name).sort(natural);
  const findFile = (pred) => files.find(pred);
  const iniName = findFile((f) => f.toLowerCase() === '_pack_info.ini');
  const info = iniName ? (parseCfg(await fsp.readFile(path.join(dir, iniName), 'utf8')).data || {}) : {};
  const title = String(info.title || path.basename(dir)).trim().slice(0, 80) || 'Untitled pack';
  const withStem = (stem, exts) => findFile((f) => stemOf(f) === stem && exts.includes(ext(f)));

  // Lines, from the .txt files
  const lines = [];
  for (const f of files.filter((x) => ext(x) === '.txt' && !x.startsWith('_'))) {
    const cfg = parseCfg(await fsp.readFile(path.join(dir, f), 'utf8'));
    const d = cfg.data || cfg._ || {};
    const stem = stemOf(f);
    const audio = withStem(stem, AUDIO);
    const img = d.image && files.includes(String(d.image)) ? String(d.image) : withStem(stem, IMAGE);
    const caption = String(d.caption ?? '').trim();
    if (!audio && !caption) continue;
    lines.push({
      audio, image: img, caption,
      times: toNums(d.dub_timestamps),
      characters: toStrs(d.dub_characters),
      character: stem.includes('_') ? stem.slice(stem.indexOf('_') + 1).replace(/_/g, ' ') : '',
    });
  }
  // Audio files with no .txt of their own are lines too (just without a caption)
  {
    const used = new Set(lines.map((l) => l.audio).filter(Boolean));
    for (const f of files.filter((x) => AUDIO.includes(ext(x)) && !x.startsWith('_') && !used.has(x))) {
      const stem = stemOf(f);
      lines.push({ audio: f, image: withStem(stem, IMAGE), caption: '', times: [], characters: [],
        character: stem.includes('_') ? stem.slice(stem.indexOf('_') + 1).replace(/_/g, ' ') : '' });
    }
  }
  if (!lines.length) throw new Error(`"${title}" has no lines in it.`);

  const video = findFile((f) => stemOf(f).toLowerCase() === 'dub_video' && VIDEO.includes(ext(f)));
  const backing = findFile((f) => stemOf(f).toLowerCase() === '_backing_track' && AUDIO.includes(ext(f)));
  const isDub = !!video && lines.some((l) => l.times.length);

  const id = slugFor(title, packsDir);
  const outDir = path.join(packsDir, id);
  await fsp.mkdir(outDir, { recursive: true });

  const copied = new Map();
  const copy = async (f) => {
    if (!f) return null;
    if (copied.has(f)) return copied.get(f);
    const st = await fsp.lstat(path.join(dir, f));
    if (!st.isFile()) return null; // ignore symlinks and oddities
    const name = safeName(f);
    await fsp.copyFile(path.join(dir, f), path.join(outDir, name));
    copied.set(f, name);
    return name;
  };

  try {
    const iconSrc = info.icon && files.includes(String(info.icon)) ? String(info.icon) : findFile((f) => f.toLowerCase() === 'icon.png');
    const icon = await copy(iconSrc);
    const authors = toStrs(info.authors);
    let meta;

    if (isDub) {
      log(`Converting the video for "${title}"…`);
      await run('ffmpeg', [
        '-y', '-v', 'error', '-i', path.join(dir, video),
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
        '-vf', "scale=w='trunc(min(1280,iw)/2)*2':h=-2",
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
        path.join(outDir, 'video.mp4'),
      ], { timeout: 20 * 60 * 1000 });
      log(`Reading the lines for "${title}"…`);
      const videoDur = await probeDuration(path.join(outDir, 'video.mp4'));
      const characters = [];
      const cues = [];
      for (const l of lines.filter((x) => x.times.length)) {
        const audio = await copy(l.audio);
        const image = await copy(l.image);
        const dur = l.audio ? await probeDuration(path.join(dir, l.audio)) : null;
        const chars = l.characters.length ? l.characters : [l.character || 'Everyone'];
        for (const c of chars) if (!characters.includes(c)) characters.push(c);
        for (const time of l.times) cues.push({ time, characters: chars, caption: l.caption, audio, image, dur });
      }
      cues.sort((a, b) => a.time - b.time);
      meta = { type: 'dub', title, authors, icon, video: 'video.mp4', videoDur, backing: await copy(backing), characters, cues };
    } else {
      log(`Reading the lines for "${title}"…`);
      const prompts = [];
      for (const l of lines) {
        const media = await copy(l.audio);
        const dur = l.audio ? await probeDuration(path.join(dir, l.audio)) : null;
        prompts.push({
          text: l.caption,
          note: l.character ? `as ${l.character}` : '',
          media,
          image: await copy(l.image),
          recordSeconds: Math.min(Math.max(Math.ceil((dur || 10) + 3), 5), 45),
        });
      }
      meta = { type: 'lines', title, authors, icon, prompts };
    }

    await fsp.writeFile(path.join(outDir, 'pack.json'), JSON.stringify(meta, null, 2));
    return id;
  } catch (err) {
    await fsp.rm(outDir, { recursive: true, force: true });
    throw err;
  }
}

// ---------------------------------------------------------------- import a zip or folder
async function importSource(src, packsDir, log = () => {}) {
  const work = path.join(packsDir, '.work', crypto.randomBytes(6).toString('hex'));
  let root = src;
  try {
    if ((await fsp.stat(src)).isFile()) {
      await fsp.mkdir(work, { recursive: true });
      log('Unpacking…');
      // exit code 1 = warnings only (e.g. odd paths were cleaned up)
      await run('unzip', ['-qq', '-o', src, '-d', work], { okCodes: [0, 1], timeout: 10 * 60 * 1000 });
      root = work;
    }
    const dirs = await findPackDirs(root);
    if (!dirs.length) throw new Error('No Choicer Voicer pack was found inside.');
    const ids = [];
    for (const d of dirs) ids.push(await importDir(d, packsDir, log));
    return ids;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

module.exports = { importSource, parseCfg };
