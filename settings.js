require('dotenv').config();

const settings = {
  packname: 'LABAN-XMD',
  author: 'Laban',
  botName: 'LABAN-XMD',
  botOwner: process.env.BOT_OWNER || 'Laban',
  // Set OWNER_NUMBER in your hosting environment or .env (country code, digits only).
  ownerNumber: process.env.OWNER_NUMBER || '254XXXXXXXXX',
  giphyApiKey: process.env.GIPHY_API_KEY || '',
  commandMode: 'public',
  maxStoreMessages: 20,
  storeWriteInterval: 10000,
  description: 'LABAN-XMD WhatsApp bot.',
  version: '1.0.0',
  updateZipUrl: '',
  knightApiUrl: process.env.KNIGHT_API_URL || 'https://knightbotapi.stream',
  knightApiKey: process.env.KNIGHT_API_KEY || 'knight',
  mediaApiUrl: process.env.MEDIA_API_URL || 'https://knightbotapi.stream',
  mediaApiKey: process.env.MEDIA_API_KEY || 'knight',
  princeApiUrl: process.env.PRINCE_API_URL || 'https://api.princetechn.com',
  princeApiKey: process.env.PRINCE_API_KEY || 'prince'
};

global.sessionid = process.env.SESSION_ID;
module.exports = settings;
