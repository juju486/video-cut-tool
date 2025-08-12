const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');

// 读取配置
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../config.yaml'), 'utf8'));
const musicDir = path.join(__dirname, '../', config.musicDir || 'music');
const minAudioDuration = config.minAudioDuration || 30;  // 最小音频时长(秒)
const maxAudioDuration = config.maxAudioDuration || 180; // 最大音频时长(秒)
const enableAudioFilter = config.enableAudioFilter !== undefined ? config.enableAudioFilter : true;

// 创建筛选后的音频目录
const filteredAudioDir = path.join(musicDir, `${minAudioDuration}-${maxAudioDuration}`);

// 获取音频时长
async function getAudioDuration(filePath) {
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

// 筛选音频文件
async function filterAudioFiles() {
  if (!enableAudioFilter) {
    console.log('音频预筛选已禁用，跳过筛选过程');
    return;
  }

  console.log('开始筛选音频文件...');
  console.log(`音频目录: ${musicDir}`);
  console.log(`筛选条件: 时长在 ${minAudioDuration}s - ${maxAudioDuration}s 之间`);

  // 确保目标目录存在
  await fs.ensureDir(filteredAudioDir);
  // 清空目标目录
  const existingFiles = fs.readdirSync(filteredAudioDir);
  for (const file of existingFiles) {
    fs.unlinkSync(path.join(filteredAudioDir, file));
  }

  // 获取所有音频文件
  const audioFiles = fs.readdirSync(musicDir).filter(f => /\.(aac|mp3|wav|m4a)$/i.test(f));
  console.log(`找到 ${audioFiles.length} 个音频文件`);

  let validCount = 0;
  for (const file of audioFiles) {
    const filePath = path.join(musicDir, file);
    try {
      const duration = await getAudioDuration(filePath);
      console.log(`检查音频: ${file}, 时长: ${duration.toFixed(2)}s`);

      if (duration >= minAudioDuration && duration <= maxAudioDuration) {
        // 复制文件到筛选目录
        const destPath = path.join(filteredAudioDir, file);
        fs.copySync(filePath, destPath);
        validCount++;
        console.log(`√ 音频 ${file} 符合条件，已复制到 ${filteredAudioDir}`);
      } else {
        console.log(`× 音频 ${file} 时长 ${duration.toFixed(2)}s 不在范围内，跳过`);
      }
    } catch (error) {
      console.error(`处理音频 ${file} 时出错:`, error.message);
    }
  }

  console.log(`音频筛选完成，共 ${validCount} 个音频符合条件`);
  console.log(`符合条件的音频已保存至: ${filteredAudioDir}`);
}

// 执行筛选
filterAudioFiles().catch(err => {
  console.error('音频筛选失败:', err);
  process.exit(1);
});