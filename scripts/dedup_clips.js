const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');
const { getClipDuration } = require('./video_utils');

// 读取配置
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../config.yaml'), 'utf8'));
const clipsDir = path.join(__dirname, '../', config.clipsDir || 'clips');

function getFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  });
}

(async () => {
  const files = fs.readdirSync(clipsDir).filter(f => /\.(mp4|mov|avi|mkv)$/i.test(f));
  const infoList = [];
  for (const file of files) {
    const filePath = path.join(clipsDir, file);
    const duration = await getClipDuration(filePath);
    const hash = await getFileHash(filePath);
    infoList.push({ file, duration: duration.toFixed(2), hash });
  }
  // 按时长+哈希分组
  const map = new Map();
  for (const info of infoList) {
    const key = `${info.duration}_${info.hash}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(info.file);
  }
  let hasDup = false;
  for (const [key, files] of map.entries()) {
    if (files.length > 1) {
      hasDup = true;
      console.log('检测到重复片段:', files);
    }
  }
  if (!hasDup) {
    console.log('未检测到完全重复的片段。');
  }
})(); 