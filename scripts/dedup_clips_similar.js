const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { getClipDuration } = require('./video_utils');

// 读取配置
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../config.yaml'), 'utf8'));
const clipsDir = path.join(__dirname, '../', config.clipsDir || 'clips');
const tmpDir = path.join(__dirname, '../clips_tmp');

// 计算aHash（均值哈希），动态import Jimp，兼容所有版本和导出结构
async function aHash(imagePath) {
  let Jimp = await import('jimp');
  Jimp = Jimp.default || Jimp;
  const JimpClass = Jimp.Jimp || Jimp;
  let img;
  if (typeof JimpClass.read === 'function') {
    img = await JimpClass.read(imagePath);
  } else if (typeof JimpClass === 'function') {
    img = await new JimpClass(imagePath);
  } else if (typeof Jimp.read === 'function') {
    img = await Jimp.read(imagePath);
  } else if (typeof Jimp === 'function') {
    img = await new Jimp(imagePath);
  } else {
    console.error('Jimp导出结构:', Object.keys(Jimp));
    throw new Error('Jimp导入异常: ' + JSON.stringify(Object.keys(Jimp)));
  }
  img.resize(8, 8).grayscale();
  let mean = 0;
  const pixels = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = img.getPixelColor(x, y) & 0xff;
      pixels.push(v);
      mean += v;
    }
  }
  mean /= 64;
  return pixels.map(v => v > mean ? 1 : 0).join('');
}

// 汉明距离
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

(async () => {
  await fs.ensureDir(tmpDir);
  const files = fs.readdirSync(clipsDir).filter(f => /\.(mp4|mov|avi|mkv)$/i.test(f));
  const infoList = [];
  for (const file of files) {
    const filePath = path.join(clipsDir, file);
    try {
      console.log(`处理片段: ${file}`);
      const duration = await getClipDuration(filePath);
      // 抽取帧位置（默认10%、50%、90%）
      const framePositions = config.dedup?.frame_positions || [10, 50, 90];
      const percents = framePositions.map(p => p / 100);
      const hashes = [];
      for (let idx = 0; idx < percents.length; idx++) {
        const ts = (duration * percents[idx]).toFixed(2);
        const imgPath = path.join(tmpDir, `${file}_${idx}.jpg`);
        spawnSync('ffmpeg', ['-y', '-ss', ts, '-i', filePath, '-frames:v', '1', imgPath], { stdio: 'ignore' });
        if (!fs.existsSync(imgPath)) {
          console.error(`抽帧失败: ${file} 第${idx+1}帧`);
          hashes.push('0'.repeat(64));
          continue;
        }
        const hash = await aHash(imgPath);
        hashes.push(hash);
      }
      infoList.push({ file, hash: hashes.join('') });
      console.log(`片段: ${file} 多帧哈希计算完成`);
    } catch (e) {
      console.error(`处理片段出错: ${file}`, e);
    }
  }
  // 两两对比
  let compareCount = 0;
  const totalCompares = (infoList.length * (infoList.length - 1)) / 2;
  for (let i = 0; i < infoList.length; i++) {
    for (let j = i + 1; j < infoList.length; j++) {
      compareCount++;
      if (compareCount % 10 === 0 || compareCount === totalCompares) {
        console.log(`对比进度: ${compareCount}/${totalCompares}`);
      }
      const d = hamming(infoList[i].hash, infoList[j].hash);
      const sim = ((192 - d) / 192 * 100).toFixed(1);
      const threshold = config.dedup?.similarity_threshold || 85;
      if (sim >= threshold) {
        console.log(`${infoList[i].file} 和 ${infoList[j].file} 相似度: ${sim}% (汉明距离${d})`);
      }
    }
  }
  // 清理临时图片
  fs.removeSync(tmpDir);
})(); 