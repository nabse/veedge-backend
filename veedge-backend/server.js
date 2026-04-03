// Veedge Backend API — deployable on Railway, Render, Fly.io
// Uses yt-dlp binary bundled at startup

const http = require('http');
const https = require('https');
const { execFile, exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const urlMod = require('url');

const PORT = process.env.PORT || 3000;
const YTDLP_PATH = path.join(__dirname, 'bin', 'yt-dlp');

// ── Download yt-dlp binary on cold start ──────────────────────────────────────
async function ensureYtdlp() {
  const binDir = path.join(__dirname, 'bin');
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

  if (fs.existsSync(YTDLP_PATH)) {
    console.log('yt-dlp already present');
    return;
  }

  console.log('Downloading yt-dlp...');
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(YTDLP_PATH);
    https.get(url, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        https.get(res.headers.location, r => r.pipe(file)).on('error', reject);
      } else {
        res.pipe(file);
      }
      file.on('finish', () => {
        file.close();
        fs.chmodSync(YTDLP_PATH, '755');
        console.log('yt-dlp downloaded');
        resolve();
      });
    }).on('error', reject);
  });
}

// ── Transcript fetching ───────────────────────────────────────────────────────
function fetchWithYtdlp(videoId) {
  return new Promise((resolve) => {
    const outPath = path.join(os.tmpdir(), `veedge_${videoId}_${Date.now()}`);
    const args = [
      '--write-auto-sub', '--write-sub',
      '--sub-langs', 'en.*,fr,es,pt.*,ar,de,it',
      '--sub-format', 'json3',
      '--skip-download', '--no-playlist', '--no-warnings',
      '-o', outPath,
      `https://www.youtube.com/watch?v=${videoId}`
    ];

    execFile(YTDLP_PATH, args, { timeout: 45000 }, (err) => {
      try {
        const files = fs.readdirSync(os.tmpdir())
          .filter(f => f.startsWith(path.basename(outPath)) && f.endsWith('.json3'));

        for (const fname of files) {
          const fpath = path.join(os.tmpdir(), fname);
          try {
            const data = JSON.parse(fs.readFileSync(fpath, 'utf8'));
            fs.unlinkSync(fpath);
            const parts = (data.events || [])
              .filter(e => e.segs)
              .flatMap(e => e.segs.map(s => (s.utf8 || '').replace(/\n/g, ' ').trim()))
              .filter(s => s && s.trim());
            const text = parts.join(' ').replace(/\s{2,}/g, ' ').trim();
            if (text.length > 50) { resolve(text); return; }
          } catch { try { fs.unlinkSync(fpath); } catch {} }
        }
      } catch {}
      resolve(null);
    });
  });
}

function httpsGet(reqUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(reqUrl);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        ...headers
      }
    }, res => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location)
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject).setTimeout(20000, function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function extractTracks(html) {
  const idx = html.indexOf('"captionTracks"');
  if (idx === -1) return null;
  const arrStart = html.indexOf('[', idx);
  if (arrStart === -1) return null;
  let depth = 0, inStr = false, i = arrStart;
  while (i < html.length) {
    const c = html[i];
    if (inStr) { if (c === '\\') { i += 2; continue; } if (c === '"') inStr = false; }
    else { if (c === '"') inStr = true; else if (c==='['||c==='{') depth++; else if (c===']'||c==='}') { depth--; if (depth===0) { try { return JSON.parse(html.slice(arrStart,i+1)).filter(t=>t?.baseUrl); } catch {} break; } } }
    i++;
  }
  return null;
}

function parseXML(xml) {
  const parts=[], re=/<(?:text|p)[^>]*>([\s\S]*?)<\/(?:text|p)>/gi; let m;
  while((m=re.exec(xml))!==null){
    const s=m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/<[^>]+>/g,'').replace(/\n/g,' ').trim();
    if(s)parts.push(s);
  }
  return parts.join(' ').replace(/\s{2,}/g,' ').trim();
}

async function directFetch(videoId) {
  const {body:html} = await httpsGet(`https://www.youtube.com/watch?v=${videoId}`);
  const tracks = extractTracks(html);
  if (!tracks?.length) throw new Error('No captions found.');
  const rank=t=>{const en=t.languageCode?.startsWith('en'),auto=t.kind==='asr';return en&&!auto?0:!auto?1:en?2:3;};
  const track=[...tracks].sort((a,b)=>rank(a)-rank(b))[0];
  for (const u of [track.baseUrl+'&fmt=xml',track.baseUrl+'&fmt=json3']) {
    const {status,body} = await httpsGet(u,{'Referer':`https://www.youtube.com/watch?v=${videoId}`});
    if (status===200 && body.trim().length>30) {
      const t=body.trim();
      if(t.startsWith('<')){const p=parseXML(t);if(p.length>20)return p;}
      else{try{const j=JSON.parse(t);const p=(j.events||[]).filter(e=>e.segs).flatMap(e=>e.segs.map(s=>(s.utf8||'').replace(/\n/g,' ').trim())).filter(Boolean).join(' ').trim();if(p.length>20)return p;}catch{}}
    }
  }
  throw new Error('Caption file empty.');
}

async function getTranscript(videoId) {
  const t1 = await fetchWithYtdlp(videoId);
  if (t1) return t1;
  return await directFetch(videoId);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
function respond(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { respond(res, 200, {}); return; }
  const p = urlMod.parse(req.url, true);

  if (p.pathname === '/') { respond(res, 200, { service: 'Veedge API', status: 'ok' }); return; }
  if (p.pathname === '/health') { respond(res, 200, { ok: true }); return; }

  if (p.pathname === '/transcript') {
    const v = p.query.v;
    if (!v) { respond(res, 400, { error: 'Missing ?v= parameter' }); return; }
    try {
      const transcript = await getTranscript(v);
      respond(res, 200, { transcript });
    } catch (e) {
      console.error(`[ERR] ${v}: ${e.message}`);
      respond(res, 500, { error: e.message });
    }
    return;
  }

  respond(res, 404, { error: 'Not found' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
ensureYtdlp()
  .then(() => {
    server.listen(PORT, () => console.log(`Veedge API running on port ${PORT}`));
  })
  .catch(e => {
    console.warn('Could not download yt-dlp:', e.message, '— falling back to direct fetch only');
    server.listen(PORT, () => console.log(`Veedge API running on port ${PORT} (no yt-dlp)`));
  });
