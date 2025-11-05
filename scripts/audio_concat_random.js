#!/usr/bin/env node
/**
 * 随机从指定目录或目录组中选择音频进行拼接，输出为新的音频文件。
 *
 * 配置来源：config.yaml -> audioConcat
 *   - audioConcat.inputDir:   输入目录（可以是字符串或字符串数组；递归扫描）
 *     · 若为单个目录：每次随机选取两个不同音频拼接
 *     · 若为多个目录：每次从每个目录各随机选取一个音频，按目录顺序拼接成一个
 *   - audioConcat.outputDir:  输出目录
 *   - audioConcat.generateCount:  生成个数
 *   - audioConcat.firstAudio:     指定第一个音频文件名（可选，基于项目根目录的相对路径）
 * 若未配置，回退：
 *   - 输入目录使用 config.musicDir 或 'music'
 *   - 输出目录使用 'music/concat'
 *   - 生成个数默认 10
 *
 * 产物：
 *   - 每次运行只生成一个清单 JSON（concat_manifest_YYYYMMDD_HHMMSS.json），记录本次所有输出文件与来源；不再为每个音频生成单独 JSON。
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
  } catch {}
  const ac = cfg.audioConcat || {};
  const inputDirRaw = ac.inputDir ?? cfg.musicDir ?? 'music';
  const inputDirs = Array.isArray(inputDirRaw) ? inputDirRaw.filter(Boolean) : [inputDirRaw];
  const outputDir = ac.outputDir || 'music/concat';
  const generateCount = Number.isFinite(+ac.generateCount) ? +ac.generateCount : 10;
  // 添加firstAudio配置项支持，基于项目根目录的相对路径
  const firstAudio = ac.firstAudio || null;
  return { inputDirs, outputDir, generateCount, firstAudio };
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

function concatNAudios(files, outPath) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(files) || files.length < 2) return reject(new Error('至少需要2个音频才能拼接'));
    const args = [];
    const norm = files.map(f => f.replace(/\\/g, '/'));
    for (const f of norm) {
      args.push('-i', f);
    }
    const labels = norm.map((_, i) => `[${i}:a]`).join('');
    const filter = `${labels}concat=n=${norm.length}:v=0:a=1[aout]`;
    // 统一音频参数，确保兼容性
    args.push('-filter_complex', filter, '-map', '[aout]', '-c:a', 'libmp3lame', '-ar', '44100', '-ac', '2', '-b:a', '192k', '-y', outPath.replace(/\\/g, '/'));

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

function concatTwoAudios(a, b, outPath) {
  return concatNAudios([a, b], outPath);
}

async function main() {
  const { inputDirs, outputDir, generateCount, firstAudio } = loadConfig();
  const projectRoot = path.resolve(__dirname, '../');
  const inAbsList = inputDirs.map(d => path.resolve(projectRoot, d));
  const outAbs = path.resolve(projectRoot, outputDir);

  // 校验输入目录
  for (const p of inAbsList) {
    if (!fs.existsSync(p)) {
      console.error(`输入目录不存在: ${p}`);
      process.exit(1);
    }
  }
  await fs.ensureDir(outAbs);

  // 本次运行清单（单一 JSON）
  const startNow = new Date();
  const runTag = `${startNow.getFullYear()}${pad2(startNow.getMonth()+1)}${pad2(startNow.getDate())}_${pad2(startNow.getHours())}${pad2(startNow.getMinutes())}${pad2(startNow.getSeconds())}`;
  const manifest = {
    ts: startNow.toISOString(),
    inputDirs: inAbsList,
    outputDir: outAbs,
    generateCount,
    items: [],
  };
  const manifestPath = path.join(outAbs, `concat_manifest_${runTag}.json`);

  if (inAbsList.length === 1) {
    // 原有单目录逻辑：随机取两个音频
    manifest.mode = 'single';
    const inAbs = inAbsList[0];
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
      
      // 如果配置了firstAudio，则第一个音频固定使用指定的音频
      if (firstAudio) {
        // 查找指定的第一个音频（基于项目根目录的相对路径）
        const firstAudioPath = path.resolve(projectRoot, firstAudio);
        // 检查文件是否存在
        if (fs.existsSync(firstAudioPath)) {
          a = firstAudioPath;
        } else {
          // 如果找不到指定的音频，则随机选择
          const i1 = Math.floor(Math.random() * audios.length);
          a = audios[i1];
        }
        
        // 选择第二个音频，确保不与第一个音频相同
        let i2;
        do {
          i2 = Math.floor(Math.random() * audios.length);
        } while (audios[i2] === a && audios.length > 1);
        b = audios[i2];
      } else {
        // 原有逻辑：随机选择两个不同音频
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
      }

      const outName = makeOutName(i);
      const outPath = path.join(outAbs, outName);

      try {
        await concatTwoAudios(a, b, outPath);
        manifest.items.push({
          sources: [
            path.relative(inAbs, a).split(path.sep).join('/'),
            path.relative(inAbs, b).split(path.sep).join('/'),
          ],
          out: outName,
          ts: new Date().toISOString(),
        });
      } catch (e) {
        console.error(`第${i}个拼接失败:`, e.message || e);
      }
      bar.tick();
    }

    // 写入清单
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    console.log(`完成。输出目录: ${outAbs}，清单: ${manifestPath}`);
    return;
  }

  // 多目录逻辑：每次从每个目录各取一个，按目录顺序拼接
  manifest.mode = 'multi';
  const perDirAudios = [];
  for (const p of inAbsList) {
    const files = (await walkDir(p)).sort();
    if (!files.length) {
      console.error(`目录无有效音频: ${p}`);
      process.exit(1);
    }
    perDirAudios.push(files);
  }

  const bar = new ProgressBar('拼接音频(多目录) [:bar] :current/:total :etas', { total: generateCount, width: 26 });
  const usedCombos = new Set(); // 避免重复同一组合（按目录顺序）

  for (let i = 1; i <= generateCount; i++) {
    let picks = [], tries = 0;
    do {
      // 如果配置了firstAudio，则第一个目录使用指定的音频
      if (firstAudio && perDirAudios[0]) {
        // 查找指定的第一个音频（基于项目根目录的相对路径）
        const firstAudioPath = path.resolve(projectRoot, firstAudio);
        // 检查文件是否存在
        if (fs.existsSync(firstAudioPath)) {
          picks = [firstAudioPath];
        } else {
          // 如果找不到指定的音频，则随机选择
          picks = [perDirAudios[0][Math.floor(Math.random() * perDirAudios[0].length)]];
        }
      } else {
        // 原有逻辑：第一个目录随机选择
        picks = [perDirAudios[0][Math.floor(Math.random() * perDirAudios[0].length)]];
      }
      
      // 其他目录继续随机选择
      for (let j = 1; j < perDirAudios.length; j++) {
        picks.push(perDirAudios[j][Math.floor(Math.random() * perDirAudios[j].length)]);
      }
      
      const key = picks.join('||');
      if (!usedCombos.has(key)) {
        usedCombos.add(key);
        break;
      }
      tries++;
    } while (tries < 50);

    const outName = makeOutName(i);
    const outPath = path.join(outAbs, outName);

    try {
      await concatNAudios(picks, outPath);
      manifest.items.push({
        sources: picks.map((pp, idx) => path.relative(inAbsList[idx], pp).split(path.sep).join('/')),
        out: outName,
        ts: new Date().toISOString(),
      });
    } catch (e) {
      console.error(`第${i}个拼接失败:`, e.message || e);
    }
    bar.tick();
  }

  // 写入清单
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });

  console.log(`完成。输出目录: ${outAbs}，清单: ${manifestPath}`);
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});