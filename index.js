// SillyTavern Server Plugin - Termux File Manager
// This plugin adds file management API endpoints to SillyTavern's Express server.

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const MODULE_NAME = 'termux-file-manager';

// ===== In-memory file edit history (세션 동안만 유지) =====
// Map<filePath, Array<{ content: string, timestamp: number, size: number }>>
const fileHistory = new Map();
const MAX_HISTORY_PER_FILE = 30; // 파일당 최대 히스토리 수

function formatTimeAgo(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return `${diff}초 전`;
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    return `${Math.floor(diff / 86400)}일 전`;
}

function pushHistory(filePath, content) {
    if (!fileHistory.has(filePath)) {
        fileHistory.set(filePath, []);
    }
    const history = fileHistory.get(filePath);
    history.push({
        content,
        timestamp: Date.now(),
        size: Buffer.byteLength(content, 'utf-8'),
    });
    // 오래된 항목 제거
    if (history.length > MAX_HISTORY_PER_FILE) {
        history.splice(0, history.length - MAX_HISTORY_PER_FILE);
    }
}

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

    // ===== DOWNLOAD folder as zip =====
    router.post('/download-zip', express.json(), (req, res) => {
        try {
            const { execSync } = require('child_process');
            const targetPath = resolveSafe(req.body.path);
            if (!fs.existsSync(targetPath)) {
                return res.status(404).json({ error: 'Path not found' });
            }
            const stat = fs.statSync(targetPath);
            if (!stat.isDirectory()) {
                return res.status(400).json({ error: 'Not a directory. Use download for files.' });
            }

            const folderName = path.basename(targetPath);
            const tmpDir = path.join(getSafeRoot(), '.st-filemanager-tmp');
            fs.mkdirSync(tmpDir, { recursive: true });
            const zipName = `${folderName}_${Date.now()}.tar.gz`;
            const zipPath = path.join(tmpDir, zipName);

            // Create tar.gz archive
            const parentDir = path.dirname(targetPath);
            execSync(`tar -czf "${zipPath}" -C "${parentDir}" "${folderName}"`, {
                encoding: 'utf-8',
                timeout: 300000, // 5 min timeout for large folders
            });

            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(folderName)}.tar.gz"`);
            res.setHeader('Content-Type', 'application/gzip');

            const fileStream = fs.createReadStream(zipPath);
            fileStream.pipe(res);
            fileStream.on('end', () => {
                // Clean up temp file
                try { fs.unlinkSync(zipPath); } catch (e) {}
            });
            fileStream.on('error', (err) => {
                try { fs.unlinkSync(zipPath); } catch (e) {}
                if (!res.headersSent) {
                    res.status(500).json({ error: err.message });
                }
            });
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

    // ===== WRITE text file (편집기) =====
    router.post('/write', express.json({ limit: '5mb' }), (req, res) => {
        try {
            const filePath = resolveSafe(req.body.path);
            if (typeof req.body.content !== 'string') {
                return res.status(400).json({ error: 'content must be string' });
            }
            // 디렉토리인지 확인
            if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
                return res.status(400).json({ error: 'Cannot write to a directory' });
            }
            // 기존 파일이 있으면 히스토리에 저장
            if (fs.existsSync(filePath)) {
                try {
                    const prevContent = fs.readFileSync(filePath, 'utf-8');
                    pushHistory(filePath, prevContent);
                } catch (e) { /* 읽기 실패 시 무시 */ }
            }
            // 부모 디렉토리 확인
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, req.body.content, 'utf-8');
            const stat = fs.statSync(filePath);
            res.json({ success: true, size: stat.size });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== FILE EDIT HISTORY (세션 내 되돌리기) =====
    router.post('/history', express.json(), (req, res) => {
        try {
            const filePath = resolveSafe(req.body.path);
            const history = fileHistory.get(filePath) || [];
            // 내용 제외한 메타데이터만 반환
            const items = history.map((h, idx) => ({
                index: idx,
                timestamp: h.timestamp,
                size: h.size,
                timeAgo: formatTimeAgo(h.timestamp),
            }));
            res.json({ path: req.body.path, count: items.length, items: items.reverse() });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    router.post('/restore', express.json(), (req, res) => {
        try {
            const filePath = resolveSafe(req.body.path);
            const idx = req.body.index;
            const history = fileHistory.get(filePath);
            if (!history || idx < 0 || idx >= history.length) {
                return res.status(400).json({ error: '해당 히스토리가 없습니다' });
            }
            // 현재 내용을 히스토리에 먼저 저장 (복원도 되돌릴 수 있게)
            if (fs.existsSync(filePath)) {
                try {
                    const current = fs.readFileSync(filePath, 'utf-8');
                    pushHistory(filePath, current);
                } catch (e) { /* ignore */ }
            }
            fs.writeFileSync(filePath, history[idx].content, 'utf-8');
            const stat = fs.statSync(filePath);
            res.json({ success: true, size: stat.size, content: history[idx].content });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // 히스토리 특정 항목 내용 조회 (diff 미리보기용)
    router.post('/history-content', express.json(), (req, res) => {
        try {
            const filePath = resolveSafe(req.body.path);
            const idx = req.body.index;
            const history = fileHistory.get(filePath);
            if (!history || idx < 0 || idx >= history.length) {
                return res.status(400).json({ error: '해당 히스토리가 없습니다' });
            }
            res.json({ content: history[idx].content, size: history[idx].size, timestamp: history[idx].timestamp });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== SEARCH files (재귀 검색) =====
    router.post('/search', express.json(), (req, res) => {
        try {
            const basePath = resolveSafe(req.body.path || '');
            const query = (req.body.query || '').toLowerCase().trim();
            if (!query) return res.json({ results: [] });

            const results = [];
            const maxResults = 100;
            const maxDepth = 8;

            function searchDir(dir, depth) {
                if (depth > maxDepth || results.length >= maxResults) return;
                try {
                    const items = fs.readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        if (results.length >= maxResults) break;
                        if (item.name.toLowerCase().includes(query)) {
                            const fullPath = path.join(dir, item.name);
                            const relPath = path.relative(basePath, fullPath);
                            let size = 0, mtime = null;
                            try {
                                const stat = fs.statSync(fullPath);
                                size = stat.size;
                                mtime = stat.mtime.toISOString();
                            } catch (e) {}
                            results.push({
                                name: item.name,
                                path: relPath,
                                fullPath: fullPath,
                                isDirectory: item.isDirectory(),
                                size, mtime,
                            });
                        }
                        if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
                            searchDir(path.join(dir, item.name), depth + 1);
                        }
                    }
                } catch (e) { /* permission denied */ }
            }

            searchDir(basePath, 0);
            res.json({ results, basePath });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== FILE INFO (상세 정보) =====
    router.post('/info', express.json(), (req, res) => {
        try {
            const filePath = resolveSafe(req.body.path);
            const stat = fs.statSync(filePath);
            const info = {
                name: path.basename(filePath),
                path: filePath,
                isDirectory: stat.isDirectory(),
                size: stat.size,
                mtime: stat.mtime.toISOString(),
                atime: stat.atime.toISOString(),
                ctime: stat.ctime.toISOString(),
                mode: '0' + (stat.mode & parseInt('777', 8)).toString(8),
                uid: stat.uid,
                gid: stat.gid,
            };
            if (stat.isDirectory()) {
                try { info.childCount = fs.readdirSync(filePath).length; } catch (e) {}
            }
            // 심볼릭 링크 확인
            try {
                const lstat = fs.lstatSync(filePath);
                info.isSymlink = lstat.isSymbolicLink();
                if (info.isSymlink) {
                    info.linkTarget = fs.readlinkSync(filePath);
                }
            } catch (e) {}
            res.json(info);
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== SERVE IMAGE (이미지 미리보기용) =====
    router.get('/preview-image', (req, res) => {
        try {
            const filePath = resolveSafe(req.query.path || '');
            const ext = path.extname(filePath).toLowerCase();
            const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
            const mime = mimeMap[ext] || 'application/octet-stream';
            if (!mimeMap[ext]) return res.status(400).json({ error: '지원하지 않는 이미지 형식' });
            const stat = fs.statSync(filePath);
            if (stat.size > 20 * 1024 * 1024) return res.status(400).json({ error: '이미지가 너무 큽니다 (>20MB)' });
            res.setHeader('Content-Type', mime);
            res.setHeader('Cache-Control', 'max-age=300');
            fs.createReadStream(filePath).pipe(res);
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ===== BATCH DELETE (일괄 삭제) =====
    router.post('/batch-delete', express.json(), (req, res) => {
        try {
            const paths = req.body.paths || [];
            const results = [];
            const errors = [];
            for (const p of paths) {
                try {
                    const targetPath = resolveSafe(p);
                    if (fs.statSync(targetPath).isDirectory()) {
                        fs.rmSync(targetPath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(targetPath);
                    }
                    results.push(p);
                } catch (err) {
                    errors.push({ path: p, error: err.message });
                }
            }
            res.json({ success: true, deleted: results, errors });
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
    const { spawn: _termSpawn } = require('child_process');
    const _terminals = {};
    let _termIdCounter = 0;

    function _createTerminal(cwd) {
        const id = String(++_termIdCounter);
        const homeDir = process.env.HOME || '/data/data/com.termux/files/home';
        const safeCwd = cwd || homeDir;
        const isTermux = fs.existsSync('/data/data/com.termux');

        // Find the shell
        let shell = '/bin/sh';
        const shellCandidates = [
            process.env.SHELL,
            '/data/data/com.termux/files/usr/bin/bash',
            '/data/data/com.termux/files/usr/bin/sh',
            '/bin/bash',
            '/bin/sh',
        ];
        for (const s of shellCandidates) {
            if (s && fs.existsSync(s)) { shell = s; break; }
        }

        const envVars = {
            ...process.env,
            TERM: 'dumb',
            HOME: homeDir,
            PS1: '\\u@termux:\\w$ ',
            PS2: '> ',
            LANG: process.env.LANG || 'en_US.UTF-8',
            COLUMNS: '120',
            LINES: '40',
            // Force line-buffered output
            PYTHONUNBUFFERED: '1',
            NODE_DISABLE_COLORS: '1',
        };

        // On Termux, set proper PATH
        if (isTermux) {
            envVars.PATH = process.env.PATH || '/data/data/com.termux/files/usr/bin:/data/data/com.termux/files/usr/bin/applets';
            envVars.PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
            envVars.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH || '/data/data/com.termux/files/usr/lib';
        }

        console.log(`[${MODULE_NAME}] Spawning terminal #${id}: shell=${shell}, cwd=${safeCwd}`);

        const proc = _termSpawn(shell, [], {
            cwd: safeCwd,
            env: envVars,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const term = {
            id,
            proc,
            buffer: [],
            clients: [],
            cwd: safeCwd,
            alive: true,
            initialized: false,
        };

        const push = (data) => {
            const text = data.toString('utf-8');
            term.buffer.push(text);
            // Trim buffer
            if (term.buffer.length > 5000) term.buffer = term.buffer.slice(-3000);
            // Send to SSE clients
            for (const c of term.clients) {
                try {
                    c.write(`data: ${JSON.stringify({ type: 'output', data: text })}\n\n`);
                } catch (e) { /* client disconnected */ }
            }
        };

        if (proc.stdout) {
            proc.stdout.on('data', (chunk) => {
                push(chunk);
            });
        }
        if (proc.stderr) {
            proc.stderr.on('data', (chunk) => {
                push(chunk);
            });
        }

        proc.on('error', (err) => {
            console.error(`[${MODULE_NAME}] Terminal #${id} error: ${err.message}`);
            term.alive = false;
            const msg = `\r\n[오류: ${err.message}]\r\n`;
            push(msg);
            for (const c of term.clients) {
                try { c.write(`data: ${JSON.stringify({ type: 'error', data: msg })}\n\n`); } catch (e) {}
            }
        });

        proc.on('exit', (code, signal) => {
            console.log(`[${MODULE_NAME}] Terminal #${id} exited: code=${code}, signal=${signal}`);
            term.alive = false;
            const msg = `\r\n[프로세스 종료: code=${code}, signal=${signal || 'none'}]\r\n`;
            term.buffer.push(msg);
            for (const c of term.clients) {
                try { c.write(`data: ${JSON.stringify({ type: 'exit', code, signal, data: msg })}\n\n`); } catch (e) {}
            }
        });

        // Force shell initialization - send commands that produce visible output
        setTimeout(() => {
            if (proc && term.alive && proc.stdin.writable) {
                // Set prompt and show initial info
                const initCmds = [
                    'export PS1="$ "',
                    'echo "=== 터미널 #' + id + ' 연결됨 ==="',
                    'echo "셸: ' + shell + '"',
                    'echo "경로: $(pwd)"',
                    'echo "---"',
                    '',
                ].join('\n') + '\n';
                proc.stdin.write(initCmds);
            }
        }, 200);

        _terminals[id] = term;
        return term;
    }

    // Spawn
    router.post('/terminal/spawn', express.json(), (req, res) => {
        try {
            const term = _createTerminal(req.body.cwd || '');
            res.json({ id: term.id, alive: true });
        } catch (e) {
            console.error(`[${MODULE_NAME}] Terminal spawn error:`, e);
            res.status(500).json({ error: e.message });
        }
    });

    // List
    router.get('/terminal/list', (_req, res) => {
        res.json({
            terminals: Object.values(_terminals).map(t => ({
                id: t.id, alive: t.alive, cwd: t.cwd
            }))
        });
    });

    // Input — write to stdin
    router.post('/terminal/input', express.json(), (req, res) => {
        const term = _terminals[req.body.id];
        if (!term) return res.status(404).json({ error: '터미널 없음' });
        if (!term.alive) return res.json({ error: '터미널 종료됨' });
        try {
            if (!term.proc.stdin.writable) {
                return res.json({ error: 'stdin이 쓸 수 없는 상태' });
            }
            term.proc.stdin.write(req.body.data);
            res.json({ ok: true });
        } catch (e) {
            res.json({ error: '입력 실패: ' + e.message });
        }
    });

    // Execute a command and return result directly
    // This is the primary execution mode — tracks cwd per session
    const _termSessions = {}; // sessionId -> { cwd }

    router.post('/terminal/exec', express.json(), (req, res) => {
        const cmd = req.body.command || '';
        const sessionId = String(req.body.sessionId || 'default');
        const homeDir = process.env.HOME || '/data/data/com.termux/files/home';

        // Init session if needed
        if (!_termSessions[sessionId]) {
            _termSessions[sessionId] = { cwd: homeDir };
        }
        const session = _termSessions[sessionId];

        // If explicit cwd override is provided, use it
        if (req.body.cwd) {
            try {
                const resolved = path.resolve(req.body.cwd);
                if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                    session.cwd = resolved;
                }
            } catch (e) {}
        }

        // Ensure cwd exists, fallback to home
        if (!session.cwd || !fs.existsSync(session.cwd)) {
            session.cwd = homeDir;
        }

        if (!cmd.trim()) return res.json({ output: '', code: 0, cwd: session.cwd });

        console.log(`[${MODULE_NAME}] exec [session=${sessionId}] cwd=${session.cwd} cmd=${cmd.substring(0, 100)}`);

        try {
            const { execSync: _es } = require('child_process');
            const trimCmd = cmd.trim();

            // Handle pure cd command
            const cdMatch = trimCmd.match(/^cd(?:\s+(.*))?$/);
            if (cdMatch) {
                let target = (cdMatch[1] || '').trim().replace(/^["']|["']$/g, '');
                if (!target || target === '~') target = homeDir;
                else if (target === '-') target = session.prevCwd || homeDir;
                else if (target === '..') target = path.dirname(session.cwd);
                else if (target.startsWith('~/')) target = path.join(homeDir, target.slice(2));
                
                if (!path.isAbsolute(target)) target = path.resolve(session.cwd, target);

                try {
                    const resolved = path.resolve(target);
                    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                        session.prevCwd = session.cwd;
                        session.cwd = resolved;
                        console.log(`[${MODULE_NAME}] cd -> ${session.cwd}`);
                        res.json({ output: '', code: 0, cwd: session.cwd });
                    } else {
                        res.json({ output: `-bash: cd: ${target}: No such file or directory\n`, code: 1, cwd: session.cwd });
                    }
                } catch (cdErr) {
                    res.json({ output: `-bash: cd: ${cdErr.message}\n`, code: 1, cwd: session.cwd });
                }
                return;
            }

            // For "cd xxx && yyy" chains, handle cd first then run the rest
            let effectiveCmd = cmd;
            const cdChainMatch = trimCmd.match(/^cd\s+([^&;]+?)\s*(?:&&|;)\s*([\s\S]*)/);
            if (cdChainMatch) {
                let target = cdChainMatch[1].trim().replace(/^["']|["']$/g, '');
                if (!target || target === '~') target = homeDir;
                else if (target.startsWith('~/')) target = path.join(homeDir, target.slice(2));
                if (!path.isAbsolute(target)) target = path.resolve(session.cwd, target);
                try {
                    const resolved = path.resolve(target);
                    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                        session.prevCwd = session.cwd;
                        session.cwd = resolved;
                    }
                } catch (e) {}
                effectiveCmd = cdChainMatch[2];
            }

            // Execute the command in the session's cwd
            // Force cd to session.cwd before running to guarantee correct directory
            let output;
            const wrappedCmd = `cd "${session.cwd}" && ${effectiveCmd}`;
            try {
                output = _es(wrappedCmd, {
                    cwd: session.cwd,
                    encoding: 'utf-8',
                    timeout: 60000,
                    env: {
                        ...process.env,
                        HOME: homeDir,
                        TERM: 'dumb',
                    },
                    shell: true,
                    maxBuffer: 10 * 1024 * 1024,
                });
                res.json({ output: output || '', code: 0, cwd: session.cwd });
            } catch (e) {
                const errOutput = (e.stdout || '') + (e.stderr || '');
                res.json({ output: errOutput || e.message, code: e.status || 1, cwd: session.cwd });
            }
        } catch (e) {
            res.json({ output: 'Error: ' + e.message + '\n', code: 1, cwd: session.cwd });
        }
    });

    // Reset session cwd
    router.post('/terminal/reset-session', express.json(), (req, res) => {
        const sessionId = req.body.sessionId || 'default';
        delete _termSessions[sessionId];
        res.json({ ok: true });
    });

    // Signal
    router.post('/terminal/signal', express.json(), (req, res) => {
        const term = _terminals[req.body.id];
        if (!term?.alive) return res.json({ error: '터미널 없음' });
        const sig = req.body.signal || 'SIGINT';
        try {
            // Try process group
            process.kill(-term.proc.pid, sig);
        } catch (e) {
            try { term.proc.kill(sig); } catch (e2) {}
        }
        res.json({ ok: true, signal: sig });
    });

    // Kill
    router.post('/terminal/kill', express.json(), (req, res) => {
        const term = _terminals[req.body.id];
        if (term) {
            try { process.kill(-term.proc.pid, 'SIGKILL'); } catch (e) {}
            try { term.proc.kill('SIGKILL'); } catch (e) {}
            term.alive = false;
            delete _terminals[req.body.id];
        }
        res.json({ ok: true });
    });

    // SSE stream
    router.get('/terminal/stream', (req, res) => {
        const id = req.query.id;
        const term = _terminals[id];
        if (!term) return res.status(404).end('터미널 없음');

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        // Send existing buffer as history
        if (term.buffer.length > 0) {
            const history = term.buffer.join('');
            res.write(`data: ${JSON.stringify({ type: 'history', data: history })}\n\n`);
        }

        if (!term.alive) {
            res.write(`data: ${JSON.stringify({ type: 'exit', code: null, data: '[이미 종료된 세션]' })}\n\n`);
        }

        term.clients.push(res);

        // Cleanup on disconnect
        req.on('close', () => {
            term.clients = term.clients.filter(c => c !== res);
        });

        // Keep-alive ping
        const ping = setInterval(() => {
            try { res.write(': ping\n\n'); } catch (e) { clearInterval(ping); }
        }, 15000);
        req.on('close', () => clearInterval(ping));
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
