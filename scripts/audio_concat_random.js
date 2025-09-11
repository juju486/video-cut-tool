#!/usr/bin/env node
/**
 * 随机从指定目录中选择两个音频进行拼接，输出为新的音频文件。
 *
 * 配置来源：config.yaml -> audioConcat
 *   - audioConcat.inputDir:   输入目录（递归扫描）
 *   - audioConcat.outputDir:  输出目录
 *   - audioConcat.generateCount:  生成个数
 * 若未配置，回退：
 *   - 输入目录使用 config.musicDir 或 'music'
 *   - 输出目录使用 'music/concat'
 *   - 生成个数默认 10
 *
 * 用法（PowerShell）：
 *   node scripts/audio_concat_random.js
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const ProgressBar = require('progress');
const { spawn } = require('child_process');

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.wma']);

function loadConfig() {
  const cfgPath = path.resolve(__dirname, '../config.yaml');
  let cfg = {};
  try {
    if (fs.existsSync(cfgPath)) {
      cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
    }
  } catch (_) {}
  const ac = cfg.audioConcat || {};
  const inputDir = ac.inputDir || cfg.musicDir || 'music';
  const outputDir = ac.outputDir || 'music/concat';
  const generateCount = Number.isFinite(+ac.generateCount) ? +ac.generateCount : 10;
  return { inputDir, outputDir, generateCount };
}

async function walkDir(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (AUDIO_EXTS.has(path.extname(ent.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function makeOutName(index) {
  const now = new Date();
  const tag = `${now.getFullYear()}${pad2(now.getMonth()+1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `audio_${tag}_${String(index).padStart(2, '0')}.mp3`;
}

function concatTwoAudios(a, b, outPath) {
  return new Promise((resolve, reject) => {
    const aN = a.replace(/\\/g, '/');
    const bN = b.replace(/\\/g, '/');
    const oN = outPath.replace(/\\/g, '/');
    const args = [
      '-i', aN,
      '-i', bN,
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[aout]',
      '-map', '[aout]',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-y', oN
    ];
    const ff = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderrData = '';
    ff.stderr.on('data', d => { stderrData += d.toString(); });
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg error code ${code}: ${stderrData}`));
    });
    ff.on('error', err => reject(err));
  });
}

async function main() {
  const { inputDir, outputDir, generateCount } = loadConfig();
  const inAbs = path.resolve(__dirname, '../', inputDir);
  const outAbs = path.resolve(__dirname, '../', outputDir);

  if (!fs.existsSync(inAbs)) {
    console.error(`输入目录不存在: ${inAbs}`);
    process.exit(1);
  }
  await fs.ensureDir(outAbs);

  const files = await walkDir(inAbs);
  const audios = files.sort();
  if (audios.length < 2) {
    console.error('可用音频少于2个，无法拼接');
    process.exit(1);
  }

  const bar = new ProgressBar('拼接音频 [:bar] :current/:total :etas', { total: generateCount, width: 26 });
  const usedPairs = new Set(); // 避免重复相同组合（无序对）

  for (let i = 1; i <= generateCount; i++) {
    // 随机选择两个不同音频
    let a, b, tries = 0;
    do {
      const i1 = Math.floor(Math.random() * audios.length);
      let i2 = Math.floor(Math.random() * audios.length);
      if (i2 === i1) i2 = (i2 + 1) % audios.length;
      a = audios[i1];
      b = audios[i2];
      const key = [a, b].sort().join('||');
      if (!usedPairs.has(key)) {
        usedPairs.add(key);
        break;
      }
      tries++;
    } while (tries < 50);

    const outName = makeOutName(i);
    const outPath = path.join(outAbs, outName);

    try {
      await concatTwoAudios(a, b, outPath);
      // 附带写一个简单的元信息
      const meta = {
        a: path.relative(inAbs, a).split(path.sep).join('/'),
        b: path.relative(inAbs, b).split(path.sep).join('/'),
        out: outName,
        ts: new Date().toISOString()
      };
      const metaPath = path.join(outAbs, outName.replace(/\.mp3$/i, '.json'));
      await fs.writeJson(metaPath, meta, { spaces: 2 });
    } catch (e) {
      console.error(`第${i}个拼接失败:`, e.message || e);
    }
    bar.tick();
  }

  console.log(`完成。输出目录: ${outAbs}`);
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
