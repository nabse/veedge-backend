export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    }

    if (request.method === 'OPTIONS') return new Response('', { headers: cors })
    if (url.pathname === '/health') return new Response(JSON.stringify({ ok: true }), { headers: cors })

    // Route 1: /transcript?v=VIDEO_ID (tries Innertube)
    // Route 2: /caption?url=CAPTION_URL (fetches a specific caption URL sent from browser)
    
    if (url.pathname === '/caption') {
      const captionUrl = url.searchParams.get('url')
      if (!captionUrl) return new Response(JSON.stringify({ error: 'Missing ?url=' }), { status: 400, headers: cors })
      try {
        const transcript = await fetchCaptionUrl(captionUrl)
        return new Response(JSON.stringify({ transcript }), { headers: cors })
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors })
      }
    }

    if (url.pathname === '/transcript') {
      const videoId = url.searchParams.get('v')
      if (!videoId) return new Response(JSON.stringify({ error: 'Missing ?v=' }), { status: 400, headers: cors })
      try {
        const transcript = await getTranscript(videoId)
        return new Response(JSON.stringify({ transcript }), { headers: cors })
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors })
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: cors })
  }
}

// Called when extension sends a caption URL extracted from the browser
async function fetchCaptionUrl(captionUrl) {
  const res = await fetch(captionUrl + '&fmt=xml')
  const xml = await res.text()
  if (!xml || xml.trim().length < 30) throw new Error('Caption file was empty.')
  return parseXML(xml)
}

// Tries to get transcript directly (works for some videos)
async function getTranscript(videoId) {
  // Try multiple Innertube clients
  const clients = [
    { name: 'ANDROID', version: '19.09.37', header: '3',
      ua: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11)' },
    { name: 'IOS', version: '19.09.3', header: '5',
      ua: 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)' },
    { name: 'TVHTML5', version: '7.20231121.15.00', header: '7',
      ua: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 Chrome/120 Safari/538.1' },
  ]

  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': client.ua,
          'X-YouTube-Client-Name': client.header,
          'X-YouTube-Client-Version': client.version,
        },
        body: JSON.stringify({
          videoId,
          context: { client: { clientName: client.name, clientVersion: client.version, hl: 'en', gl: 'US' } }
        })
      })
      const data = await res.json()
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (tracks?.length) {
        const rank = t => { const en = t.languageCode?.startsWith('en'), auto = t.kind === 'asr'; return en && !auto ? 0 : !auto ? 1 : en ? 2 : 3 }
        const track = [...tracks].sort((a, b) => rank(a) - rank(b))[0]
        const transcript = await fetchCaptionUrl(track.baseUrl)
        if (transcript) return transcript
      }
    } catch {}
  }
  throw new Error('No captions found. The extension will extract them directly from your browser.')
}

function parseXML(xml) {
  const parts = []
  const re = /<(?:text|p)[^>]*>([\s\S]*?)<\/(?:text|p)>/gi
  let m
  while ((m = re.exec(xml)) !== null) {
    const s = m[1]
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/&#(\d+);/g,(_, n) => String.fromCharCode(+n))
      .replace(/<[^>]+>/g,'').replace(/\n/g,' ').trim()
    if (s) parts.push(s)
  }
  if (!parts.length) throw new Error('Could not parse captions.')
  return parts.join(' ').replace(/\s{2,}/g, ' ').trim()
}
