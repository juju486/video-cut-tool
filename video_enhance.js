#!/usr/bin/env node
/**
 * 使用 Real-ESRGAN-ncnn-vulkan 提升视频分辨率和清晰度。
 *
 * 配置来源：config.yaml -> videoEnhance
 *   - videoEnhance.realesrganPath: 'realesrgan-ncnn-vulkan.exe' 的路径。
 *     默认会尝试在项目根目录下的 'real' 文件夹中寻找。
 *   - videoEnhance.input: 输入文件或目录。
 *   - videoEnhance.outputDir: 输出目录。
 *   - videoEnhance.model: 使用的 AI 模型，如 'realesrgan-x4plus' (默认) 或 'realesrgan-x4plus-anime'。
 *     模型文件需位于 realesrganPath 所在目录的 'models' 子文件夹中。
 *   - videoEnhance.suffix: 添加到输出文件名末尾的后缀，默认为 '_enhanced'。
 *   - videoEnhance.scale: 放大倍数，默认为 4。
 *
 * 用法（PowerShell）：
 *   node video_enhance.js
 *   node video_enhance.js -o path/to/custom_output
 *   node video_enhance.js --output path/to/custom_output
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const { spawn } = require('child_process');
const ProgressBar = require('progress');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm']);

function loadConfig() {
  const cfgPath = path.resolve(__dirname, 'config.yaml');
  let cfg = {};
  try {
    if (fs.existsSync(cfgPath)) {
      cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
    }
  } catch (e) {
    console.error('读取 config.yaml 失败:', e);
  }
  const ve = cfg.videoEnhance || {};
  return {
    realesrganPath: ve.realesrganPath || path.resolve(__dirname, 'real/realesrgan-ncnn-vulkan.exe'),
    input: ve.input,
    outputDir: ve.outputDir || 'output/enhanced',
    model: ve.model || 'realesrgan-x4plus',
    suffix: ve.suffix === '' ? '' : (ve.suffix || '_enhanced'),
        scale: ve.scale || 4,
        jobs: Number.isFinite(+ve.jobs) ? +ve.jobs : 1,
        resume: ve.resume === undefined ? true : !!ve.resume,
        targetWidth: ve.targetWidth || null,
        targetHeight: ve.targetHeight || null,
        scaleFlags: ve.scaleFlags || 'lanczos',
  };
}

async function findVideos(inputPath) {
    const stats = await fs.stat(inputPath);
    if (stats.isDirectory()) {
        const files = await fs.readdir(inputPath);
        return files
            .filter(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
            .map(f => path.join(inputPath, f));
    }
    if (stats.isFile() && VIDEO_EXTS.has(path.extname(inputPath).toLowerCase())) {
        return [inputPath];
    }
    return [];
}

function runCmd(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, opts);
        let stdout = '';
        let stderr = '';
        if (p.stdout) p.stdout.on('data', d => { stdout += d.toString(); });
        if (p.stderr) p.stderr.on('data', d => { stderr += d.toString(); });
        p.on('close', code => {
            resolve({ code, stdout, stderr });
        });
        p.on('error', err => reject(err));
    });
}

async function getVideoFps(file) {
    try {
        const res = await runCmd('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
        const txt = res.stdout.trim();
        if (!txt) return 25;
        // 格式如 30000/1001
        if (txt.includes('/')) {
            const [a, b] = txt.split('/').map(Number);
            if (b) return a / b;
        }
        return Number(txt) || 25;
    } catch {
        return 25;
    }
}

async function runEnhance(exePath, inFile, outDir, outName, model, scale, opts = {}) {
    // 保证绝对路径
    const exePathAbs = path.resolve(exePath);
    const inFileAbs = path.resolve(inFile);
    const outDirAbs = path.resolve(outDir);
    await fs.ensureDir(outDirAbs);

    const jobs = Number.isFinite(+opts.jobs) ? +opts.jobs : 1;
    const resume = opts.resume === undefined ? true : !!opts.resume;

    // 直接尝试视频模式
    const args = ['-i', inFileAbs, '-o', outName, '-n', model, '-s', String(scale), '-f', 'mp4'];
    console.log(`\n正在处理: ${path.basename(inFile)}`);
    console.log(`工作目录: ${outDirAbs}`);
    console.log(`尝试直接视频模式: "${exePathAbs}" ${args.join(' ')}`);

    try {
        const result = await runCmd(exePathAbs, args, { cwd: outDirAbs });
        if (result.code === 0) {
            console.log(`处理完成: ${outName}`);
            // 可选后处理缩放
            if (opts.targetWidth || opts.targetHeight) {
                await postScale(path.join(outDirAbs, outName), opts.targetWidth, opts.targetHeight, opts.scaleFlags);
            }
            return;
        }
        const combined = (result.stderr || '') + '\n' + (result.stdout || '');
        if (/invalid outputpath/i.test(combined) || /invalid output/i.test(combined)) {
            console.log('检测到 outputpath 问题，降级为帧级处理（抽帧 -> 逐帧增强 -> 重组）');
            // 进入回退流程
        } else {
            throw new Error(`Real-ESRGAN 退出，代码:${result.code}\n${combined}`);
        }
    } catch (err) {
        // 如果 spawn 本身出错，继续尝试回退
        console.log('直接视频模式调用失败，尝试回退处理，原因:', err.message || err);
    }

    // 回退：抽帧 -> 对每帧调用 Real-ESRGAN -> 重组并合并音频
    const tmpDir = path.join(outDirAbs, `.realesrgan_tmp_${Date.now()}`);
    const framesDir = path.join(tmpDir, 'frames');
    const enhancedDir = path.join(tmpDir, 'enhanced');
    await fs.ensureDir(framesDir);
    await fs.ensureDir(enhancedDir);

        // 提取音频与抽帧（若启用 resume 且已有临时目录则复用已有产物，避免重复抽取）
        const audioPath = path.join(tmpDir, 'audio.aac');
        const framePattern = path.join(framesDir, 'frame_%06d.png');
        const haveTmp = await fs.pathExists(tmpDir);
        const haveFrames = haveTmp && await fs.pathExists(framesDir) && (await fs.readdir(framesDir)).some(f => f.toLowerCase().endsWith('.png'));
        const haveAudio = haveTmp && await fs.pathExists(audioPath);

        if (resume && haveFrames) {
            console.log('发现已存在抽取帧，跳过抽帧步骤，复用临时数据');
        } else {
            console.log('抽取帧...');
            await runCmd('ffmpeg', ['-y', '-i', inFileAbs, framePattern]);
        }

        if (resume && haveAudio) {
            console.log('发现已存在音频，跳过音频提取');
        } else {
            console.log('提取音频...');
            await runCmd('ffmpeg', ['-y', '-i', inFileAbs, '-vn', '-acodec', 'copy', audioPath]);
        }

        // 逐帧增强 -> 并发处理 + 断点续传支持
        const frameFiles = (await fs.readdir(framesDir)).filter(f => f.toLowerCase().endsWith('.png')).sort();
    console.log(`逐帧增强 ${frameFiles.length} 张图片（并发 ${jobs}），支持断点续传: ${resume}`);

        const checkpointPath = path.join(tmpDir, 'checkpoint.json');
        let checkpoint = { done: {} };
        if (resume && await fs.pathExists(checkpointPath)) {
            try { checkpoint = await fs.readJson(checkpointPath); } catch { checkpoint = { done: {} }; }
        }

        const pending = frameFiles.filter(f => !checkpoint.done[f]);
        const frameBar = new ProgressBar('逐帧增强 [:bar] :current/:total :percent :etas', { total: frameFiles.length, width: 30 });
        // advance bar by already done
        const doneCount = frameFiles.length - pending.length;
        for (let i = 0; i < doneCount; i++) frameBar.tick();

        // worker 池
        let idx = 0;
        async function worker() {
            while (true) {
                let f;
                // fetch next
                if (idx >= pending.length) break;
                f = pending[idx++];
                const src = path.join(framesDir, f);
                const dst = path.join(enhancedDir, f);
                const a = ['-i', src, '-o', dst, '-n', model, '-s', String(scale), '-f', 'png'];
                try {
                    const r = await runCmd(exePathAbs, a, { cwd: tmpDir });
                    if (r.code !== 0) {
                        console.warn(`帧处理失败: ${f}，错误: ${r.stderr || r.stdout}`);
                        await fs.copyFile(src, dst).catch(() => {});
                    }
                } catch (err) {
                    console.warn(`帧处理异常: ${f}，错误: ${err.message || err}`);
                    await fs.copyFile(src, dst).catch(() => {});
                }
                checkpoint.done[f] = true;
                // 写回 checkpoint（小文件，频率可调）
                try { await fs.writeJson(checkpointPath, checkpoint, { spaces: 2 }); } catch { }
                frameBar.tick();
            }
        }

        const workers = [];
    const concurrency = Math.max(1, jobs || 1);
        for (let w = 0; w < concurrency; w++) workers.push(worker());
        await Promise.all(workers);

    // 重组视频（从增强帧），保持原始 fps
    const fps = await getVideoFps(inFileAbs);
    const outVideoNoAudio = path.join(tmpDir, 'video_noaudio.mp4');
    console.log('从增强帧重建视频...');
    await runCmd('ffmpeg', ['-y', '-r', String(fps), '-i', path.join(enhancedDir, 'frame_%06d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', outVideoNoAudio]);

    // 合并音频
    const finalOut = path.join(outDirAbs, outName);
    console.log('合并音频...');
    await runCmd('ffmpeg', ['-y', '-i', outVideoNoAudio, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', finalOut]);

    // 清理临时目录
    try { await fs.remove(tmpDir); } catch { }
    console.log(`回退流程完成: ${outName}`);
    // 可选后处理缩放
    if (opts.targetWidth || opts.targetHeight) {
        await postScale(finalOut, opts.targetWidth, opts.targetHeight, opts.scaleFlags);
    }
}

async function postScale(filePath, targetW, targetH, scaleFlags) {
    if (!targetW && !targetH) return;
    const dir = path.dirname(filePath);
    const name = path.basename(filePath, path.extname(filePath));
    const tmpOut = path.join(dir, `${name}_scaled${path.extname(filePath)}`);
    let scaleArg;
    if (targetW && targetH) scaleArg = `scale=${targetW}:${targetH}:flags=${scaleFlags}`;
    else if (targetW) scaleArg = `scale=${targetW}:-2:flags=${scaleFlags}`;
    else scaleArg = `scale=-2:${targetH}:flags=${scaleFlags}`;
    console.log(`执行后处理缩放 -> ${path.basename(tmpOut)} (${scaleArg})`);
    await runCmd('ffmpeg', ['-y', '-i', filePath, '-vf', scaleArg, '-c:a', 'copy', tmpOut]);
    try { await fs.move(tmpOut, filePath, { overwrite: true }); } catch { }
}

async function main() {
    const config = loadConfig();

    // 解析命令行参数以覆盖配置
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === '-o' || args[i] === '--output') && args[i + 1]) {
            config.outputDir = args[i + 1];
            i++; // 跳过下一个参数值
        } else if ((args[i] === '-j' || args[i] === '--jobs') && args[i + 1]) {
            config.jobs = Number(args[i + 1]) || config.jobs;
            i++;
        } else if (args[i] === '--no-resume') {
            config.resume = false;
        }
    }

    if (!config.input) {
        console.error('错误: 请在 config.yaml 中配置 videoEnhance.input (输入文件或目录)');
        return;
    }

    if (!fs.existsSync(config.realesrganPath)) {
        console.error(`错误: 未找到 Real-ESRGAN 程序, 路径: ${config.realesrganPath}`);
        console.error('请从 https://github.com/xinntao/Real-ESRGAN/releases 下载并解压到项目根目录的 "real" 文件夹, 或在 config.yaml 中指定正确路径。');
        return;
    }

    const inputAbs = path.resolve(__dirname, config.input);
    const outputAbs = path.resolve(__dirname, config.outputDir);

    if (!fs.existsSync(inputAbs)) {
        console.error(`错误: 输入路径不存在: ${inputAbs}`);
        return;
    }

    await fs.ensureDir(outputAbs);

    const videoFiles = await findVideos(inputAbs);

    if (videoFiles.length === 0) {
        console.log('在指定路径下未找到可处理的视频文件。');
        return;
    }

    console.log(`找到 ${videoFiles.length} 个视频文件待处理。`);
    const bar = new ProgressBar('增强进度 [:bar] :current/:total (:percent) :etas', {
        total: videoFiles.length,
        width: 40,
    });

    for (const file of videoFiles) {
        const baseName = path.basename(file, path.extname(file));
        const outName = `${baseName}${config.suffix}.mp4`;
        
        try {
            // 调用更新后的函数，传入并发与续传选项
            await runEnhance(config.realesrganPath, file, outputAbs, outName, config.model, config.scale, { jobs: config.jobs, resume: config.resume });
        } catch (e) {
            console.error(`\n处理 ${path.basename(file)} 时发生错误:`, e.message);
        }
        bar.tick();
    }

    console.log(`\n全部处理完成！输出目录: ${outputAbs}`);
}

main().catch(err => {
    console.error('\n脚本执行失败:', err);
    process.exit(1);
});
