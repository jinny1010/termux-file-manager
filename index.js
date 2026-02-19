// SillyTavern Server Plugin - Termux File Manager
// This plugin adds file management API endpoints to SillyTavern's Express server.

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const MODULE_NAME = 'termux-file-manager';

// Safety: restrict navigation to allowed directories
function getSafeRoot() {
    return process.env.HOME || '/data/data/com.termux/files/home';
}

// Allowed root paths
const ALLOWED_ROOTS = [
    process.env.HOME || '/data/data/com.termux/files/home',
    '/storage',
];

function resolveSafe(requestedPath) {
    const home = getSafeRoot();

    // Handle special prefixes
    let resolved;
    if (requestedPath && (requestedPath.startsWith('/storage') || requestedPath.startsWith('//storage'))) {
        resolved = path.resolve(requestedPath.replace(/^\/\//, '/'));
    } else {
        resolved = path.resolve(home, requestedPath || '');
    }

    // Check if path is within any allowed root
    const isAllowed = ALLOWED_ROOTS.some(root => resolved.startsWith(root));
    if (!isAllowed) {
        throw new Error('Access denied: path is outside allowed directories');
    }
    return resolved;
}

// Multer storage – saves uploads to a temp dir with unique names
const storage = multer.diskStorage({
    destination: function (_req, _file, cb) {
        const tmpDir = path.join(getSafeRoot(), '.st-filemanager-tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        cb(null, tmpDir);
    },
    filename: function (_req, file, cb) {
        // Use unique ID to avoid filename collisions and special char issues
        const uniqueId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        cb(null, uniqueId);
    }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB max

/**
 * @param {express.Express} app - SillyTavern Express app
 */
function init(app) {
    console.log(`[${MODULE_NAME}] Initializing Termux File Manager plugin...`);

    const router = express.Router();

    // ===== LIST directory =====
    router.post('/list', express.json(), (req, res) => {
        try {
            const dirPath = resolveSafe(req.body.path || '');
            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            const result = items.map(item => {
                const fullPath = path.join(dirPath, item.name);
                let size = 0;
                let mtime = null;
                let childCount = null;
                const isDir = item.isDirectory();
                try {
                    const stat = fs.statSync(fullPath);
                    size = stat.size;
                    mtime = stat.mtime.toISOString();
                    if (isDir) {
                        try {
                            childCount = fs.readdirSync(fullPath).length;
                        } catch (e) { /* permission denied etc */ }
                    }
                } catch (e) { /* skip */ }
                return {
                    name: item.name,
                    isDirectory: isDir,
                    size,
                    mtime,
                    childCount,
                };
            });
            // Sort: directories first, then alphabetical
            result.sort((a, b) => {
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
            });
            const root = getSafeRoot();
            // For /storage paths, show absolute path; for home, show relative
            let displayPath;
            if (dirPath.startsWith('/storage')) {
                displayPath = dirPath;
            } else {
                displayPath = path.relative(root, dirPath) || '~';
            }
            res.json({
                currentPath: displayPath,
                absolutePath: dirPath,
                items: result,
            });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== DOWNLOAD file =====
    router.post('/download', express.json(), (req, res) => {
        try {
            const filePath = resolveSafe(req.body.path);
            if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                return res.status(400).json({ error: 'Not a valid file' });
            }
            res.download(filePath);
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== UPLOAD file(s) with folder structure support =====
    // Multer error handler wrapper
    function uploadMiddleware(req, res, next) {
        upload.array('files', 500)(req, res, function (err) {
            if (err) {
                console.error(`[${MODULE_NAME}] Multer error:`, err.message);
                return res.status(400).json({ error: 'Upload failed: ' + err.message });
            }
            next();
        });
    }

    router.post('/upload', uploadMiddleware, (req, res) => {
        try {
            const targetDir = resolveSafe(req.body.targetPath || '');
            fs.mkdirSync(targetDir, { recursive: true });

            // Parse relative paths if provided (for folder uploads)
            let relativePaths = [];
            try {
                if (req.body.relativePaths) {
                    relativePaths = JSON.parse(req.body.relativePaths);
                }
            } catch (e) { /* ignore parse errors */ }

            const results = [];
            const errors = [];
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                // Decode originalname (multer sometimes gives latin1-encoded UTF-8)
                let origName = file.originalname;
                try {
                    origName = Buffer.from(file.originalname, 'latin1').toString('utf-8');
                } catch (e) { /* keep original */ }

                const relPath = relativePaths[i] || origName;

                try {
                    // Sanitize path: remove null bytes, normalize
                    const safePath = relPath.replace(/\0/g, '').normalize('NFC');

                    // Ensure relative path doesn't escape target
                    const destFull = path.join(targetDir, safePath);
                    const destResolved = path.resolve(destFull);
                    if (!destResolved.startsWith(targetDir)) {
                        errors.push({ name: relPath, error: 'Path escape blocked' });
                        continue;
                    }

                    // Create subdirectories if needed
                    const destDir = path.dirname(destResolved);
                    fs.mkdirSync(destDir, { recursive: true });

                    // Copy instead of rename (safer across filesystems / special chars)
                    fs.copyFileSync(file.path, destResolved);
                    // Clean up temp file
                    try { fs.unlinkSync(file.path); } catch (e) {}

                    results.push({ name: safePath, size: file.size, dest: destResolved });
                } catch (fileErr) {
                    console.error(`[${MODULE_NAME}] Upload error for "${relPath}":`, fileErr.message);
                    errors.push({ name: relPath, error: fileErr.message });
                    // Clean up temp file on error too
                    try { fs.unlinkSync(file.path); } catch (e) {}
                }
            }
            res.json({ success: true, uploaded: results, errors });
        } catch (err) {
            console.error(`[${MODULE_NAME}] Upload handler error:`, err.message);
            res.status(400).json({ error: err.message });
        }
    });

    // ===== DELETE file/folder =====
    router.post('/delete', express.json(), (req, res) => {
        try {
            const targetPath = resolveSafe(req.body.path);
            if (!fs.existsSync(targetPath)) {
                return res.status(404).json({ error: 'Path not found' });
            }
            const stat = fs.statSync(targetPath);
            if (stat.isDirectory()) {
                fs.rmSync(targetPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(targetPath);
            }
            res.json({ success: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== CREATE folder =====
    router.post('/mkdir', express.json(), (req, res) => {
        try {
            const dirPath = resolveSafe(req.body.path);
            fs.mkdirSync(dirPath, { recursive: true });
            res.json({ success: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== MOVE / RENAME =====
    router.post('/move', express.json(), (req, res) => {
        try {
            const src = resolveSafe(req.body.from);
            const dest = resolveSafe(req.body.to);
            fs.renameSync(src, dest);
            res.json({ success: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== COPY file/folder =====
    router.post('/copy', express.json(), (req, res) => {
        try {
            const src = resolveSafe(req.body.from);
            const dest = resolveSafe(req.body.to);

            if (!fs.existsSync(src)) {
                return res.status(404).json({ error: '원본을 찾을 수 없습니다.' });
            }

            const stat = fs.statSync(src);
            if (stat.isDirectory()) {
                // Recursive directory copy
                const { execSync } = require('child_process');
                execSync(`cp -r "${src}" "${dest}"`);
            } else {
                // Ensure dest directory exists
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(src, dest);
            }
            res.json({ success: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== READ text file =====
    router.post('/read', express.json(), (req, res) => {
        try {
            const filePath = resolveSafe(req.body.path);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                return res.status(400).json({ error: 'Cannot read a directory' });
            }
            if (stat.size > 2 * 1024 * 1024) {
                return res.status(400).json({ error: 'File too large to preview (>2MB)' });
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            res.json({ content, size: stat.size });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== Find SillyTavern root =====
    function findSTRoot() {
        const home = getSafeRoot();
        // Check common locations
        const candidates = [
            path.join(home, 'SillyTavern'),
            path.join(home, 'sillytavern'),
            path.join(home, 'ST'),
            path.resolve(__dirname, '..', '..'), // if installed as plugin
        ];
        for (const dir of candidates) {
            if (fs.existsSync(path.join(dir, 'data')) || fs.existsSync(path.join(dir, 'config.yaml'))) {
                return dir;
            }
        }
        return null;
    }

    // ===== BACKUP SillyTavern data =====
    router.post('/backup', express.json(), async (req, res) => {
        try {
            const { execSync } = require('child_process');
            const stRoot = findSTRoot();
            if (!stRoot) {
                return res.status(400).json({ error: 'SillyTavern 폴더를 찾을 수 없습니다. ~/SillyTavern 경로를 확인하세요.' });
            }

            const backupName = `st-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
            const backupPath = path.join(getSafeRoot(), backupName);

            const targets = [];
            if (fs.existsSync(path.join(stRoot, 'data'))) targets.push('data');
            if (fs.existsSync(path.join(stRoot, 'config.yaml'))) targets.push('config.yaml');

            if (targets.length === 0) {
                return res.status(400).json({ error: 'SillyTavern에 data/config가 없습니다.' });
            }

            execSync(`tar -czf "${backupPath}" ${targets.join(' ')}`, { cwd: stRoot });
            res.json({ success: true, backupPath, backupName, stRoot });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ===== RESTORE from backup =====
    router.post('/restore', express.json(), (req, res) => {
        try {
            const { execSync } = require('child_process');
            const backupFile = resolveSafe(req.body.path);
            const stRoot = findSTRoot();
            if (!stRoot) {
                return res.status(400).json({ error: 'SillyTavern 폴더를 찾을 수 없습니다.' });
            }

            if (!fs.existsSync(backupFile)) {
                return res.status(404).json({ error: '백업 파일을 찾을 수 없습니다.' });
            }

            execSync(`tar -xzf "${backupFile}" --overwrite`, { cwd: stRoot });
            res.json({ success: true, message: '복원 완료! SillyTavern을 재시작하세요.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ===== UPDATE (git pull) =====
    router.post('/update', express.json(), (req, res) => {
        try {
            const { execSync } = require('child_process');
            const target = req.body.target; // 'fm' or 'st'
            let cwd;
            let log = '';

            if (target === 'fm') {
                // Update file manager itself
                cwd = path.resolve(__dirname);
                log += '📂 파일매니저 업데이트 중...\n';
                log += '$ git pull\n';
                try {
                    log += execSync('git pull', { cwd, encoding: 'utf-8', timeout: 30000 });
                } catch (e) {
                    log += e.stdout || '';
                    log += e.stderr || '';
                }
                log += '\n$ npm install\n';
                try {
                    log += execSync('npm install --production 2>&1', { cwd, encoding: 'utf-8', timeout: 60000 });
                } catch (e) {
                    log += e.stdout || '';
                    log += e.stderr || '';
                }
                // Schedule restart
                res.json({ success: true, log });
                setTimeout(() => process.exit(0), 1500); // pm2 or user restarts
                return;
            } else if (target === 'st') {
                // Update SillyTavern
                const stRoot = findSTRoot();
                if (!stRoot) {
                    return res.status(400).json({ error: 'SillyTavern 폴더를 찾을 수 없습니다.' });
                }
                cwd = stRoot;
                log += '🎭 SillyTavern 업데이트 중...\n';
                log += '$ git pull\n';
                try {
                    log += execSync('git pull', { cwd, encoding: 'utf-8', timeout: 30000 });
                } catch (e) {
                    log += e.stdout || '';
                    log += e.stderr || '';
                }
                log += '\n$ npm install\n';
                try {
                    log += execSync('npm install --production 2>&1', { cwd, encoding: 'utf-8', timeout: 120000 });
                } catch (e) {
                    log += e.stdout || '';
                    log += e.stderr || '';
                }
                res.json({ success: true, log });
                return;
            } else if (target === 'st-start') {
                // Start SillyTavern via start.sh or node server.js
                const stRoot = findSTRoot();
                if (!stRoot) {
                    return res.status(400).json({ error: 'SillyTavern 폴더를 찾을 수 없습니다.' });
                }
                cwd = stRoot;
                log += '🚀 SillyTavern 시작 중...\n';

                // Check if already running
                try {
                    const check = execSync('pgrep -f "node.*server.js" 2>/dev/null || true', { encoding: 'utf-8', shell: true }).trim();
                    if (check) {
                        log += '⚠️ SillyTavern이 이미 실행 중인 것 같습니다 (PID: ' + check + ')\n';
                    }
                } catch (e) {}

                const startScript = fs.existsSync(path.join(stRoot, 'start.sh')) ? 'bash start.sh' : 'node server.js';
                log += `$ ${startScript}\n`;
                try {
                    const home = getSafeRoot();
                    const pidFile = path.join(home, '.sillytavern.pid');
                    execSync(`cd "${stRoot}" && nohup ${startScript} > /dev/null 2>&1 & echo $! > "${pidFile}"`, {
                        encoding: 'utf-8', timeout: 5000, shell: true
                    });
                    let pid = '';
                    try { pid = fs.readFileSync(pidFile, 'utf-8').trim(); } catch (e) {}
                    log += `✅ SillyTavern 시작됨! (PID: ${pid})\n`;
                    log += '접속: http://localhost:8000\n';
                } catch (e) {
                    log += '❌ 시작 실패: ' + (e.message || '') + '\n';
                }
                res.json({ success: true, log });
                return;
            } else if (target === 'st-stop') {
                // Stop SillyTavern
                log += '⏹ SillyTavern 종료 중...\n';
                const home = getSafeRoot();
                const pidFile = path.join(home, '.sillytavern.pid');
                try {
                    let killed = false;
                    if (fs.existsSync(pidFile)) {
                        const pid = fs.readFileSync(pidFile, 'utf-8').trim();
                        if (pid) {
                            try {
                                execSync(`kill ${pid} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
                                log += `✅ PID ${pid} 종료됨\n`;
                                killed = true;
                            } catch (e) {}
                        }
                        try { fs.unlinkSync(pidFile); } catch (e) {}
                    }
                    if (!killed) {
                        execSync('pkill -f "node.*server.js" 2>/dev/null || true', { encoding: 'utf-8', timeout: 5000, shell: true });
                        log += '✅ SillyTavern 종료됨\n';
                    }
                } catch (e) {
                    log += e.stdout || '';
                    log += e.stderr || '';
                    log += '종료 시도 완료\n';
                }
                res.json({ success: true, log });
                return;
            } else if (target === 'library') {
                // Update chat-library
                const home = getSafeRoot();
                const libCandidates = ['chat-library', 'Chat-Library', 'perpage'];
                let libRoot = null;
                for (const name of libCandidates) {
                    const p = path.join(home, name);
                    if (fs.existsSync(p)) { libRoot = p; break; }
                }
                if (!libRoot) {
                    return res.status(400).json({ error: '도서관 폴더를 찾을 수 없습니다. ~/chat-library 또는 ~/perpage 경로를 확인하세요.' });
                }
                log += '📚 도서관 업데이트 중...\n';
                log += '$ git pull\n';
                try {
                    log += execSync('git pull', { cwd: libRoot, encoding: 'utf-8', timeout: 30000 });
                } catch (e) { log += (e.stdout || '') + (e.stderr || ''); }
                log += '\n$ npm install\n';
                try {
                    log += execSync('npm install --production 2>&1', { cwd: libRoot, encoding: 'utf-8', timeout: 60000 });
                } catch (e) { log += (e.stdout || '') + (e.stderr || ''); }
                res.json({ success: true, log });
                return;
            } else if (target === 'library-start') {
                // Start chat-library
                const home = getSafeRoot();
                const libCandidates = ['chat-library', 'Chat-Library', 'perpage'];
                let libRoot = null;
                for (const name of libCandidates) {
                    const p = path.join(home, name);
                    if (fs.existsSync(p)) { libRoot = p; break; }
                }
                if (!libRoot) {
                    return res.status(400).json({ error: '도서관 폴더를 찾을 수 없습니다.' });
                }

                // Determine start command (library.js 우선 탐색)
                let startCmd = 'npm start';
                if (fs.existsSync(path.join(libRoot, 'library.js'))) {
                    startCmd = 'node library.js';
                } else if (fs.existsSync(path.join(libRoot, 'server.js'))) {
                    startCmd = 'node server.js';
                } else if (fs.existsSync(path.join(libRoot, 'index.js'))) {
                    startCmd = 'node index.js';
                }

                // 로그 파일 경로
                const libLogFile = path.join(home, 'chat-library.log');

                log += `🚀 도서관 시작 중... (${libRoot})\n`;
                log += `$ ${startCmd}\n`;
                log += `📋 로그 파일: ${libLogFile}\n`;

                // Check if already running
                try {
                    const check = execSync(`pgrep -f "node.*(library|chat-library|perpage)" 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
                    if (check) {
                        log += `⚠️ 이미 실행 중인 것 같습니다 (PID: ${check})\n`;
                    }
                } catch (e) {}

                try {
                    // Use nohup + shell for reliable background launch on Termux
                    // 로그를 ~/chat-library.log 에 저장
                    const pidFile = path.join(home, '.chat-library.pid');
                    execSync(`cd "${libRoot}" && nohup ${startCmd} >> "${libLogFile}" 2>&1 & echo $! > "${pidFile}"`, {
                        encoding: 'utf-8', timeout: 5000, shell: true
                    });
                    let pid = '';
                    try { pid = fs.readFileSync(pidFile, 'utf-8').trim(); } catch (e) {}
                    log += `✅ 도서관 시작됨! (PID: ${pid})\n`;
                    log += `💡 터먹스에서 로그 보기: tail -f ~/chat-library.log\n`;
                } catch (e) {
                    log += '❌ 시작 실패: ' + (e.message || '') + '\n';
                }
                res.json({ success: true, log });
                return;
            } else if (target === 'library-stop') {
                log += '⏹ 도서관 종료 중...\n';
                const home = getSafeRoot();
                const pidFile = path.join(home, '.chat-library.pid');

                try {
                    // Try PID file first
                    let killed = false;
                    if (fs.existsSync(pidFile)) {
                        const pid = fs.readFileSync(pidFile, 'utf-8').trim();
                        if (pid) {
                            try {
                                execSync(`kill ${pid} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
                                log += `✅ PID ${pid} 종료됨\n`;
                                killed = true;
                            } catch (e) {
                                log += `PID ${pid} 이미 종료되었거나 없음\n`;
                            }
                        }
                        try { fs.unlinkSync(pidFile); } catch (e) {}
                    }

                    // Also try pkill as fallback
                    if (!killed) {
                        try {
                            execSync(`pkill -f "node.*(library|chat-library|perpage)" 2>/dev/null || true`, { encoding: 'utf-8', timeout: 3000, shell: true });
                            log += '✅ 도서관 프로세스 종료됨\n';
                        } catch (e) {
                            log += '프로세스를 찾을 수 없습니다\n';
                        }
                    }
                } catch (e) {
                    log += (e.stdout || '') + (e.stderr || '');
                    log += '종료 시도 완료\n';
                }
                res.json({ success: true, log });
                return;
            } else if (target === 'library-log') {
                // View chat-library log
                const home = getSafeRoot();
                const libLogFile = path.join(home, 'chat-library.log');
                const lines = parseInt(req.body.lines) || 100;

                if (!fs.existsSync(libLogFile)) {
                    return res.json({ success: true, log: '📋 로그 파일이 아직 없습니다.\n도서관을 먼저 실행해 주세요.' });
                }

                try {
                    const content = fs.readFileSync(libLogFile, 'utf-8');
                    const allLines = content.split('\n');
                    const tail = allLines.slice(-lines).join('\n');
                    log += `📋 chat-library.log (최근 ${Math.min(lines, allLines.length)}줄)\n`;
                    log += '─'.repeat(40) + '\n';
                    log += tail;
                } catch (e) {
                    log += '❌ 로그 읽기 실패: ' + (e.message || '') + '\n';
                }
                res.json({ success: true, log });
                return;
            }

            res.status(400).json({ error: 'Invalid target' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ===== RESTART =====
    router.post('/restart', express.json(), (_req, res) => {
        res.json({ success: true, message: 'Restarting...' });
        setTimeout(() => process.exit(0), 500);
    });

    // ===== TERMINAL =====
    const { spawn: spawnChild } = require('child_process');
    const pluginTerminals = {};
    let pluginTermIdCounter = 0;

    function createPluginTerminal(cwd) {
        const id = String(++pluginTermIdCounter);
        const shell = process.env.SHELL || '/bin/bash';
        const proc = spawnChild(shell, ['-i'], {
            cwd: cwd || getSafeRoot(),
            env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '120', LINES: '40' },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
        });

        const term = { id, proc, buffer: [], clients: [], cwd: cwd || getSafeRoot(), alive: true };

        const pushData = (data) => {
            const text = data.toString('utf-8');
            term.buffer.push(text);
            if (term.buffer.length > 5000) term.buffer = term.buffer.slice(-3000);
            for (const client of term.clients) {
                try { client.write(`data: ${JSON.stringify({ type: 'output', data: text })}\n\n`); } catch (e) {}
            }
        };

        proc.stdout.on('data', pushData);
        proc.stderr.on('data', pushData);
        proc.on('exit', (code, signal) => {
            term.alive = false;
            const msg = `\r\n[프로세스 종료: code=${code}, signal=${signal}]\r\n`;
            term.buffer.push(msg);
            for (const client of term.clients) {
                try { client.write(`data: ${JSON.stringify({ type: 'exit', code, signal, data: msg })}\n\n`); } catch (e) {}
            }
        });
        proc.on('error', (err) => {
            term.alive = false;
            const msg = `\r\n[오류: ${err.message}]\r\n`;
            term.buffer.push(msg);
            for (const client of term.clients) {
                try { client.write(`data: ${JSON.stringify({ type: 'error', data: msg })}\n\n`); } catch (e) {}
            }
        });

        pluginTerminals[id] = term;
        console.log(`[${MODULE_NAME}] Terminal created: #${id}`);
        return term;
    }

    router.post('/terminal/spawn', express.json(), (req, res) => {
        try {
            const term = createPluginTerminal(req.body.cwd || '');
            res.json({ id: term.id, alive: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/terminal/list', (_req, res) => {
        res.json({ terminals: Object.values(pluginTerminals).map(t => ({ id: t.id, alive: t.alive, cwd: t.cwd })) });
    });

    router.post('/terminal/input', express.json(), (req, res) => {
        const term = pluginTerminals[req.body.id];
        if (!term?.alive) return res.json({ error: '터미널 없음' });
        term.proc.stdin.write(req.body.data);
        res.json({ ok: true });
    });

    router.post('/terminal/signal', express.json(), (req, res) => {
        const term = pluginTerminals[req.body.id];
        if (!term?.alive) return res.json({ error: '터미널 없음' });
        const sig = req.body.signal || 'SIGINT';
        try { process.kill(-term.proc.pid, sig); } catch (e) {
            try { term.proc.kill(sig); } catch (e2) {}
        }
        res.json({ ok: true, signal: sig });
    });

    router.post('/terminal/kill', express.json(), (req, res) => {
        const term = pluginTerminals[req.body.id];
        if (term) {
            try { term.proc.kill('SIGKILL'); } catch (e) {}
            term.alive = false;
            delete pluginTerminals[req.body.id];
        }
        res.json({ ok: true });
    });

    router.get('/terminal/stream', (req, res) => {
        const id = req.query.id;
        const term = pluginTerminals[id];
        if (!term) return res.status(404).end('터미널 없음');

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        if (term.buffer.length > 0) {
            res.write(`data: ${JSON.stringify({ type: 'history', data: term.buffer.join('') })}\n\n`);
        }
        if (!term.alive) {
            res.write(`data: ${JSON.stringify({ type: 'exit', code: null, data: '[이미 종료된 세션]' })}\n\n`);
        }

        term.clients.push(res);
        req.on('close', () => { term.clients = term.clients.filter(c => c !== res); });

        const ping = setInterval(() => {
            try { res.write(': ping\n\n'); } catch (e) { clearInterval(ping); }
        }, 15000);
        req.on('close', () => clearInterval(ping));
    });

    router.get('/terminal/buffer', (req, res) => {
        const term = pluginTerminals[req.query.id];
        if (!term) return res.json({ error: '터미널 없음' });
        res.json({ buffer: term.buffer.join(''), alive: term.alive });
    });

    // Mount router
    app.use('/api/plugins/termux-file-manager', router);
    console.log(`[${MODULE_NAME}] File Manager API ready at /api/plugins/termux-file-manager`);
}

module.exports = {
    init,
    info: {
        id: MODULE_NAME,
        name: 'Termux File Manager',
        description: 'Web-based file manager for Termux SillyTavern',
    },
};
