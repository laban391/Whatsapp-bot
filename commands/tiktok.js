const { ttdl } = require('ruhend-scraper');
const settings = require('../settings');
const APIs = require('../lib/api');
const { fetchWhatsAppVideo, slideshowToWhatsAppVideo } = require('../lib/waVideo');

const processedMessages = new Set();

const TT_PATTERNS = [
  /https?:\/\/(?:www\.)?tiktok\.com\//i,
  /https?:\/\/(?:vm\.)?tiktok\.com\//i,
  /https?:\/\/(?:vt\.)?tiktok\.com\//i,
];

function extractUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[)\]>.,]+$/g, '') : '';
}

function tikTokUrlVariants(url) {
  const variants = [url];
  const m = String(url).match(/^(https?:\/\/(?:vt|vm)\.tiktok\.com\/)([A-Za-z0-9]+)(\/?.*)?$/i);
  if (!m) return variants;
  const upper = `${m[1]}${m[2].toUpperCase()}${m[3] || '/'}`;
  const lower = `${m[1]}${m[2].toLowerCase()}${m[3] || '/'}`;
  for (const v of [upper, lower]) {
    if (!variants.includes(v)) variants.push(v);
  }
  return variants;
}

function captionFor(title) {
  const bot = (settings.botName || 'Knight Bot').toUpperCase();
  return title ? `*DOWNLOADED BY ${bot}*\n\n📝 ${title}` : `*DOWNLOADED BY ${bot}*`;
}

const TT_HEADERS = {
  Referer: 'https://www.tiktok.com/',
  Origin: 'https://www.tiktok.com',
  'Accept-Encoding': 'identity',
};

/** ruhend ttdl: { video, video_hd } or older { data: [...] } */
async function scraperTikTokDownload(url) {
  const data = await ttdl(url);
  const direct =
    data?.video_hd || data?.video || data?.video_wm || data?.hdplay || data?.play || null;
  if (direct && /^https?:\/\//i.test(direct)) {
    return {
      title: data.title || 'TikTok Video',
      thumbnail: data.cover || null,
      download: direct,
    };
  }
  if (data?.data?.length) {
    const video =
      data.data.find((m) => m.type === 'video' || /\.(mp4|mov|webm)$/i.test(m.url || '')) ||
      data.data[0];
    if (video?.url) {
      return { title: data.title || 'TikTok Video', download: video.url };
    }
  }
  throw new Error('No video URL found');
}


async function expandTikTokUrl(url) {
  // TikTok share links (vt./vm.) often need redirect resolution before third-party APIs parse them.
  try {
    const response = await require('axios').get(url, {
      timeout: 20000,
      maxRedirects: 8,
      validateStatus: status => status >= 200 && status < 500,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*'
      }
    });
    const finalUrl = response.request?.res?.responseUrl || response.request?._redirectable?._currentUrl;
    if (finalUrl && /^https?:\/\/(?:www\.)?tiktok\.com\//i.test(finalUrl)) {
      console.log('[tiktok] Short link resolved');
      return finalUrl;
    }
  } catch (err) {
    console.log('[tiktok] Short-link expansion skipped:', err?.message || err);
  }
  return url;
}

function normalizeTikWMUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const url = value.trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `https://www.tikwm.com${url}`;
  return null;
}

async function tikwmDownload(url) {
  const axios = require('axios');
  const form = new URLSearchParams({
    url,
    count: '12',
    cursor: '0',
    web: '1',
    hd: '1'
  });
  const response = await axios.post('https://www.tikwm.com/api/', form.toString(), {
    timeout: 60000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.tikwm.com/',
      Origin: 'https://www.tikwm.com'
    }
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`TikWM HTTP ${response.status}`);
  }

  const payload = response.data;
  const result = payload?.data;
  if (Number(payload?.code) !== 0 || !result || typeof result !== 'object') {
    throw new Error(payload?.msg || payload?.message || 'TikWM could not parse this TikTok link');
  }

  const download =
    normalizeTikWMUrl(result.hdplay) ||
    normalizeTikWMUrl(result.play) ||
    normalizeTikWMUrl(result.wmplay);

  if (!download) {
    throw new Error('TikWM returned no usable video URL');
  }

  return {
    title: result.title || 'TikTok Video',
    thumbnail: result.cover || null,
    download
  };
}

async function resolveTikTok(url) {
  const errors = [];
  const resolvedUrl = await expandTikTokUrl(url);
  const candidates = [...new Set([
    ...tikTokUrlVariants(resolvedUrl),
    ...tikTokUrlVariants(url)
  ])];

  for (const candidate of candidates) {
    try {
      const dl = await APIs.knightTikTokDownload(candidate);
      if (dl?.download && /^https?:\/\//i.test(dl.download)) {
        console.log(`[tiktok] Knight OK video (${candidate})`);
        return dl;
      }
      if (dl?.images?.length) {
        console.log(`[tiktok] Knight OK slideshow (${candidate}) images=${dl.images.length}`);
        return dl;
      }
      errors.push('Knight: no downloadable media returned');
    } catch (err) {
      errors.push(`Knight: ${err?.message || err}`);
      console.log('[tiktok] Knight failed:', err?.message || err);
    }
  }

  // ruhend-scraper currently can throw when its upstream omits region metadata.
  // Keep it as a best-effort provider, but never let that stop the TikWM fallback.
  for (const candidate of candidates) {
    try {
      const dl = await scraperTikTokDownload(candidate);
      if (dl?.download && /^https?:\/\//i.test(dl.download)) {
        console.log(`[tiktok] ttdl OK (${candidate})`);
        return dl;
      }
      errors.push('ttdl: no usable video URL returned');
    } catch (err) {
      errors.push(`ttdl: ${err?.message || err}`);
      console.log('[tiktok] ttdl failed:', err?.message || err);
    }
  }

  for (const candidate of candidates) {
    try {
      const dl = await tikwmDownload(candidate);
      console.log(`[tiktok] TikWM OK (${candidate})`);
      return dl;
    } catch (err) {
      errors.push(`TikWM: ${err?.message || err}`);
      console.log('[tiktok] TikWM failed:', err?.message || err);
    }
  }

  throw new Error(errors.join(' | ') || 'All TikTok sources failed');
}

async function tiktokCommand(sock, chatId, message) {
  try {
    if (processedMessages.has(message.key.id)) return;
    processedMessages.add(message.key.id);
    setTimeout(() => processedMessages.delete(message.key.id), 5 * 60 * 1000);

    const text =
      message.message?.conversation || message.message?.extendedTextMessage?.text || '';
    const url = extractUrl(text);

    if (!url) {
      return sock.sendMessage(
        chatId,
        { text: 'Please provide a TikTok link.\nExample: `.tiktok https://vm.tiktok.com/...`' },
        { quoted: message }
      );
    }
    if (!TT_PATTERNS.some((p) => p.test(url))) {
      return sock.sendMessage(
        chatId,
        { text: 'That is not a valid TikTok link.' },
        { quoted: message }
      );
    }

    await sock.sendMessage(chatId, { react: { text: '🔄', key: message.key } });

    const dl = await resolveTikTok(url);
    let video;

    if (dl.images?.length && !dl.download) {
      // CDN has no mp4 for photo posts — build one from images + audio
      video = await slideshowToWhatsAppVideo(dl.images, dl.audio || null, TT_HEADERS);
    } else if (dl.download) {
      video = await fetchWhatsAppVideo(dl.download, TT_HEADERS);
    } else {
      throw new Error('Invalid download response');
    }

    await sock.sendMessage(
      chatId,
      { video, mimetype: 'video/mp4', caption: captionFor(dl.title) },
      { quoted: message }
    );
  } catch (err) {
    console.error('[tiktok]', err?.message || err);
    await sock.sendMessage(
      chatId,
      { text: '❌ Failed to download TikTok video. Try again with a different link.' },
      { quoted: message }
    );
  }
}

module.exports = tiktokCommand;
