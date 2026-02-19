#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 7860;
const DATA_ROOTS = (process.env.CHAT_LIBRARY_PATH || '').split(':').filter(Boolean);
const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const TAGS_FILE = path.join(HOME, '.chat-library-tags.json');
const SETTINGS_FILE = path.join(HOME, '.chat-library-settings.json');

function loadJson(f) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf-8')); } catch(e){} return {}; }
function saveJson(f,d) { try { fs.writeFileSync(f,JSON.stringify(d,null,2),'utf-8'); } catch(e){} }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch(e) { return false; } }
function sub(root,name) { const p=path.join(root,name); return fs.existsSync(p)?p:null; }
function safeReaddir(dir) { try { return fs.readdirSync(dir); } catch(e) { return []; } }

// ── 경로 탐색 ──
function findDataRoot() {
    if (DATA_ROOTS.length > 0) {
        console.log('  환경변수 경로:');
        for (const r of DATA_ROOTS) console.log(`    📂 ${r}`);
        return DATA_ROOTS;
    }
    const found = [];

    // ── 1. /storage 직접 탐색 (Android 실제 마운트 포인트) ──
    // Termux 파일매니저와 동일한 방식
    const storageMounts = ['/storage'];
    for (const storageRoot of storageMounts) {
        if (!isDir(storageRoot)) continue;
        console.log(`  /storage 탐색 중...`);
        for (const name of safeReaddir(storageRoot)) {
            const mountPoint = path.join(storageRoot, name);
            if (!isDir(mountPoint)) continue;
            console.log(`    확인: ${mountPoint}`);

            // /storage/XXXX-XXXX/Backup 또는 직접 chats/
            for (const bn of ['Backup','backup','ST-backup','st-backup']) {
                const bd = path.join(mountPoint, bn);
                if (isDir(bd) && !found.includes(bd)) {
                    const hasChats = isDir(path.join(bd,'chats'));
                    console.log(`    ✓ 발견: ${bd}${hasChats?' (chats/ 있음)':''}`);
                    found.push(bd);
                }
            }
            // /storage/XXXX-XXXX 바로 아래 chats/ 있는 경우
            if (isDir(path.join(mountPoint,'chats')) && !found.includes(mountPoint)) {
                console.log(`    ✓ 발견: ${mountPoint} (직접 chats/)`);
                found.push(mountPoint);
            }

            // /storage/emulated/0 같은 경우 한 단계 더
            if (name === 'emulated') {
                for (const sub of safeReaddir(mountPoint)) {
                    const emPath = path.join(mountPoint, sub);
                    if (!isDir(emPath)) continue;
                    for (const bn of ['Backup','backup','ST-backup','st-backup']) {
                        const bd = path.join(emPath, bn);
                        if (isDir(bd) && !found.includes(bd)) {
                            console.log(`    ✓ 발견: ${bd}`);
                            found.push(bd);
                        }
                    }
                    // /storage/emulated/0/Download/ST-backup
                    for (const dl of ['Download','Downloads']) {
                        for (const bn of ['ST-backup','st-backup','Backup']) {
                            const bd = path.join(emPath, dl, bn);
                            if (isDir(bd) && !found.includes(bd)) {
                                console.log(`    ✓ 발견: ${bd}`);
                                found.push(bd);
                            }
                        }
                    }
                }
            }
        }
    }

    // ── 2. ~/storage 심볼릭 링크도 시도 (안전하게) ──
    const homeStorage = path.join(HOME, 'storage');
    if (isDir(homeStorage)) {
        console.log(`  ~/storage 탐색 중...`);
        for (const name of safeReaddir(homeStorage)) {
            const fp = path.join(homeStorage, name);
            try {
                if (!fs.statSync(fp).isDirectory()) continue;
                for (const bn of ['Backup','backup','ST-backup','st-backup']) {
                    const bd = path.join(fp, bn);
                    if (isDir(bd) && !found.includes(bd)) {
                        console.log(`    ✓ 발견: ${bd}`);
                        found.push(bd);
                    }
                }
            } catch(e) {
                // 깨진 심볼릭 링크 무시
            }
        }
    }

    // ── 3. ~/ST-backup 등 ──
    for (const p of [path.join(HOME,'ST-backup'), path.join(HOME,'st-backup')]) {
        if (!isDir(p)) continue;
        const bs = path.join(p,'Backup');
        const target = isDir(bs) ? bs : p;
        if (!found.includes(target)) { console.log(`  ✓ 발견: ${target}`); found.push(target); }
    }

    // ── 4. SillyTavern 실서버 (최후 폴백) ──
    if (found.length === 0) {
        for (const p of [path.join(HOME,'SillyTavern/data/default-user'), path.join(HOME,'sillytavern/data/default-user')]) {
            if (isDir(p) && !found.includes(p)) {
                console.log(`  ✓ ST 서버 폴백: ${p}`);
                found.push(p);
            }
        }
    }

    if (found.length === 0) {
        const dp = path.join(HOME,'ST-backup');
        fs.mkdirSync(path.join(dp,'chats'),{recursive:true});
        fs.mkdirSync(path.join(dp,'images'),{recursive:true});
        console.log(`  📁 기본 폴더 생성: ${dp}`);
        found.push(dp);
    }
    return found;
}

// ── 스캔 ──
function scanAllData(roots) {
    const characters = {};
    const allImages = [];
    for (const root of roots) {
        const chatsDir = sub(root,'chats');
        if (chatsDir) scanChatsDir(chatsDir, characters);
        const imagesDir = sub(root,'images');
        if (imagesDir) scanImagesDirByChar(imagesDir, allImages, characters);
        for (const d of ['characters','thumbnails']) { const dir=sub(root,d); if(dir) scanAvatarDir(dir,characters); }
        const uImgDir = sub(root,'user/images');
        if (uImgDir) scanImagesDir(uImgDir, allImages, characters);
        if (!chatsDir) {
            for (const name of safeReaddir(root)) {
                const fp=path.join(root,name);
                if (!isDir(fp)||['images','thumbnails','characters','User Avatars'].includes(name)) continue;
                if (safeReaddir(fp).some(f=>f.endsWith('.jsonl'))) { scanChatsDir(root,characters); break; }
            }
        }
    }
    // 2차 아바타: images/캐릭터명/ 첫 이미지
    for (const root of roots) {
        const imagesDir=sub(root,'images'); if(!imagesDir)continue;
        for (const name of safeReaddir(imagesDir)) {
            const fp=path.join(imagesDir,name);
            if(!isDir(fp))continue;
            if(characters[name]&&!characters[name].avatar){
                const imgs=safeReaddir(fp).filter(f=>/\.(png|jpg|jpeg|webp|gif)$/i.test(f));
                if(imgs.length>0) characters[name].avatar=path.join(fp,imgs[0]);
            }
        }
    }
    return {characters,allImages};
}

function scanChatsDir(chatsDir,characters){
    for(const name of safeReaddir(chatsDir)){
        const cp=path.join(chatsDir,name); if(!isDir(cp))continue;
        if(!characters[name])characters[name]={chats:[],avatar:null,images:[]};
        for(const file of safeReaddir(cp).filter(f=>f.endsWith('.jsonl'))){
            try{
                const fp=path.join(cp,file),stat=fs.statSync(fp);
                characters[name].chats.push({name:file.replace('.jsonl',''),file,path:fp,size:stat.size,modified:stat.mtime.toISOString()});
            }catch(e){}
        }
    }
}

function norm(s){return s.toLowerCase().replace(/[''"`]/g,'').replace(/\s+/g,'').replace(/[_\-\.]/g,'').replace(/[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]/g,'');}

function scanAvatarDir(dir,characters){
    for(const name of safeReaddir(dir)){
        if(!/\.(png|jpg|jpeg|webp|gif)$/i.test(name))continue;
        const fp=path.join(dir,name); if(isDir(fp))continue;
        const bn=norm(name.replace(/\.(png|jpg|jpeg|webp|gif)$/i,''));
        for(const cn of Object.keys(characters)){
            const cnn=norm(cn);
            if(bn===cnn||(cnn.length>=2&&bn.includes(cnn))||(bn.length>=2&&cnn.includes(bn))){
                if(!characters[cn].avatar)characters[cn].avatar=fp;
            }
        }
    }
}

function scanImagesDirByChar(imagesDir,allImages,characters){
    for(const name of safeReaddir(imagesDir)){
        const fp=path.join(imagesDir,name);
        if(isDir(fp)){
            if(!characters[name])characters[name]={chats:[],avatar:null,images:[]};
            for(const f of safeReaddir(fp).filter(f=>/\.(png|jpg|jpeg|webp|gif)$/i.test(f))){
                const ip=path.join(fp,f);
                allImages.push({name:f,path:ip,char:name,dir:name});
                if(!characters[name].images)characters[name].images=[];
                characters[name].images.push({name:f,path:ip});
            }
        }else if(/\.(png|jpg|jpeg|webp|gif)$/i.test(name)){
            allImages.push({name,path:fp,char:'',dir:''});
        }
    }
}

function scanImagesDir(imgDir,allImages,characters){
    const walk=(dir,prefix)=>{
        for(const name of safeReaddir(dir)){
            const fp=path.join(dir,name);
            if(isDir(fp)){walk(fp,prefix?`${prefix}/${name}`:name);}
            else if(/\.(png|jpg|jpeg|webp|gif)$/i.test(name)){
                allImages.push({name,path:fp,dir:prefix||''});
                const bn=norm(name.replace(/\.(png|jpg|jpeg|webp|gif)$/i,''));
                for(const cn of Object.keys(characters)){
                    const cnn=norm(cn);
                    if(bn===cnn||(bn.includes(cnn)&&cnn.length>=2)||(cnn.includes(bn)&&bn.length>=2)){
                        if(!characters[cn].avatar)characters[cn].avatar=fp;
                    }
                }
            }
        }
    };
    walk(imgDir,'');
}

function parseChatFile(fp){return fs.readFileSync(fp,'utf-8').trim().split('\n').map(l=>{try{return JSON.parse(l.trim())}catch(e){return null}}).filter(Boolean);}

const CLEANUP=[
    {f:/(?:```?\w*[\r\n]?)?<(thought|cot|thinking|CoT|think|starter)[\s\S]*?<\/(thought|cot|thinking|CoT|think|starter)>(?:[\r\n]?```?)?/gi,r:''},
    {f:/<pic>[\s\S]*?<\/pic>/gi,r:''},{f:/<imageInfo>[\s\S]*?<\/imageInfo>/gi,r:''},
    {f:/<pic\s+prompt="[^"]*"\s*>/gi,r:''},{f:/<\/pic>/gi,r:''},
    {f:/➛/g,r:''},{f:/🥨 Sex Position[\s\S]*?(?=```)/g,r:''},
    {f:/\[OOC:[\s\S]*?\]/gi,r:''},{f:/<OOC>[\s\S]*?<\/OOC>/gi,r:''},
    {f:/<extra_prompt>[\s\S]*?<\/extra_prompt>/gi,r:''},
];
function clean(t){if(!t)return'';let c=t;for(const r of CLEANUP)c=c.replace(r.f,r.r);return c.replace(/\n{3,}/g,'\n\n').trim();}

const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'};
function serve(fp,res){try{const d=fs.readFileSync(fp);res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'});res.end(d);}catch(e){res.writeHead(404);res.end('Not Found');}}
function json(res,d){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(d));}
function body(req){return new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>r(b));});}

// ── 터미널 관리 ──
const { spawn } = require('child_process');

const terminals = {}; // id -> { proc, buffer, clients[], cwd }
let termIdCounter = 0;

function createTerminal(cwd) {
    const id = String(++termIdCounter);
    const shell = process.env.SHELL || '/bin/bash';
    const proc = spawn(shell, ['-i'], {
        cwd: cwd || HOME,
        env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '120', LINES: '40' },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
    });

    const term = { id, proc, buffer: [], clients: [], cwd: cwd || HOME, alive: true };

    const pushData = (data) => {
        const text = data.toString('utf-8');
        term.buffer.push(text);
        // 버퍼 최대 5000줄 유지
        if (term.buffer.length > 5000) term.buffer = term.buffer.slice(-3000);
        // SSE 클라이언트에 전송
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
            try {
                client.write(`data: ${JSON.stringify({ type: 'exit', code, signal, data: msg })}\n\n`);
            } catch (e) {}
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

    terminals[id] = term;
    console.log(`  🖥  터미널 생성: #${id} (cwd: ${cwd || HOME})`);
    return term;
}

function getOrCreateTerminal(id, cwd) {
    if (id && terminals[id] && terminals[id].alive) return terminals[id];
    return createTerminal(cwd);
}

console.log('\n  📚 Chat Library\n  ─────────────────\n  경로 탐색 중...\n');
const dataRoots = findDataRoot();
console.log(`\n  총 ${dataRoots.length}개 경로\n`);

http.createServer(async(req,res)=>{
    const p=url.parse(req.url,true),pn=p.pathname;
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}

    if(pn==='/api/scan'){
        const{characters,allImages}=scanAllData(dataRoots);
        const tags=loadJson(TAGS_FILE);
        const cl={};
        for(const[n,d]of Object.entries(characters)){
            cl[n]={chatCount:d.chats.length,imageCount:(d.images||[]).length,
                avatar:d.avatar?`/api/image?path=${encodeURIComponent(d.avatar)}`:null,
                tags:tags[n]||[],chats:d.chats.map(c=>({name:c.name,file:c.file,size:c.size,modified:c.modified}))};
        }
        json(res,{characters:cl,imageCount:allImages.length,roots:dataRoots});return;
    }
    if(pn==='/api/chat'){
        const cn=p.query.char,fn=p.query.file;
        if(!cn||!fn){json(res,{error:'need char+file'});return;}
        const{characters}=scanAllData(dataRoots);
        const cd=characters[cn];if(!cd){json(res,{error:'not found'});return;}
        const chat=cd.chats.find(c=>c.file===fn);if(!chat){json(res,{error:'no file'});return;}
        const msgs=parseChatFile(chat.path).map(m=>({
            name:m.name||(m.is_user?'User':cn),is_user:!!m.is_user,
            mes:clean(m.mes||''),send_date:m.send_date||m.create_date||'',
            extra:m.extra?{image:m.extra.image||null,title:m.extra.title||null}:null,
            swipe_id:m.swipe_id,swipes:m.swipes?m.swipes.length:0,
        }));
        json(res,{char:cn,file:chat.file,name:chat.name,messages:msgs,
            avatar:cd.avatar?`/api/image?path=${encodeURIComponent(cd.avatar)}`:null});return;
    }
    if(pn==='/api/images'){
        const{allImages}=scanAllData(dataRoots);
        const cf=p.query.char;
        let fl=allImages;
        if(cf)fl=allImages.filter(i=>(i.dir||'').toLowerCase().includes(cf.toLowerCase())||i.name.toLowerCase().includes(cf.toLowerCase()));
        const folders={};
        for(const i of fl){const d=i.dir||'기타';if(!folders[d])folders[d]=[];folders[d].push({name:i.name,dir:i.dir,url:`/api/image?path=${encodeURIComponent(i.path)}`});}
        json(res,{images:fl.map(i=>({name:i.name,dir:i.dir,url:`/api/image?path=${encodeURIComponent(i.path)}`})),folders});return;
    }
    if(pn==='/api/image'){
        const ip=p.query.path;if(!ip){res.writeHead(400);res.end();return;}
        const rp=path.resolve(ip);
        // /storage 와 HOME 둘 다 허용
        if(!dataRoots.some(r=>rp.startsWith(path.resolve(r)))&&!rp.startsWith(HOME)&&!rp.startsWith('/storage')){res.writeHead(403);res.end();return;}
        serve(rp,res);return;
    }
    if(pn==='/api/tags'){
        if(req.method==='GET'){json(res,loadJson(TAGS_FILE));return;}
        if(req.method==='POST'){try{saveJson(TAGS_FILE,JSON.parse(await body(req)));json(res,{ok:true});}catch(e){res.writeHead(400);json(res,{error:'bad'});}return;}
    }
    if(pn==='/api/settings'){
        if(req.method==='GET'){json(res,loadJson(SETTINGS_FILE));return;}
        if(req.method==='POST'){try{const d=JSON.parse(await body(req)),c=loadJson(SETTINGS_FILE);Object.assign(c,d);saveJson(SETTINGS_FILE,c);json(res,{ok:true});}catch(e){res.writeHead(400);json(res,{error:'bad'});}return;}
    }
    if(pn==='/api/roots'){json(res,{roots:dataRoots});return;}

    // ── 터미널 API ──
    if(pn==='/api/terminal/spawn'){
        if(req.method!=='POST'){res.writeHead(405);res.end();return;}
        try{
            const b=JSON.parse(await body(req));
            const term=createTerminal(b.cwd||HOME);
            json(res,{id:term.id,alive:true});
        }catch(e){res.writeHead(500);json(res,{error:e.message});}
        return;
    }
    if(pn==='/api/terminal/list'){
        const list=Object.values(terminals).map(t=>({id:t.id,alive:t.alive,cwd:t.cwd}));
        json(res,{terminals:list});return;
    }
    if(pn==='/api/terminal/input'){
        if(req.method!=='POST'){res.writeHead(405);res.end();return;}
        try{
            const b=JSON.parse(await body(req));
            const term=terminals[b.id];
            if(!term||!term.alive){json(res,{error:'터미널 없음'});return;}
            term.proc.stdin.write(b.data);
            json(res,{ok:true});
        }catch(e){json(res,{error:e.message});}
        return;
    }
    if(pn==='/api/terminal/signal'){
        if(req.method!=='POST'){res.writeHead(405);res.end();return;}
        try{
            const b=JSON.parse(await body(req));
            const term=terminals[b.id];
            if(!term||!term.alive){json(res,{error:'터미널 없음'});return;}
            const sig=b.signal||'SIGINT';
            // 프로세스 그룹에 시그널 전달 (자식 프로세스까지)
            try { process.kill(-term.proc.pid, sig); } catch(e) {
                try { term.proc.kill(sig); } catch(e2) {}
            }
            json(res,{ok:true,signal:sig});
        }catch(e){json(res,{error:e.message});}
        return;
    }
    if(pn==='/api/terminal/kill'){
        if(req.method!=='POST'){res.writeHead(405);res.end();return;}
        try{
            const b=JSON.parse(await body(req));
            const term=terminals[b.id];
            if(term){
                try{ term.proc.kill('SIGKILL'); }catch(e){}
                term.alive=false;
                delete terminals[b.id];
            }
            json(res,{ok:true});
        }catch(e){json(res,{error:e.message});}
        return;
    }
    if(pn==='/api/terminal/stream'){
        const id=p.query.id;
        const term=terminals[id];
        if(!term){res.writeHead(404);res.end('터미널 없음');return;}
        res.writeHead(200,{
            'Content-Type':'text/event-stream',
            'Cache-Control':'no-cache',
            'Connection':'keep-alive',
            'X-Accel-Buffering':'no',
        });
        // 기존 버퍼 전송
        if(term.buffer.length>0){
            const hist=term.buffer.join('');
            res.write(`data: ${JSON.stringify({type:'history',data:hist})}\n\n`);
        }
        if(!term.alive){
            res.write(`data: ${JSON.stringify({type:'exit',code:null,data:'[이미 종료된 세션]'})}\n\n`);
        }
        term.clients.push(res);
        req.on('close',()=>{
            term.clients=term.clients.filter(c=>c!==res);
        });
        // keep alive ping
        const ping=setInterval(()=>{
            try{res.write(': ping\n\n');}catch(e){clearInterval(ping);}
        },15000);
        req.on('close',()=>clearInterval(ping));
        return;
    }
    if(pn==='/api/terminal/buffer'){
        const id=p.query.id;
        const term=terminals[id];
        if(!term){json(res,{error:'터미널 없음'});return;}
        json(res,{buffer:term.buffer.join(''),alive:term.alive});
        return;
    }

    let fp=pn==='/'?'/index.html':pn;
    fp=path.join(__dirname,'public',fp);
    if(fs.existsSync(fp)&&fs.statSync(fp).isFile())serve(fp,res);
    else serve(path.join(__dirname,'public','index.html'),res);
}).listen(PORT,'0.0.0.0',()=>{
    console.log(`  🌐 http://localhost:${PORT}`);
    for(const r of dataRoots)console.log(`  📂 ${r}`);
    console.log('\n  💡 경로 지정: CHAT_LIBRARY_PATH=/경로 node server.js\n');
});
