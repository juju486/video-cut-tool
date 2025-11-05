const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const ProgressBar = require('progress');
const yaml = require('js-yaml');

// 加载配置（用于控制分割提速策略）
let __config = {};
try {
  __config = yaml.load(fs.readFileSync(path.join(__dirname, '../config.yaml'), 'utf8')) || {};
} catch (err) { if (process?.env?.DEBUG) console.warn('load config.yaml failed:', err?.message || err); __config = {}; }
const fastSplitCopy = !!__config.fastSplitCopy;          // true: 优先尝试 -c:v copy + 快速 seek
const fastSeekFirst = !!__config.fastSeekFirst;          // true: 先尝试 -ss 放到 -i 前

// ---- 诊断与日志工具 ----
const LOG_ROOT = path.resolve(__dirname, '../output/ffmpeg_logs');
function ensureLogDir() {
  try { fs.ensureDirSync(LOG_ROOT); } catch (err) { if (process?.env?.DEBUG) console.warn('ensureLogDir error:', err?.message || err); }
}
function writeLogSafe(file, content) {
  try {
    ensureLogDir();
    fs.appendFileSync(path.join(LOG_ROOT, file), content + (content.endsWith('\n') ? '' : '\n'));
  } catch (err) { if (process?.env?.DEBUG) console.warn('writeLogSafe error:', err?.message || err); }
}
function normalizePath(p) { return String(p || '').replace(/\\/g, '/'); }

// 统一封装 ffmpeg 调用：带超时、完整 stderr/stdout 落盘
async function runFfmpegLogged(args, logName, timeoutSec = 300) {
  ensureLogDir();
  const logFile = `${logName.replace(/[^a-zA-Z0-9_.-]/g, '_')}.log`;
  const startTs = new Date();
  const header = `==== ${startTs.toISOString()} ffmpeg start ===\nARGS: ffmpeg ${args.join(' ')}\n`;
  writeLogSafe(logFile, header);
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '';
    const timer = setTimeout(() => {
      writeLogSafe(logFile, `TIMEOUT after ${timeoutSec}s, killing process`);
      try { p.kill('SIGKILL'); } catch (err) { if (process?.env?.DEBUG) console.warn('kill ffmpeg error:', err?.message || err); }
    }, Math.max(5, timeoutSec) * 1000);
    p.stdout.on('data', d => { const s = d.toString(); stdout += s; });
    p.stderr.on('data', d => { const s = d.toString(); stderr += s; });
    p.on('close', (code) => {
      clearTimeout(timer);
      const footer = `\n---- ffmpeg end (code=${code}) ----\nSTDERR:\n${stderr}\n\nSTDOUT:\n${stdout}\n`;
      writeLogSafe(logFile, footer);
      if (code === 0) resolve({ code, stderr, stdout, logPath: path.join(LOG_ROOT, logFile) });
      else reject(Object.assign(new Error(`ffmpeg failed (code=${code}). See log: ${path.join(LOG_ROOT, logFile)}`), { code, stderr, stdout, logPath: path.join(LOG_ROOT, logFile) }));
    });
    p.on('error', (err) => {
      clearTimeout(timer);
      writeLogSafe(logFile, `PROCESS ERROR: ${err?.message || err}`);
      reject(err);
    });
  });
}

// ffprobe 预检
async function ffprobeJson(file) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      file
    ];
    const p = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe failed code=${code}`));
      try { resolve(JSON.parse(out)); } catch (e) { if (process?.env?.DEBUG) console.warn('ffprobe parse error:', e?.message || e); reject(e); }
    });
    p.on('error', reject);
  });
}

async function quickFixVideo(inputPath) {
  // 尝试快速修复：先 remux 复制；失败则 x264 最小化重编码（仅视频，-an）。
  const dir = path.dirname(inputPath);
  const base = path.parse(inputPath).name;
  const tmpDir = path.join(dir, '_fixed');
  await fs.ensureDir(tmpDir);
  const remuxPath = path.join(tmpDir, `${base}_remux.mp4`);
  const reencPath = path.join(tmpDir, `${base}_reenc.mp4`);
  try {
    await runFfmpegLogged([
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-fflags', '+genpts',
      '-i', normalizePath(inputPath),
      '-map', '0:v:0',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', normalizePath(remuxPath)
    ], `fix_remux_${base}`, 180);
    // 校验
    await ffprobeJson(remuxPath);
    return remuxPath;
  } catch (err) {
    if (process?.env?.DEBUG) console.warn('remux failed, fallback to reencode:', err?.message || err);
  }
  await runFfmpegLogged([
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-fflags', '+genpts',
    '-i', normalizePath(inputPath),
    '-map', '0:v:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-an', '-movflags', '+faststart',
    '-y', normalizePath(reencPath)
  ], `fix_reencode_${base}`, 600);
  await ffprobeJson(reencPath);
  return reencPath;
}

function getVideoFiles(dir) {
  return fs.readdirSync(dir).filter(f => /(\.mp4|\.mov|\.avi|\.mkv)$/i.test(f));
}

// 分割片段助手：单个片段多方案重试（避免整批中断）
async function splitOneSegment(inputFile, outPath, start, duration, logBase) {
  // 变体：快速拷贝切割（-ss 前置 + -c copy，极快，但仅关键帧精度）
  const variantCopyFast = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', String(start),
    '-i', normalizePath(inputFile),
    '-t', String(duration),
    '-an',
    '-c:v', 'copy',
    '-movflags', '+faststart',
    '-y', normalizePath(outPath)
  ];
  // 变体 A：标准方案（-i 后 -ss -t）
  const variantA = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-fflags', '+genpts', '-avoid_negative_ts', 'make_zero',
    '-i', normalizePath(inputFile),
    '-ss', String(start),
    '-t', String(duration),
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', normalizePath(outPath)
  ];
  // 变体 B：将 -ss 放到 -i 前（老片源/旧版 ffmpeg 更稳且更快）
  const variantB = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-fflags', '+genpts',
    '-ss', String(start),
    '-i', normalizePath(inputFile),
    '-t', String(duration),
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', normalizePath(outPath)
  ];
  // 变体 C：用 -to 指定结束时间（避免某些精度问题）
  const end = Math.max(0, Number(start) + Number(duration) - 0.02).toFixed(3);
  const variantC = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-fflags', '+genpts',
    '-i', normalizePath(inputFile),
    '-ss', String(start),
    '-to', String(end),
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', normalizePath(outPath)
  ];
  // 根据配置决定尝试顺序
  const variants = [];
  if (fastSplitCopy) variants.push(variantCopyFast);
  if (fastSeekFirst) variants.push(variantB, variantA, variantC); else variants.push(variantA, variantB, variantC);
  let lastErr = null;
  for (let i = 0; i < variants.length; i++) {
    try {
      await runFfmpegLogged(variants[i], `${logBase}_try${i+1}`, 600);
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  // 快速修复后再试一次（拷贝优先 + A/B）
  try {
    const fixed = await quickFixVideo(inputFile);
    const fixedVariants = [];
    if (fastSplitCopy) fixedVariants.push(['-hide_banner','-loglevel','error','-nostdin','-ss', String(start), '-i', normalizePath(fixed), '-t', String(duration), '-an','-c:v','copy','-movflags','+faststart','-y', normalizePath(outPath)]);
    if (fastSeekFirst) {
      fixedVariants.push(['-hide_banner','-loglevel','error','-nostdin','-fflags','+genpts','-ss', String(start), '-i', normalizePath(fixed), '-t', String(duration), '-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart','-y', normalizePath(outPath)]);
      fixedVariants.push(['-hide_banner','-loglevel','error','-nostdin','-fflags','+genpts','-avoid_negative_ts','make_zero','-i', normalizePath(fixed), '-ss', String(start), '-t', String(duration), '-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart','-y', normalizePath(outPath)]);
    } else {
      fixedVariants.push(['-hide_banner','-loglevel','error','-nostdin','-fflags','+genpts','-avoid_negative_ts','make_zero','-i', normalizePath(fixed), '-ss', String(start), '-t', String(duration), '-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart','-y', normalizePath(outPath)]);
      fixedVariants.push(['-hide_banner','-loglevel','error','-nostdin','-fflags','+genpts','-ss', String(start), '-i', normalizePath(fixed), '-t', String(duration), '-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart','-y', normalizePath(outPath)]);
    }
    for (let j = 0; j < fixedVariants.length; j++) {
      try {
        await runFfmpegLogged(fixedVariants[j], `${logBase}_fixed_try${j+1}`, 600);
        return true;
      } catch (e2) { lastErr = e2; }
    }
  } catch (fixErr) { lastErr = fixErr; }
  if (lastErr) throw lastErr;
  return false;
}

function getSceneChangeFrames(filePath, threshold = 0.4) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'info', '-nostdin', // 使用 info 以便 showinfo 输出被捕获
      '-i', normalizePath(filePath),
      '-filter_complex', `select='gt(scene,${threshold})',showinfo`,
      '-vsync', 'vfr',
      '-f', 'null',
      '-'
    ];
    const logName = `scene_detect_${path.parse(filePath).name}`;
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    ffmpeg.stderr.on('data', chunk => stderr += chunk.toString());
    ffmpeg.on('error', err => {
      writeLogSafe(`${logName}.log`, `PROCESS ERROR: ${err?.message || err}`);
      reject(err);
    });
    ffmpeg.on('close', (code) => {
      writeLogSafe(`${logName}.log`, `ARGS: ffmpeg ${args.join(' ')}\nEXIT CODE: ${code}\nSTDERR:\n${stderr}`);
      if (code !== 0) return reject(new Error(`ffmpeg scene-detect failed. See log: ${path.join(LOG_ROOT, logName + '.log')}`));
      const regex = /pts_time:([\d.]+)/g;
      let match;
      const times = [];
      while ((match = regex.exec(stderr)) !== null) {
        times.push(parseFloat(match[1]));
      }
      if (times[0] !== 0) times.unshift(0);
      resolve(times);
    });
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function getFps(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', '0',
      '-of', 'csv=p=0',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate',
      '-print_format', 'default',
      filePath
    ];
    const ffprobe = spawn('ffprobe', args);
    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('error', err => reject(err));
    ffprobe.on('close', () => {
      const match = data.match(/(\d+\/?\d*)/);
      let fps = 25;
      if (match) {
        const parts = match[1].split('/');
        fps = parts.length === 2 ? (parseFloat(parts[0]) / parseFloat(parts[1])) : parseFloat(parts[0]);
      }
      resolve(fps || 25);
    });
  });
}

async function splitVideoToClips(filePath, sceneFrames, basename, clipsDir, progressCb) {
  const clips = [];
  for (let i = 0; i < sceneFrames.length - 1; i++) {
    const start = sceneFrames[i];
    const duration = sceneFrames[i + 1] - sceneFrames[i];
    const outPath = path.join(clipsDir, `clip_${basename}_${i}.mp4`);
    await fs.ensureDir(clipsDir);
    const logBase = `split_${path.parse(filePath).name}_${i}`;
    try {
      const ok = await splitOneSegment(filePath, outPath, start, duration, logBase);
      if (ok) clips.push(outPath); else throw new Error('unknown split failure');
    } catch (e) {
      writeLogSafe(`${logBase}_fatal.log`, `SPLIT FAILED for ${path.basename(filePath)} [${start}, ${duration}] => ${e?.message || e}`);
      // 继续下一个片段，避免整批中断
    }
    if (progressCb) progressCb();
  }
  return clips;
}

async function splitVideoToClipsWithAlias(filePath, sceneFrames, alias, clipsDir, progressCb, minusFrames = 1) {
  const clips = [];
  const basename = alias;
  const fps = await getFps(filePath);
  const frameDuration = 1 / fps;
  for (let i = 0; i < sceneFrames.length - 1; i++) {
    const start = sceneFrames[i];
    let duration = sceneFrames[i + 1] - sceneFrames[i] - frameDuration * minusFrames;
    if (duration <= 0) duration = 0.05;
    const outPath = path.join(clipsDir, `${basename}_${i}.mp4`);
    await fs.ensureDir(clipsDir);
    const logBase = `split_alias_${path.parse(filePath).name}_${i}`;
    try {
      const ok = await splitOneSegment(filePath, outPath, start, duration, logBase);
      if (ok) clips.push(outPath); else throw new Error('unknown split failure');
    } catch (e) {
      writeLogSafe(`${logBase}_fatal.log`, `SPLIT FAILED for ${path.basename(filePath)} [${start}, ${duration}] => ${e?.message || e}`);
      // 继续下一个片段，避免整批中断
    }
    if (progressCb) progressCb();
  }
  return clips;
}

async function getFrameTimeMap(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-select_streams', 'v:0',
      '-show_frames',
      '-print_format', 'json',
      '-show_entries', 'frame=pkt_pts_time,pkt_dts_time,coded_picture_number',
      filePath
    ];
    const ffprobe = spawn('ffprobe', args);
    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('error', err => reject(err));
    ffprobe.on('close', () => {
      try {
        const json = JSON.parse(data);
        const arr = json.frames.map((f, idx) => ({
          frame: f.coded_picture_number !== undefined ? f.coded_picture_number : idx,
          time: parseFloat(f.pkt_pts_time || f.pkt_dts_time)
        })).filter(f => !isNaN(f.time));
        resolve(arr);
      } catch (e) { if (process?.env?.DEBUG) console.warn('getFrameTimeMap parse error:', e?.message || e); reject(e); }
    });
  });
}

async function splitVideoByFrameSelect(filePath, sceneFrames, alias, clipsDir, progressCb) {
  const clips = [];
  const basename = alias;
  const frameMap = await getFrameTimeMap(filePath);
  for (let i = 0; i < sceneFrames.length - 1; i++) {
    const startTime = sceneFrames[i];
    const endTime = sceneFrames[i + 1];
    const startFrame = frameMap.find(f => f.time >= startTime)?.frame || 0;
    const endFrame = frameMap.find(f => f.time >= endTime)?.frame || (frameMap.length - 1);
    const outPath = path.join(clipsDir, `${basename}_${i}.mp4`);
    await fs.ensureDir(clipsDir);
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-fflags', '+genpts',
      '-i', normalizePath(filePath),
      '-vf', `select='between(n\\,${startFrame}\\,${endFrame-1})',setpts=N/FRAME_RATE/TB`,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y',
      normalizePath(outPath)
    ];
    try {
      await runFfmpegLogged(args, `split_frame_${path.parse(filePath).name}_${i}`, 600);
      clips.push(outPath);
    } catch (e) {
      writeLogSafe(`split_frame_${path.parse(filePath).name}_${i}_fatal.log`, `FRAME SELECT SPLIT FAILED for ${path.basename(filePath)} [${startTime}, ${endTime}] => ${e?.message || e}`);
      // 继续下一个片段
    }
    if (progressCb) progressCb();
  }
  return clips;
}

async function concatClips(clips, outPath, outputDir) {
  const bar = new ProgressBar('拼接进度 [:bar] :current/:total', { total: 1, width: 30 });
  const listFile = path.join(outputDir, 'concat_list.txt');
  
  for (const clip of clips) {
    if (!fs.existsSync(clip)) {
      throw new Error(`片段文件不存在: ${clip}`);
    }
  }
  const listContent = clips.map(f => {
    const absolutePath = path.resolve(f);
    const normalizedPath = absolutePath.replace(/\\/g, '/');
    return `file '${normalizedPath}'`;
  }).join('\n');
  fs.writeFileSync(listFile, listContent);

  await new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      // 统一音频参数，确保兼容性
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-ar', '44100',
      '-ac', '2',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outPath
    ];
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'pipe' });
    
    let stderrData = '';
    ffmpeg.stderr.on('data', chunk => {
      stderrData += chunk.toString();
    });
    
    ffmpeg.on('close', code => {
      bar.tick();
      writeLogSafe(`concat_${path.parse(outPath).name}.log`, `ARGS: ffmpeg ${args.join(' ')}\nCODE: ${code}\nSTDERR:\n${stderrData}`);
      if (code === 0) {
        resolve();
      } else {
        console.error('FFmpeg concat 错误输出:', stderrData);
        reject(new Error(`ffmpeg concat error (code: ${code}): ${stderrData}`));
      }
    });
    
    ffmpeg.on('error', err => {
      console.error('FFmpeg concat 进程错误:', err);
      reject(err);
    });
  });
  
  if (fs.existsSync(listFile)) {
    fs.unlinkSync(listFile);
  }
}

function getClipDuration(filePath) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('close', () => {
      resolve(parseFloat(data));
    });
    ffprobe.on('error', err => reject(err));
  });
}

function genShortAliasArr(n) {
  const arr = [];
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < n; i++) {
    let s = '';
    let x = i;
    do {
      s = chars[x % 26] + s;
      x = Math.floor(x / 26) - 1;
    } while (x >= 0);
    arr.push(s);
  }
  return arr;
}

async function generateOrUpdateAliasMap(inputDir, aliasMapPath) {
  await fs.ensureDir(inputDir);
  const videoFiles = fs.readdirSync(inputDir).filter(f => /(\.mp4|\.mov|\.avi|\.mkv)$/i.test(f));
  videoFiles.sort();
  let aliasMap = {};
  if (fs.existsSync(aliasMapPath)) {
    try {
      aliasMap = await fs.readJson(aliasMapPath);
    } catch (e) {
      if (process?.env?.DEBUG) console.warn('read alias_map error:', e?.message || e);
      aliasMap = {};
    }
  }
  const usedShorts = new Set(Object.keys(aliasMap).map(k => k.split('_').pop()));
  const dirKey = (() => {
    let d = path.basename(inputDir.replace(/[\\/]+$/, ''));
    if (d === '未分析') d = path.basename(path.dirname(inputDir));
    return d;
  })();
  let shortIdx = 0;
  for (const file of videoFiles) {
    const baseName = path.parse(file).name;
    let found = false;
    for (const [k, v] of Object.entries(aliasMap)) {
      if (v === baseName && k.startsWith(dirKey + '_')) {
        found = true;
        break;
      }
    }
    if (!found) {
      let shortAlias;
      while (true) {
        shortAlias = genShortAliasArr(shortIdx + 1)[shortIdx];
        if (!usedShorts.has(shortAlias)) break;
        shortIdx++;
      }
      aliasMap[`${dirKey}_${shortAlias}`] = baseName;
      usedShorts.add(shortAlias);
      shortIdx++;
    }
  }
  await fs.writeJson(aliasMapPath, aliasMap, { spaces: 2 });
  return aliasMap;
}

module.exports = {
  getVideoFiles,
  getSceneChangeFrames,
  splitVideoToClips,
  splitVideoToClipsWithAlias,
  concatClips,
  shuffle,
  getFrameTimeMap,
  splitVideoByFrameSelect,
  getClipDuration,
  generateOrUpdateAliasMap,
  // 新增导出：诊断/预检能力
  runFfmpegLogged,
  ffprobeJson,
  quickFixVideo,
};
