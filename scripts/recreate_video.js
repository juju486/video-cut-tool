const yaml = require('js-yaml');
const fs = require('fs-extra');
const path = require('path');
const { concatClipsWithAudio } = require('./video_utils');

// 读取配置
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../config.yaml'), 'utf8'));
const outputDir = path.join(__dirname, '../', config.outputDir || 'output');
const musicDir = path.join(__dirname, '../', config.musicDir || 'music');

/**
 * 根据视频文件名和对应的JSON信息重新生成视频
 * @param {string} videoFileName - 视频文件名（不包含路径）
 */
async function recreateVideoFromJson(videoFileName) {
  console.log(`开始根据JSON信息重新生成视频: ${videoFileName}`);
  
  // 查找包含该视频的所有synthesis_log.json文件
  const logFiles = findSynthesisLogs(outputDir, videoFileName);
  
  if (logFiles.length === 0) {
    console.error(`未找到视频 ${videoFileName} 对应的合成记录`);
    return;
  }
  
  // 使用最新的合成记录
  const latestLogFile = logFiles[0];
  console.log(`使用合成记录文件: ${latestLogFile}`);
  
  // 读取合成记录
  const logData = JSON.parse(fs.readFileSync(latestLogFile, 'utf8'));
  const videoData = logData[videoFileName];
  
  if (!videoData) {
    console.error(`在合成记录中未找到视频 ${videoFileName} 的信息`);
    return;
  }
  
  // 获取视频所在的目录
  const videoDir = path.dirname(latestLogFile);
  console.log(`视频所在目录: ${videoDir}`);
  
  // 检查必要的信息是否存在
  if (!videoData.clips || !videoData.audio || 
      !videoData.openDir || !videoData.clipsDir || !videoData.musicDir) {
    console.error('合成记录缺少必要信息');
    return;
  }
  
  console.log('合成信息:');
  console.log(`  开头片段目录: ${videoData.openDir}`);
  console.log(`  片段目录: ${videoData.clipsDir}`);
  console.log(`  音频目录: ${videoData.musicDir}`);
  console.log(`  音频文件: ${videoData.audio}`);
  console.log(`  片段列表: ${JSON.stringify(videoData.clips, null, 2)}`);
  
  // 构建完整的片段路径
  const clipPaths = videoData.clips.map(clipId => {
    // 判断片段来自哪个目录，根据ID的格式判断
    // 如果ID包含路径分隔符，则认为是完整路径
    if (clipId.includes('/') || clipId.includes('\\')) {
      // 这种情况应该不会出现，但为了安全起见还是处理一下
      return path.join(videoData.clipsDir, `${clipId}.mp4`);
    } else if (clipId.startsWith('open_')) {
      // 开头片段
      return path.join(videoData.openDir, `${clipId}.mp4`);
    } else {
      // 普通片段
      return path.join(videoData.clipsDir, `${clipId}.mp4`);
    }
  });
  
  // 检查所有片段文件是否存在
  for (const clipPath of clipPaths) {
    if (!fs.existsSync(clipPath)) {
      console.error(`片段文件不存在: ${clipPath}`);
      return;
    }
  }
  
  // 构建音频文件路径
  const audioPath = path.join(videoData.musicDir, videoData.audio);
  if (!fs.existsSync(audioPath)) {
    console.error(`音频文件不存在: ${audioPath}`);
    return;
  }
  
  // 生成输出文件路径
  const outputPath = path.join(videoDir, `recreated_${videoFileName}`);
  
  console.log(`开始重新生成视频...`);
  console.log(`输出路径: ${outputPath}`);
  
  try {
    // 重新生成视频
    await concatClipsWithAudio(clipPaths, audioPath, outputPath, videoDir);
    console.log(`视频重新生成成功: ${outputPath}`);
  } catch (error) {
    console.error(`视频重新生成失败: ${error.message}`);
  }
}

/**
 * 在指定目录及其子目录中查找包含特定视频的synthesis_log.json文件
 * @param {string} rootDir - 根目录
 * @param {string} videoFileName - 视频文件名
 * @returns {Array<string>} 包含该视频的synthesis_log.json文件路径列表
 */
function findSynthesisLogs(rootDir, videoFileName) {
  const result = [];
  
  function walk(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (file === 'synthesis_log.json') {
        try {
          const logData = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          if (logData[videoFileName]) {
            result.push(fullPath);
          }
        } catch (e) {
          // 忽略无法解析的JSON文件
        }
      }
    }
  }
  
  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }
  
  // 按修改时间排序，最新的在前
  return result.sort((a, b) => {
    return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
  });
}

// 如果直接运行此脚本，则处理命令行参数
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.log('用法: node recreate_video.js <视频文件名>');
    console.log('示例: node recreate_video.js myvideo_20241024_1.mp4');
    process.exit(1);
  }
  
  recreateVideoFromJson(args[0]).catch(console.error);
}

module.exports = {
  recreateVideoFromJson
};