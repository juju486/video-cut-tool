#!/usr/bin/env node
/**
 * 将指定文件夹下小于最小宽高的视频统一放大到不小于最小分辨率（等比缩放）。
 * 最小宽度/高度在 config.yaml 中定义：
 *   1) 优先读取：resizeMinWidth、resizeMinHeight（顶层）
 *   2) 其次读取：resize.minWidth、resize.minHeight（嵌套）
 *   3) 再次读取：minWidth、minHeight（顶层通用）
 * 参数：
 *   -d, --dir <path>  指定要扫描的目录（不传则用 config.yaml 的 inputDir，默认 input）
 *   --overwrite       覆盖原文件（默认不覆盖，输出到 目标目录/_resized/...）
 *   --dry-run         仅打印将要修改的文件，不实际处理
 *
 * 示例（PowerShell）：
 *   node video_resize_min_resolution.js -d "input/811"
 *   node video_resize_min_resolution.js --dir clips/811 --overwrite
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const ProgressBar = require('progress');
const ffmpeg = require('fluent-ffmpeg');

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
  } catch (_) {}
  return {};
}

function getConfigDir(cfg) {
  if (cfg.inputDir) return cfg.inputDir;
  if (cfg.directories && cfg.directories.inputDir) return cfg.directories.inputDir;
  return 'input';
}

function getMinResolution(cfg) {
  const pick = (obj, ...keys) => keys.find(k => obj && typeof obj[k] !== 'undefined');
  const wKey = pick(cfg, 'resizeMinWidth', 'minWidth');
  const hKey = pick(cfg, 'resizeMinHeight', 'minHeight');
  let minWidth = wKey ? Number(cfg[wKey]) : undefined;
  let minHeight = hKey ? Number(cfg[hKey]) : undefined;
  if ((!minWidth || !minHeight) && cfg.resize) {
    if (!minWidth && typeof cfg.resize.minWidth !== 'undefined') minWidth = Number(cfg.resize.minWidth);
    if (!minHeight && typeof cfg.resize.minHeight !== 'undefined') minHeight = Number(cfg.resize.minHeight);
  }
  if (!minWidth) minWidth = 720;
  if (!minHeight) minHeight = 1280;
  return { minWidth, minHeight };
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

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
}

function nextEven(n) { // 向上取偶，避免编码器报奇数尺寸
  const x = Math.ceil(n);
  return x % 2 === 0 ? x : x + 1;
}

async function ensureResized(input, outPath, outW, outH, overwrite) {
  await fs.ensureDir(path.dirname(outPath));
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(input)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-crf', '23',
        '-preset', 'medium',
        '-movflags', '+faststart'
      ])
      .size(`${outW}x${outH}`)
      .on('error', reject)
      .on('end', () => resolve());

    if (overwrite) {
      // 先写到临时文件再替换，避免中途失败损坏源文件
      const tmp = outPath + '.tmp.mp4';
      cmd = cmd.output(tmp).run();
      cmd.on('end', async () => {
        try {
          await fs.move(tmp, outPath, { overwrite: true });
          resolve();
        } catch (e) { reject(e); }
      });
    } else {
      cmd.output(outPath).run();
    }
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const { minWidth, minHeight } = getMinResolution(cfg);
  const dirRel = args.dir || getConfigDir(cfg);
  const targetDir = path.resolve(process.cwd(), dirRel);
  const overwrite = !!args.overwrite;
  const dryRun = !!args.dryRun;

  if (!fs.existsSync(targetDir)) {
    console.error(`目录不存在: ${targetDir}`);
    process.exit(1);
  }

  console.log(`扫描目录: ${targetDir}`);
  console.log(`最小分辨率: ${minWidth}x${minHeight}`);
  if (dryRun) console.log('[Dry Run] 仅预览将要处理的文件');

  const files = await walkDir(targetDir);

  const plan = [];
  for (const f of files) {
    try {
      const meta = await ffprobe(f);
      const v = (meta.streams || []).find(s => s.codec_type === 'video');
      const w = v?.width || 0;
      const h = v?.height || 0;
      if (!w || !h) continue;

      if (w >= minWidth && h >= minHeight) continue; // 已满足

      const scale = Math.max(minWidth / w, minHeight / h);
      const outW = nextEven(w * scale);
      const outH = nextEven(h * scale);

      let outPath;
      if (overwrite) {
        outPath = f; // 将采用临时文件写入再覆盖
      } else {
        // 输出到 目标目录/_resized/ 保留相对结构
        const rel = path.relative(targetDir, f);
        outPath = path.join(targetDir, '_resized', rel);
      }
      plan.push({ input: f, outPath, outW, outH, srcW: w, srcH: h });
    } catch (e) {
      console.warn(`跳过（ffprobe失败）: ${f} -> ${e.message || e}`);
    }
  }

  if (!plan.length) {
    console.log('所有视频均已满足最小分辨率，无需处理。');
    return;
  }

  console.log(`需要处理的视频: ${plan.length} 个`);
  const bar = new ProgressBar('处理 [:bar] :current/:total :percent :etas', { total: plan.length, width: 26 });

  for (const item of plan) {
    const { input, outPath, outW, outH, srcW, srcH } = item;
    const msg = `${path.basename(input)} ${srcW}x${srcH} -> ${outW}x${outH}`;
    if (dryRun) {
      console.log('[DryRun]', msg, '=>', outPath);
      bar.tick();
      continue;
    }

    try {
      await ensureResized(input, outPath, outW, outH, overwrite);
    } catch (e) {
      console.error('失败:', msg, e.message || e);
    }
    bar.tick();
  }

  if (!overwrite) {
    console.log(`完成。输出目录位于: ${path.join(targetDir, '_resized')}`);
  } else {
    console.log('完成。已覆盖原文件。');
  }
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
