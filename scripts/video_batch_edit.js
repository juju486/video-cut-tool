const { spawn } = require('child_process');
const path = require('path');

function runScript(script, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [script, ...args], { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

(async () => {
  try {
    console.log('=== 开始分割片段 ===');
    await runScript(path.join(__dirname, 'video_split.js'));
    console.log('=== 分割完成，开始合成 ===');
    await runScript(path.join(__dirname, 'video_concat.js'));
    console.log('=== 全部完成 ===');
  } catch (e) {
    console.error('批处理出错:', e);
  }
})();
