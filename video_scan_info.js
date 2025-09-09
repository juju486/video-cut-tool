#!/usr/bin/env node
/**
 * 扫描指定文件夹下所有视频文件，提取：宽高比、码率、大小、分辨率、时长
 * 结果以 JSON 格式保存到该文件夹（video_info.json）
 *
 * 用法（PowerShell）：
 *   node video_scan_info.js -d "input/811"
 *   node video_scan_info.js --dir clips/811
 *   （不传 -d/--dir 时，优先使用 config.yaml 的 inputDir，其次为 input/）
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const ProgressBar = require('progress');
const ffmpeg = require('fluent-ffmpeg');

// 允许的视频扩展名
const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.flv', '.webm', '.m4v', '.wmv', '.ts', '.3gp'
]);

function parseArgs(argv) {
  const args = { dir: undefined };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-d' || a === '--dir') {
      args.dir = argv[i + 1];
      i++;
    }
  }
  return args;
}

function loadConfigDir() {
  try {
    const cfgPath = path.resolve(process.cwd(), 'config.yaml');
    if (fs.existsSync(cfgPath)) {
      const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
      if (cfg && typeof cfg === 'object') {
        if (cfg.inputDir && typeof cfg.inputDir === 'string') return cfg.inputDir;
        if (cfg.directories && cfg.directories.inputDir) return cfg.directories.inputDir;
      }
    }
  } catch (_) {}
  return 'input';
}

async function walkDir(dir) {
  const out = [];
  async function walk(d) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (VIDEO_EXTS.has(path.extname(ent.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = b; b = a % b; a = t; }
  return a || 1;
}

function parseRational(str) {
  if (!str) return undefined;
  if (typeof str === 'number') return str;
  const m = String(str).split('/');
  if (m.length === 2) {
    const n = parseFloat(m[0]);
    const d = parseFloat(m[1]);
    if (d !== 0) return n / d;
  }
  const v = parseFloat(str);
  return isNaN(v) ? undefined : v;
}

function humanBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${sizes[i]}`;
}

function humanDuration(seconds) {
  if (!isFinite(seconds)) return '';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
}

async function analyzeOne(file, rootDir) {
  try {
    const meta = await probe(file);
    const format = meta.format || {};
    const videoStream = (meta.streams || []).find(s => s.codec_type === 'video');

    const width = videoStream?.width || 0;
    const height = videoStream?.height || 0;

    // 计算 DAR（显示宽高比）
    let aspectRatio = videoStream?.display_aspect_ratio;
    if (!aspectRatio || aspectRatio === '0:1') {
      if (width && height) {
        const g = gcd(width, height);
        aspectRatio = `${Math.round(width / g)}:${Math.round(height / g)}`;
      } else {
        aspectRatio = '';
      }
    }
    const aspectRatioFloat = width && height ? +(width / height).toFixed(4) : undefined;

    // 码率（优先 format.bit_rate，其次视频流；都没有则估算）
    let bps = format.bit_rate ? Number(format.bit_rate) : undefined;
    if (!bps && videoStream?.bit_rate) bps = Number(videoStream.bit_rate);
    const duration = format.duration ? Number(format.duration) : undefined;
    const sizeBytes = format.size ? Number(format.size) : (await fs.stat(file)).size;
    if (!bps && duration && sizeBytes) {
      bps = Math.round((sizeBytes * 8) / duration);
    }

    // 帧率
    const fps = parseRational(videoStream?.avg_frame_rate) || parseRational(videoStream?.r_frame_rate);

    const result = {
      file: path.relative(rootDir, file).split(path.sep).join('/'),
      absolute: file,
      sizeBytes,
      size: humanBytes(sizeBytes),
      durationSeconds: duration ? +duration.toFixed(3) : undefined,
      duration: duration ? humanDuration(duration) : '',
      width, height,
      resolution: width && height ? `${width}x${height}` : '',
      aspectRatio,
      aspectRatioFloat,
      bitrate: bps ? { bps, kbps: +(bps / 1000).toFixed(1) } : undefined,
      fps: fps ? +fps.toFixed(3) : undefined,
      codec: videoStream?.codec_name,
      pixFmt: videoStream?.pix_fmt,
    };

    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: `${err.message || err}` };
  }
}

async function main() {
  const { dir } = parseArgs(process.argv);
  const fromCfg = loadConfigDir();
  const targetDirRel = dir || fromCfg || 'input';
  const targetDir = path.resolve(process.cwd(), targetDirRel);

  if (!fs.existsSync(targetDir)) {
    console.error(`目录不存在: ${targetDir}`);
    process.exit(1);
  }

  console.log(`扫描目录: ${targetDir}`);
  const files = await walkDir(targetDir);
  const videos = files.filter(Boolean);
  console.log(`检测到视频文件: ${videos.length} 个`);

  const bar = new ProgressBar('分析中 [:bar] :current/:total :percent :etas', {
    total: videos.length || 1,
    width: 26,
  });

  const results = [];
  const errors = [];
  for (const f of videos) {
    const r = await analyzeOne(f, targetDir);
    if (r.ok) {
      results.push(r.data);
    } else {
      errors.push({ file: path.relative(targetDir, f), error: r.error });
    }
    bar.tick();
  }

  // 排序：按相对路径
  results.sort((a, b) => a.file.localeCompare(b.file, 'zh-CN'));

  const out = {
    scannedDir: targetDirRel,
    generatedAt: new Date().toISOString(),
    total: results.length,
    errors: errors.length ? errors : undefined,
    videos: results,
  };

  const outPath = path.join(targetDir, 'video_info.json');
  await fs.writeJson(outPath, out, { spaces: 2 });
  console.log(`已保存: ${outPath}`);
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
