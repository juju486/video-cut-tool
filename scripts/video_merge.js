#!/usr/bin/env node
/**
 * 视频合并工具
 * 支持将两个目录中的视频按顺序合并成一个视频
 * 
 * 配置来源：config.yaml -> videoMerge
 *   - videoMerge.inputDirs:  输入视频目录列表（A视频和B视频目录）
 *   - videoMerge.outputDir:  合并后视频输出目录
 *   - videoMerge.mergeMode:  合并模式 (sequential | cross)
 * 
 * 用法：
 *   node scripts/video_merge.js
 */

const yaml = require('js-yaml');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const ProgressBar = require('progress');

// 读取配置
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../config.yaml'), 'utf8'));
const videoMergeConfig = config.videoMerge || {};

// 获取输入目录和输出目录
const inputDirs = videoMergeConfig.inputDirs || ['merge/videoA', 'merge/videoB'];
const outputDir = videoMergeConfig.outputDir || 'merge/output';
const mergeMode = videoMergeConfig.mergeMode || 'sequential'; // sequential 或 cross

// 解析为绝对路径
const projectRoot = path.join(__dirname, '../');
const resolvedInputDirs = inputDirs.map(dir => path.isAbsolute(dir) ? dir : path.join(projectRoot, dir));
const resolvedOutputDir = path.isAbsolute(outputDir) ? outputDir : path.join(projectRoot, outputDir);

console.log('视频合并工具');
console.log('输入目录A:', resolvedInputDirs[0]);
console.log('输入目录B:', resolvedInputDirs[1]);
console.log('输出目录:', resolvedOutputDir);
console.log('合并模式:', mergeMode);

// 支持的视频文件扩展名
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm']);

// 获取目录中的视频文件
function getVideoFiles(dir) {
  try {
    const files = fs.readdirSync(dir);
    return files
      .filter(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
      .map(f => path.join(dir, f))
      .sort();
  } catch (err) {
    console.error(`读取目录失败: ${dir}`, err.message);
    return [];
  }
}

// 确保输出目录存在
async function ensureOutputDir() {
  try {
    await fs.ensureDir(resolvedOutputDir);
  } catch (err) {
    console.error(`创建输出目录失败: ${resolvedOutputDir}`, err.message);
    throw err;
  }
}

// 合并两个视频文件
function mergeTwoVideos(videoA, videoB, outputPath) {
  return new Promise((resolve, reject) => {
    // 创建临时文件列表
    const listFile = path.join(resolvedOutputDir, `temp_list_${Date.now()}.txt`);
    const listContent = [
      `file '${videoA.replace(/\\/g, '/')}'`,
      `file '${videoB.replace(/\\/g, '/')}'`
    ].join('\n');
    
    fs.writeFileSync(listFile, listContent);
    
    // 使用ffmpeg合并视频
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath
    ];
    
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'pipe' });
    
    let stderrData = '';
    ffmpeg.stderr.on('data', chunk => {
      stderrData += chunk.toString();
    });
    
    ffmpeg.on('close', code => {
      // 清理临时文件
      try {
        fs.unlinkSync(listFile);
      } catch (err) {
        console.warn('清理临时文件失败:', err.message);
      }
      
      if (code === 0) {
        resolve();
      } else {
        console.error('FFmpeg 错误输出:', stderrData);
        reject(new Error(`ffmpeg 合并失败 (code: ${code})`));
      }
    });
    
    ffmpeg.on('error', err => {
      // 清理临时文件
      try {
        fs.unlinkSync(listFile);
      } catch (e) {
        console.warn('清理临时文件失败:', e.message);
      }
      reject(err);
    });
  });
}

// 按顺序合并模式
async function mergeSequential(videoFilesA, videoFilesB) {
  console.log('使用顺序合并模式');
  
  const count = Math.min(videoFilesA.length, videoFilesB.length);
  if (count === 0) {
    console.log('没有找到可合并的视频文件');
    return;
  }
  
  console.log(`找到 ${count} 对视频文件`);
  
  const bar = new ProgressBar('合并进度 [:bar] :current/:total', {
    total: count,
    width: 30
  });
  
  for (let i = 0; i < count; i++) {
    const videoA = videoFilesA[i];
    const videoB = videoFilesB[i];
    // 使用两个文件名组合作为输出文件名
    const nameA = path.parse(videoA).name;
    const nameB = path.parse(videoB).name;
    const outputName = `${nameA}_${nameB}.mp4`;
    const outputPath = path.join(resolvedOutputDir, outputName);
    
    try {
      await mergeTwoVideos(videoA, videoB, outputPath);
      bar.tick();
    } catch (err) {
      console.error(`合并第 ${i + 1} 对视频失败:`, err.message);
    }
  }
  
  console.log('顺序合并完成');
}

// 交叉合并模式
async function mergeCross(videoFilesA, videoFilesB) {
  console.log('使用交叉合并模式');
  
  const countA = videoFilesA.length;
  const countB = videoFilesB.length;
  
  if (countA === 0 || countB === 0) {
    console.log('没有找到可合并的视频文件');
    return;
  }
  
  console.log(`目录A有 ${countA} 个视频，目录B有 ${countB} 个视频`);
  
  const total = countA * countB;
  const bar = new ProgressBar('合并进度 [:bar] :current/:total', {
    total: total,
    width: 30
  });
  
  for (let i = 0; i < countA; i++) {
    for (let j = 0; j < countB; j++) {
      const videoA = videoFilesA[i];
      const videoB = videoFilesB[j];
      // 使用两个文件名组合作为输出文件名
      const nameA = path.parse(videoA).name;
      const nameB = path.parse(videoB).name;
      const outputName = `${nameA}_${nameB}.mp4`;
      const outputPath = path.join(resolvedOutputDir, outputName);
      
      try {
        await mergeTwoVideos(videoA, videoB, outputPath);
        bar.tick();
      } catch (err) {
        console.error(`合并视频 ${path.basename(videoA)} 和 ${path.basename(videoB)} 失败:`, err.message);
      }
    }
  }
  
  console.log('交叉合并完成');
}

// 主函数
async function main() {
  try {
    // 检查输入目录是否存在
    for (let i = 0; i < resolvedInputDirs.length; i++) {
      const dir = resolvedInputDirs[i];
      if (!fs.existsSync(dir)) {
        console.error(`输入目录不存在: ${dir}`);
        process.exit(1);
      }
    }
    
    // 确保输出目录存在
    await ensureOutputDir();
    
    // 获取视频文件列表
    const videoFilesA = getVideoFiles(resolvedInputDirs[0]);
    const videoFilesB = getVideoFiles(resolvedInputDirs[1]);
    
    console.log(`目录A中找到 ${videoFilesA.length} 个视频文件`);
    console.log(`目录B中找到 ${videoFilesB.length} 个视频文件`);
    
    if (videoFilesA.length === 0 || videoFilesB.length === 0) {
      console.error('至少有一个目录中没有找到视频文件');
      process.exit(1);
    }
    
    // 根据合并模式执行合并
    if (mergeMode === 'sequential') {
      await mergeSequential(videoFilesA, videoFilesB);
    } else if (mergeMode === 'cross') {
      await mergeCross(videoFilesA, videoFilesB);
    } else {
      console.error(`不支持的合并模式: ${mergeMode}`);
      process.exit(1);
    }
    
    console.log('视频合并完成');
    console.log('输出目录:', resolvedOutputDir);
  } catch (err) {
    console.error('执行失败:', err.message);
    process.exit(1);
  }
}

// 执行主函数
if (require.main === module) {
  main();
}

module.exports = {
  mergeTwoVideos,
  getVideoFiles
};