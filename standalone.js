#!/usr/bin/env node
// TermuxFM Standalone Launcher (with auto-restart)
// 서버가 업데이트 후 종료(코드 0)되면 자동으로 재시작합니다.
// 사용법: node standalone.js

const { spawn } = require('child_process');
const path = require('path');

const SERVER_SCRIPT = path.join(__dirname, 'server-worker.js');

function startServer() {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║   📂 TermuxFM - File Manager Starting    ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');

    const child = spawn(process.execPath, [SERVER_SCRIPT], {
        stdio: 'inherit',
        cwd: __dirname,
    });

    child.on('exit', (code) => {
        if (code === 0) {
            console.log('\n🔄 재시작 중...\n');
            setTimeout(startServer, 1500);
        } else {
            console.log(`\n❌ 서버 종료 (코드: ${code})`);
            process.exit(code || 1);
        }
    });
}

startServer();
