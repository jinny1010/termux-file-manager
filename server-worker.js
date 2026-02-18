#!/usr/bin/env node
// TermuxFM Server Worker
// standalone.js가 이 파일을 실행합니다. 직접 실행해도 됩니다.

const express = require('express');
const path = require('path');
const app = express();
const PORT = 8001;

// Serve static frontend
app.use('/fm', express.static(path.join(__dirname, 'public')));

// Redirect root to file manager
app.get('/', (_req, res) => res.redirect('/fm'));

// Load plugin routes
const plugin = require('./index.js');
plugin.init(app);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`  ║   http://localhost:${PORT}/fm               ║`);
    console.log('  ║   Press Ctrl+C to stop                   ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
});
