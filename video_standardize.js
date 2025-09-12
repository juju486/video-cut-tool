#!/usr/bin/env node
/**
 * 标准化输入视频：检测是否满足统一标准，不满足的转为标准化视频。
 * 目的：在分割/合成前，先将输入目录的视频规范到统一参数，避免后续拼接卡顿。
 *
 * 标准判断（默认，可通过 config.yaml.standardize 覆盖）：
 *  - 视频编码：H.264（输出可选 libx264/h264_nvenc/h264_amf）
 *  - 像素格式：yuv420p
 *  - 样本宽高比（SAR）：1:1（setsar=1）
 *  - 帧率：可选固定帧率（例如 30），若设置 targetFps 则强制 CFR
 *  - faststart：+faststart
 *  - 音频：AAC（可配置比特率/声道/采样率）
 *  - 显示宽高比（DAR）：可选，默认 9:16；支持 pad（加黑边）、crop（裁剪）、none（不调整）
 *
 * 用法（PowerShell）：
 *   node video_standardize.js                  # 扫描 config.inputDir 或 standardize.inputDir
 *   node video_standardize.js -d "input/811"   # 指定目录
 *   node video_standardize.js --overwrite      # 原地覆盖（谨慎）
 *   node video_standardize.js --dry-run        # 仅预览
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const ProgressBar = require('progress');
const { spawn } = require('child_process');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.flv', '.webm', '.m4v', '.wmv', '.ts', '.3gp']);

function parseArgs(argv) {
  const args = { dir: undefined, overwrite: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-d' || a === '--dir') { args.dir = argv[i + 1]; i++; continue; }
    if (a === '--overwrite') { args.overwrite = true; continue; }
    if (a === '--dry-run') { args.dryRun = true; continue; }
  }
  return args;
}

function loadConfig() {
  const cfgPath = path.resolve(process.cwd(), 'config.yaml');
  try {
    if (fs.existsSync(cfgPath)) {
      const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
      return cfg;
    }
  } catch (e) { if (process?.env?.DEBUG) console.warn('config load error:', e.message || e); }
  return {};
}

function getInputDir(cfg, argDir) {
  if (argDir) return argDir;
  if (cfg.standardize && cfg.standardize.inputDir) return cfg.standardize.inputDir;
  if (cfg.inputDir) return cfg.inputDir;
  if (cfg.directories && cfg.directories.inputDir) return cfg.directories.inputDir;
  return 'input';
}

function parseAspectValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v > 0 ? +v : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  // 支持 "9:16"、"16:9"
  const m = s.split(':');
  if (m.length === 2) {
    const a = parseFloat(m[0]);
    const b = parseFloat(m[1]);
    if (a > 0 && b > 0) return a / b;
  }
  return null;
}

function pickStandardizeOptions(cfg) {
  const s = cfg.standardize || {};
  const opt = {
    // 判断条件
    requirePixFmt: s.requirePixFmt || 'yuv420p',
    requireSar1: s.requireSar1 !== undefined ? !!s.requireSar1 : true,
    targetFps: Number.isFinite(+s.targetFps) ? +s.targetFps : null, // 例如 30（null 表示不强制）
    // 目标显示宽高比（DAR）与处理模式
    targetAspectRatio: parseAspectValue(s.targetAspectRatio ?? '9:16'),
    aspectMode: (s.aspectMode || 'pad').toLowerCase(), // pad|crop|none
    padColor: s.padColor || 'black',
    // 最小分辨率设置
    ensureMinResolution: s.ensureMinResolution !== undefined ? !!s.ensureMinResolution : false,
    minWidth: Number.isFinite(+s.minWidth) ? +s.minWidth : null,
    minHeight: Number.isFinite(+s.minHeight) ? +s.minHeight : null,
    scaleFlags: s.scaleFlags || 'bicubic',
    // 输出编码
    videoCodec: s.videoCodec || cfg.ffmpegVideoCodec || 'libx264', // libx264|h264_nvenc|h264_amf
    x264Preset: cfg.ffmpegPreset || 'veryfast',
    nvencPreset: cfg.ffmpegNvencPreset || 'p5',
    amfQuality: cfg.ffmpegAmfQuality || 'balanced',
    threads: Number.isFinite(cfg.ffmpegThreads) ? cfg.ffmpegThreads : 0,
    crf: Number.isFinite(+s.crf) ? String(+s.crf) : '21',
    gop: Number.isFinite(+s.gop) ? +s.gop : 60,
    // 音频
    aCodec: s.audioCodec || 'aac',
    aBitrate: s.audioBitrate || '128k',
    aChannels: Number.isFinite(+s.audioChannels) ? +s.audioChannels : 2,
    aRate: Number.isFinite(+s.audioRate) ? +s.audioRate : 44100,
    // 输出位置
    outSuffix: s.outputDirSuffix || '_std'
  };
  return opt;
}

async function ffprobeOne(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      file
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.on('close', () => {
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
    p.on('error', reject);
  });
}

async function walkDir(dir) {
  const out = [];
  async function walk(d) {
    let entries; try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (VIDEO_EXTS.has(path.extname(ent.name).toLowerCase())) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

function parseRational(str) {
  if (!str) return undefined;
  if (typeof str === 'number') return str;
  const s = String(str);
  const m = s.split('/');
  if (m.length === 2) {
    const n = parseFloat(m[0]);
    const d = parseFloat(m[1]);
    if (d) return n / d;
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : undefined;
}

function needsStandardize(meta, opt) {
  const v = (meta.streams || []).find(s => s.codec_type === 'video') || {};
  const a = (meta.streams || []).find(s => s.codec_type === 'audio');
  const res = {
    codec: !/h264/i.test(v.codec_name || ''),
    pixFmt: opt.requirePixFmt ? (String(v.pix_fmt).toLowerCase() !== String(opt.requirePixFmt).toLowerCase()) : false,
    sar: opt.requireSar1 ? (v.sample_aspect_ratio !== '1:1') : false,
    fps: false,
    aspect: false,
    minRes: false,
  };
  if (opt.targetFps) {
    const fps = parseRational(v.avg_frame_rate) || parseRational(v.r_frame_rate);
    if (!fps || Math.abs(fps - opt.targetFps) > 0.05) res.fps = true;
  }
  if (opt.targetAspectRatio && opt.aspectMode !== 'none') {
    const iw = v.width, ih = v.height;
    if (Number.isFinite(iw) && Number.isFinite(ih) && ih > 0) {
      const dar = iw / ih;
      if (Math.abs(dar - opt.targetAspectRatio) > 0.01) res.aspect = true;
    }
  }
  if (opt.ensureMinResolution && Number.isFinite(opt.minWidth) && Number.isFinite(opt.minHeight)) {
    const iw = v.width, ih = v.height;
    if (Number.isFinite(iw) && Number.isFinite(ih)) {
      if (iw < opt.minWidth || ih < opt.minHeight) res.minRes = true;
    }
  }
  // 若任一条件为 true，则需要标准化
  const need = Object.values(res).some(Boolean);
  return { need, detail: res, hasAudio: !!a };
}

let __resolvedCodec = null; // 'libx264'|'h264_nvenc'|'h264_amf'
async function detectAvailableCodec(preferred) {
  if (__resolvedCodec) return __resolvedCodec;
  let out = '';
  try {
    const p = spawn('ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => out += d.toString());
    await new Promise(r => p.on('close', () => r()));
  } catch (e) {
    if (process?.env?.DEBUG) console.warn('ffmpeg -encoders probe1 error:', e.message || e);
    try {
      const p2 = spawn('ffmpeg', ['-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
      p2.stdout.on('data', d => out += d.toString());
      p2.stderr.on('data', d => out += d.toString());
      await new Promise(r => p2.on('close', () => r()));
    } catch (e2) {
      if (process?.env?.DEBUG) console.warn('ffmpeg -encoders probe2 error:', e2.message || e2);
      __resolvedCodec = 'libx264';
      return __resolvedCodec;
    }
  }
  const has = (name) => new RegExp(`\\b${name}\\b`, 'i').test(out);
  const pref = String(preferred || '').toLowerCase();
  if (pref === 'h264_amf') {
    __resolvedCodec = has('h264_amf') ? 'h264_amf' : (has('h264_nvenc') ? 'h264_nvenc' : 'libx264');
  } else if (pref === 'h264_nvenc') {
    __resolvedCodec = has('h264_nvenc') ? 'h264_nvenc' : (has('h264_amf') ? 'h264_amf' : 'libx264');
  } else {
    __resolvedCodec = has('libx264') ? 'libx264' : (has('h264_amf') ? 'h264_amf' : (has('h264_nvenc') ? 'h264_nvenc' : 'libx264'));
  }
  if (__resolvedCodec !== pref) console.log(`编码器已回退：${pref} -> ${__resolvedCodec}`);
  return __resolvedCodec;
}

// 根据不同编码器返回更兼容、更稳妥的参数
async function buildVideoArgs(opt, forceCodec) {
  const codec = forceCodec || await detectAvailableCodec(opt.videoCodec);
  const args = [];
  if (codec === 'h264_nvenc') {
    // NVENC：尽量使用通用参数，避免旧版 ffmpeg 不识别 crf
    args.push('-c:v', 'h264_nvenc', '-preset', opt.nvencPreset);
    args.push('-rc', 'vbr_hq', '-cq', String(opt.crf)); // 质量优先
    args.push('-b:v', '0'); // 允许可变码率
    args.push('-g', String(opt.gop));
  } else if (codec === 'h264_amf') {
    // AMF：使用质量参数而非 crf（兼容旧版）
    args.push('-c:v', 'h264_amf');
    args.push('-quality', opt.amfQuality); // speed/balanced/quality
    // 使用 -q:v 控制质量（某些版本支持），否则忽略
    args.push('-q:v', String(opt.crf));
    args.push('-g', String(opt.gop));
  } else {
    // libx264：最稳妥
    args.push('-c:v', 'libx264', '-preset', opt.x264Preset, '-g', String(opt.gop), '-crf', String(opt.crf));
    if (opt.threads && opt.threads > 0) args.push('-threads', String(opt.threads));
    // 提升兼容性
    args.push('-profile:v', 'high', '-level', '4.1');
  }
  // 像素格式
  if (opt.requirePixFmt) args.push('-pix_fmt', opt.requirePixFmt);
  // 输出容器为 mp4 时确保 CFR（若设置 targetFps）
  if (opt.targetFps) args.push('-vsync', 'cfr');
  return { args, codec };
}

function ensureMp4Path(p) {
  const dir = path.dirname(p);
  const base = path.basename(p, path.extname(p));
  return path.join(dir, base + '.mp4');
}

async function validateOutput(outPath) {
  try {
    const stat = await fs.stat(outPath);
    if (!stat.isFile() || stat.size < 1024) return false;
  } catch { return false; }
  try {
    const meta = await ffprobeOne(outPath);
    const v = (meta.streams || []).find(s => s.codec_type === 'video');
    if (!v) return false;
    const dur = parseFloat(meta.format?.duration || '0');
    if (!Number.isFinite(dur) || dur <= 0) return false;
    return true;
  } catch {
    return false;
  }
}

function roundEven(n) {
  n = Math.round(n);
  return n % 2 === 0 ? n : n + 1;
}

function computeScaledSize(iw, ih, opt) {
  if (!opt.ensureMinResolution || !Number.isFinite(opt.minWidth) || !Number.isFinite(opt.minHeight)) {
    return { w: roundEven(iw), h: roundEven(ih) };
  }
  const s = Math.max(1, opt.minWidth / iw, opt.minHeight / ih);
  return { w: roundEven(iw * s), h: roundEven(ih * s) };
}

function buildNumericAspectFilters(w, h, opt) {
  if (!opt.targetAspectRatio || opt.aspectMode === 'none') return [];
  const R = opt.targetAspectRatio;
  const curR = w / h;
  if (Math.abs(curR - R) < 0.001) return [];
  if (opt.aspectMode === 'pad') {
    if (curR < R) {
      const padW = roundEven(h * R);
      const padH = h;
      const x = Math.floor((padW - w) / 2);
      const y = 0;
      return [`pad=${padW}:${padH}:${x}:${y}:${opt.padColor}`];
    } else {
      const padW = w;
      const padH = roundEven(w / R);
      const x = 0;
      const y = Math.floor((padH - h) / 2);
      return [`pad=${padW}:${padH}:${x}:${y}:${opt.padColor}`];
    }
  }
  if (opt.aspectMode === 'crop') {
    if (curR > R) {
      const cropW = roundEven(h * R);
      const cropH = h;
      const x = Math.floor((w - cropW) / 2);
      const y = 0;
      return [`crop=${cropW}:${cropH}:${x}:${y}`];
    } else {
      const cropW = w;
      const cropH = roundEven(w / R);
      const x = 0;
      const y = Math.floor((h - cropH) / 2);
      return [`crop=${cropW}:${cropH}:${x}:${y}`];
    }
  }
  return [];
}

async function standardizeOne(input, outPath, opt, need, hasAudio, forceCodec, dims) {
  await fs.ensureDir(path.dirname(outPath));
  const vf = [];
  if (opt.requireSar1) vf.push('setsar=1');

  // 依赖 ffprobe 宽高，预计算常量尺寸/位置，避免使用表达式以兼容旧版 ffmpeg
  const iw = dims?.w;
  const ih = dims?.h;
  // 若未传 dims，则回退为不缩放，仅做后续滤镜
  const scaled = (Number.isFinite(iw) && Number.isFinite(ih)) ? computeScaledSize(iw, ih, opt) : null;
  if (scaled) vf.push(`scale=${scaled.w}:${scaled.h}:flags=${opt.scaleFlags}`);

  if (opt.targetFps) vf.push(`fps=${opt.targetFps}`);

  if (scaled) vf.push(...buildNumericAspectFilters(scaled.w, scaled.h, opt));

  const filter = vf.length ? ['-vf', vf.join(',')] : [];

  const { args: vArgs, codec: _usedCodec } = await buildVideoArgs(opt, forceCodec);
  const aArgs = hasAudio ? ['-map', '0:a:0', '-c:a', opt.aCodec, '-b:a', opt.aBitrate, '-ac', String(opt.aChannels), '-ar', String(opt.aRate)] : ['-an'];

  const args = [
    '-fflags', '+genpts',
    '-i', input.replace(/\\/g, '/'),
    '-map', '0:v:0',
    ...filter,
    ...vArgs,
    ...aArgs,
    '-sn',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-y', outPath.replace(/\\/g, '/')
  ];
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: 'pipe' });
    let err = '';
    ff.stderr.on('data', d => { err += d.toString(); });
    ff.on('close', async (c) => {
      if (c !== 0) return reject(new Error(err || 'ffmpeg error'));
      const ok = await validateOutput(outPath);
      if (!ok) {
        try {
          await fs.remove(outPath).catch(() => {});
          const { args: vArgs2 } = await buildVideoArgs({ ...opt, videoCodec: 'libx264' }, 'libx264');
          const args2 = [
            '-fflags', '+genpts',
            '-i', input.replace(/\\/g, '/'),
            '-map', '0:v:0',
            ...filter,
            ...vArgs2,
            ...aArgs,
            '-sn',
            '-movflags', '+faststart',
            '-f', 'mp4',
            '-y', outPath.replace(/\\/g, '/')
          ];
          await new Promise((res2, rej2) => {
            const ff2 = spawn('ffmpeg', args2, { stdio: 'pipe' });
            let err2 = '';
            ff2.stderr.on('data', d => { err2 += d.toString(); });
            ff2.on('close', async (c2) => {
              if (c2 !== 0) return rej2(new Error(err2 || 'ffmpeg error'));
              const ok2 = await validateOutput(outPath);
              if (!ok2) return rej2(new Error('输出文件校验失败（可能 moov 缺失或封装不完整）'));
              res2();
            });
            ff2.on('error', rej2);
          });
          resolve();
        } catch (e2) {
          reject(e2);
        }
      } else {
        resolve();
      }
    });
    ff.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const opt = pickStandardizeOptions(cfg);
  const dirRel = getInputDir(cfg, args.dir);
  const root = path.resolve(process.cwd(), dirRel);
  const overwrite = !!args.overwrite;
  const dryRun = !!args.dryRun;

  if (!fs.existsSync(root)) {
    console.error(`目录不存在: ${root}`);
    process.exit(1);
  }

  console.log(`扫描目录: ${root}`);
  const files = await walkDir(root);
  const plan = [];

  for (const f of files) {
    try {
      const meta = await ffprobeOne(f);
      const { need, detail, hasAudio } = needsStandardize(meta, opt);
      if (!need) continue;
      const v = (meta.streams || []).find(s => s.codec_type === 'video') || {};
      const iw = Number(v.width) || undefined;
      const ih = Number(v.height) || undefined;
      let outPath;
      if (overwrite) {
        outPath = ensureMp4Path(f + '.std.tmp');
      } else {
        const rel = path.relative(root, f);
        outPath = ensureMp4Path(path.join(root, opt.outSuffix, rel));
      }
      plan.push({ input: f, outPath, hasAudio, detail, iw, ih });
    } catch (e) {
      console.warn('跳过（ffprobe失败）:', f, e.message || e);
    }
  }

  if (!plan.length) {
    console.log('所有视频均已满足标准，无需处理。');
    return;
  }

  console.log(`需要标准化的视频: ${plan.length} 个`);
  if (dryRun) {
    for (const p of plan) {
      console.log('[DryRun] 标准化 =>', path.basename(p.input), '->', p.outPath);
    }
    return;
  }

  const bar = new ProgressBar('标准化处理中 [:bar] :current/:total :percent :etas', { total: plan.length, width: 26 });
  for (const p of plan) {
    const { input, outPath, hasAudio, iw, ih } = p;
    try {
      await standardizeOne(input, outPath, opt, p.detail, hasAudio, undefined, { w: iw, h: ih });
      if (overwrite) {
        await fs.move(outPath, ensureMp4Path(input), { overwrite: true });
      }
    } catch (e) {
      console.error('标准化失败:', path.basename(input), e.message || e);
      try { await fs.remove(outPath); } catch {}
    }
    bar.tick();
  }

  if (!overwrite) {
    console.log(`完成。输出目录位于: ${path.join(root, opt.outSuffix)}`);
  } else {
    console.log('完成。已覆盖原文件。');
  }
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
