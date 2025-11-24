// 全局变量，用于跟踪当前任务状态
let currentTaskRunning = false;

document.addEventListener('DOMContentLoaded', async () => {
    // 加载配置信息
    await loadConfigInfo();
    
    // 绑定按钮事件
    document.getElementById('split-btn').addEventListener('click', runSplit);
    document.getElementById('concat-btn').addEventListener('click', runConcat);
    document.getElementById('dedup-btn').addEventListener('click', runDedup);
    document.getElementById('audio-btn').addEventListener('click', runAudio);
    document.getElementById('clear-log').addEventListener('click', clearLog);
    document.getElementById('edit-config-file').addEventListener('click', openConfigEditor);
    document.getElementById('save-config').addEventListener('click', saveConfigChanges);
    document.getElementById('stop-task-btn').addEventListener('click', stopCurrentTask);
    document.getElementById('open-output-dir').addEventListener('click', openOutputDirectory);
    
    // 绑定目录选择按钮事件
    document.querySelectorAll('.btn-browse-config').forEach(button => {
        button.addEventListener('click', (event) => {
            const configType = event.target.getAttribute('data-config');
            selectDirectory(configType);
        });
    });
    
    // 绑定标签页切换事件
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => switchTab(item));
    });
    
    // 绑定配置编辑器事件
    document.querySelector('.close').addEventListener('click', closeConfigEditor);
    document.getElementById('save-config-file').addEventListener('click', saveConfigFile);
    document.getElementById('cancel-config-edit').addEventListener('click', closeConfigEditor);
    
    // 点击模态框外部关闭
    window.addEventListener('click', (event) => {
        const modal = document.getElementById('config-editor-modal');
        if (event.target === modal) {
            closeConfigEditor();
        }
    });
    
    // 绑定IPC事件
    window.electronAPI.onUpdateProgress((event, percentage) => {
        updateProgress(percentage);
    });
    
    window.electronAPI.onLogMessage((event, message) => {
        addLogMessage(message);
    });
    
    window.electronAPI.onUpdateProgressMessage((event, message) => {
        updateProgressMessage(message);
    });
    
    // 初始化统计数据
    updateStats();
});

// 引入需要的库
const jsyaml = require('js-yaml');

// 加载配置信息
async function loadConfigInfo() {
    try {
        // 从config.yaml文件中读取配置
        const config = await window.electronAPI.readConfig();
        
        // 设置表单字段的值
        document.getElementById('input-dir').value = config.inputDir || 'input';
        document.getElementById('clips-dir').value = config.clipsDir || 'clips';
        document.getElementById('music-dir').value = config.musicDir || 'music';
        document.getElementById('output-dir').value = config.outputDir || 'output';
        document.getElementById('video-name-prefix').value = config.videoNamePrefix || 'video';
        document.getElementById('num-new-videos').value = config.numNewVideos || 50;
        document.getElementById('scene-threshold').value = config.sceneThreshold !== undefined ? config.sceneThreshold : 0.3;
        
        // 更新侧边栏配置信息展示
        updateConfigDisplay();
    } catch (error) {
        console.error('Failed to load config:', error);
        addLogMessage(`加载配置失败: ${error.message}`);
    }
}

// 更新侧边栏配置信息展示
function updateConfigDisplay() {
    // 片段输出目录
    const clipsDir = document.getElementById('clips-dir').value || '-';
    document.getElementById('clips-dir-value').textContent = clipsDir;
    document.getElementById('clips-dir-value').title = clipsDir;
    
    // 音频文件目录
    const musicDir = document.getElementById('music-dir').value || '-';
    document.getElementById('music-dir-value').textContent = musicDir;
    document.getElementById('music-dir-value').title = musicDir;
    
    // 合成输出目录
    const outputDir = document.getElementById('output-dir').value || '-';
    document.getElementById('output-dir-value').textContent = outputDir;
    document.getElementById('output-dir-value').title = outputDir;
    
    // 视频导出文件名前缀
    const videoNamePrefix = document.getElementById('video-name-prefix').value || '-';
    document.getElementById('video-name-prefix-value').textContent = videoNamePrefix;
    
    // 生成新视频数量
    const numNewVideos = document.getElementById('num-new-videos').value || '-';
    document.getElementById('num-new-videos-value').textContent = numNewVideos;
}

// 选择目录
async function selectDirectory(configType) {
    try {
        const result = await window.electronAPI.selectDirectory();
        if (result) {
            const inputId = `${configType}`;
            document.getElementById(inputId).value = result;
            updateConfigDisplay(); // 更新配置信息展示
        }
    } catch (error) {
        console.error('Failed to select directory:', error);
        addLogMessage(`选择目录失败: ${error.message}`);
    }
}

// 打开配置编辑器
async function openConfigEditor() {
    try {
        const configContent = await window.electronAPI.readConfigFile();
        document.getElementById('config-editor').value = configContent;
        document.getElementById('config-editor-modal').style.display = 'block';
    } catch (error) {
        console.error('Failed to open config editor:', error);
        addLogMessage(`打开配置编辑器失败: ${error.message}`);
    }
}

// 关闭配置编辑器
function closeConfigEditor() {
    document.getElementById('config-editor-modal').style.display = 'none';
}

// 保存配置文件
async function saveConfigFile() {
    try {
        const configContent = document.getElementById('config-editor').value;
        const result = await window.electronAPI.saveConfigFile(configContent);
        if (result && result.success) {
            addLogMessage('配置文件已保存');
            closeConfigEditor();
        } else {
            addLogMessage(`保存配置文件失败: ${result ? result.error : '未知错误'}`);
        }
    } catch (error) {
        console.error('Failed to save config file:', error);
        addLogMessage(`保存配置文件失败: ${error.message}`);
    }
}

// 保存配置更改
async function saveConfigChanges() {
    try {
        const configData = {
            inputDir: document.getElementById('input-dir').value,
            clipsDir: document.getElementById('clips-dir').value,
            musicDir: document.getElementById('music-dir').value,
            outputDir: document.getElementById('output-dir').value,
            videoNamePrefix: document.getElementById('video-name-prefix').value,
            numNewVideos: document.getElementById('num-new-videos').value,
            sceneThreshold: document.getElementById('scene-threshold').value
        };
        
        const result = await window.electronAPI.saveConfig(configData);
        if (result && result.success) {
            addLogMessage('配置已保存');
            updateConfigDisplay(); // 更新配置信息展示
        } else {
            addLogMessage(`保存配置失败: ${result ? result.error : '未知错误'}`);
        }
    } catch (error) {
        console.error('Failed to save config:', error);
        addLogMessage(`保存配置失败: ${error.message}`);
    }
}

// 切换标签页
function switchTab(clickedItem) {
    // 更新导航项状态
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    clickedItem.classList.add('active');
    
    // 显示对应的标签页内容
    const tabName = clickedItem.getAttribute('data-tab');
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');
}

// 更新进度条显示
function updateProgress(percentage, taskInfo = '') {
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const taskInfoElement = document.getElementById('task-info');
    const taskControls = document.querySelector('.task-controls');
    
    progressFill.style.width = `${percentage}%`;
    progressText.textContent = `${Math.round(percentage)}%`;
    
    if (taskInfo) {
        taskInfoElement.textContent = taskInfo;
    }
    
    // 如果进度大于0且小于100，显示停止按钮
    if (percentage > 0 && percentage < 100) {
        taskControls.style.display = 'block';
        currentTaskRunning = true;
    } else if (percentage >= 100) {
        // 任务完成，隐藏停止按钮
        taskControls.style.display = 'none';
        currentTaskRunning = false;
    }
}

// 更新进度条显示（基于消息）
function updateProgressMessage(message) {
    // 从消息中提取进度信息
    const progressRegex = /(\d+)%/;
    const match = message.match(progressRegex);
    
    if (match) {
        const percentage = parseInt(match[1]);
        const progressFill = document.getElementById('progress-fill');
        const progressText = document.getElementById('progress-text');
        
        progressFill.style.width = `${percentage}%`;
        progressText.textContent = `${percentage}%`;
        
        // 如果进度大于0且小于100，显示停止按钮
        const taskControls = document.querySelector('.task-controls');
        if (percentage > 0 && percentage < 100) {
            if (taskControls) {
                taskControls.style.display = 'block';
            }
            currentTaskRunning = true;
        } else if (percentage >= 100) {
            // 任务完成，隐藏停止按钮
            if (taskControls) {
                taskControls.style.display = 'none';
            }
            currentTaskRunning = false;
        }
    }
    
    // 同时将进度消息添加到日志中
    addLogMessage(message.trim());
}

// 添加日志消息到日志容器
function addLogMessage(message) {
    const logContainer = document.getElementById('log-container');
    const wasScrolledToBottom = logContainer.scrollTop + logContainer.clientHeight >= logContainer.scrollHeight - 5;
    
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logContainer.appendChild(logEntry);
    
    // 如果之前滚动到底部，则自动滚动到底部
    if (wasScrolledToBottom) {
        logContainer.scrollTop = logContainer.scrollHeight;
    }
}

function clearLog() {
    const logContainer = document.getElementById('log-container');
    logContainer.textContent = '';
}

function updateStats() {
    // 工具状态部分已移除，不再更新这些元素
}

// 运行视频分割任务
async function runSplit() {
    if (currentTaskRunning) {
        addLogMessage('有任务正在运行，请先停止当前任务');
        return;
    }

    try {
        // 保存当前配置
        await saveConfigChanges();
        
        addLogMessage('开始执行视频分割任务...');
        currentTaskRunning = true;
        document.querySelector('.task-controls').style.display = 'block';
        
        const result = await window.electronAPI.runVideoSplit();
        if (result && result.success) {
            addLogMessage(result.message);
            updateProgress(100, '分割完成');
            // 播放成功提示音
            window.electronAPI.playSound('success');
        } else {
            addLogMessage(`视频分割失败: ${result ? result.error : '未知错误'}`);
            // 播放错误提示音
            window.electronAPI.playSound('error');
        }
    } catch (error) {
        console.error('Failed to run video split:', error);
        addLogMessage(`视频分割失败: ${error.message}`);
        // 播放错误提示音
        window.electronAPI.playSound('error');
    } finally {
        currentTaskRunning = false;
        document.querySelector('.task-controls').style.display = 'none';
    }
}

// 运行视频合成任务
async function runConcat() {
    if (currentTaskRunning) {
        addLogMessage('有任务正在运行，请先停止当前任务');
        return;
    }

    try {
        // 保存当前配置
        await saveConfigChanges();
        
        addLogMessage('开始执行视频合成任务...');
        currentTaskRunning = true;
        document.querySelector('.task-controls').style.display = 'block';
        
        const result = await window.electronAPI.runVideoConcat();
        if (result && result.success) {
            addLogMessage(result.message);
            updateProgress(100, '合成完成');
            // 播放成功提示音
            window.electronAPI.playSound('success');
        } else {
            addLogMessage(`视频合成失败: ${result ? result.error : '未知错误'}`);
            // 播放错误提示音
            window.electronAPI.playSound('error');
        }
    } catch (error) {
        console.error('Failed to run video concat:', error);
        addLogMessage(`视频合成失败: ${error.message}`);
        // 播放错误提示音
        window.electronAPI.playSound('error');
    } finally {
        currentTaskRunning = false;
        document.querySelector('.task-controls').style.display = 'none';
    }
}

// 运行去重检测任务
async function runDedup() {
    if (currentTaskRunning) {
        addLogMessage('有任务正在运行，请先停止当前任务');
        return;
    }

    try {
        addLogMessage('开始执行去重检测任务...');
        currentTaskRunning = true;
        document.querySelector('.task-controls').style.display = 'block';
        simulateProgress('去重检测中');
        
        // 这里应该调用实际的去重检测功能
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        addLogMessage('去重检测完成');
        updateProgress(100, '去重完成');
        // 播放成功提示音
        window.electronAPI.playSound('success');
    } catch (error) {
        console.error('Failed to run dedup:', error);
        addLogMessage(`去重检测失败: ${error.message}`);
        // 播放错误提示音
        window.electronAPI.playSound('error');
    } finally {
        currentTaskRunning = false;
        document.querySelector('.task-controls').style.display = 'none';
    }
}

// 运行音频处理任务
async function runAudio() {
    if (currentTaskRunning) {
        addLogMessage('有任务正在运行，请先停止当前任务');
        return;
    }

    try {
        addLogMessage('开始执行音频处理任务...');
        currentTaskRunning = true;
        document.querySelector('.task-controls').style.display = 'block';
        simulateProgress('音频处理中');
        
        // 这里应该调用实际的音频处理功能
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        addLogMessage('音频处理完成');
        updateProgress(100, '音频完成');
        // 播放成功提示音
        window.electronAPI.playSound('success');
    } catch (error) {
        console.error('Failed to run audio processing:', error);
        addLogMessage(`音频处理失败: ${error.message}`);
        // 播放错误提示音
        window.electronAPI.playSound('error');
    } finally {
        currentTaskRunning = false;
        document.querySelector('.task-controls').style.display = 'none';
    }
}

// 停止当前任务
async function stopCurrentTask() {
    if (!currentTaskRunning) {
        addLogMessage('当前没有正在运行的任务');
        return;
    }
    
    try {
        const result = await window.electronAPI.stopCurrentTask();
        if (result && result.success) {
            addLogMessage(result.message);
            updateProgress(0, '任务已停止');
            currentTaskRunning = false;
            document.querySelector('.task-controls').style.display = 'none';
            // 播放任务停止提示音
            window.electronAPI.playSound('error');
        } else {
            addLogMessage(`停止任务失败: ${result ? result.error : '未知错误'}`);
            // 播放错误提示音
            window.electronAPI.playSound('error');
        }
    } catch (error) {
        console.error('Failed to stop current task:', error);
        addLogMessage(`停止任务失败: ${error.message}`);
        // 播放错误提示音
        window.electronAPI.playSound('error');
    }
}

// 打开合成输出目录
async function openOutputDirectory() {
    try {
        const config = await window.electronAPI.readConfig();
        const outputDir = config.outputDir || './output';
        
        const result = await window.electronAPI.openDirectory(outputDir);
        if (!result.success) {
            addLogMessage(`打开目录失败: ${result.error}`);
        }
    } catch (error) {
        console.error('Failed to open output directory:', error);
        addLogMessage(`打开目录失败: ${error.message}`);
    }
}

// 模拟进度更新，实际应用中应该由后端任务触发
function simulateProgress(taskName) {
    let progress = 0;
    const interval = setInterval(() => {
        progress += Math.random() * 10;
        if (progress >= 100) {
            progress = 100;
            clearInterval(interval);
            updateProgress(100, `${taskName}完成`);
            addLogMessage(`${taskName}任务已完成`);
        } else {
            updateProgress(progress, `${taskName}... ${Math.round(progress)}%`);
        }
    }, 300);
}