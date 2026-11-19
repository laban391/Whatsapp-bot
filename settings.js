//════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════//
//                                                                                                                                                                                        //
//                                                             GAAJU-X𝐌𝐃 𝐁𝐎𝐓                                                                                                     //
//                                                                                                                                                                                        //
//                                                                  𝐕 : 1.0.0                                                                                                             //
//                                                                                                                                                                                        //
//                                                                                                                                                                                        //
//                ██╗    ██╗ █████╗ ██╗     ██╗  ██╗   ██╗   ██╗ █████╗ ██╗   ██╗████████╗███████╗ ██████╗██╗  ██╗      ███╗   ███╗██████╗                                 //
//                ██║    ██║██╔══██╗██║     ██║  ╚██╗ ██╔╝   ██║██╔══██╗╚██╗ ██╔╝╚══██╔══╝██╔════╝██╔════╝██║  ██║      ████╗ ████║██╔══██╗                              //
//                ██║ █╗ ██║███████║██║     ██║   ╚████╔╝    ██║███████║ ╚████╔╝    ██║   █████╗  ██║     ███████║█████╗██╔████╔██║██║  ██║                               //
//                ██║███╗██║██╔══██║██║     ██║    ╚██╔╝██   ██║██╔══██║  ╚██╔╝     ██║   ██╔══╝  ██║     ██╔══██║╚════╝██║╚██╔╝██║██║  ██║                               //
//                ╚███╔███╔╝██║  ██║███████╗███████╗██║ ╚█████╔╝██║  ██║   ██║      ██║   ███████╗╚██████╗██║  ██║      ██║ ╚═╝ ██║██████╔╝                              //
//                 ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚════╝ ╚═╝  ╚═╝   ╚═╝      ╚═╝   ╚══════╝ ╚═════╝╚═╝  ╚═╝      ╚═╝     ╚═╝╚═════╝                                 //
//                                                                                                                                                                                        //
//                                                                 𝐂𝐎𝐏𝐘𝐑𝐈𝐆𝐇𝐓 2025                                                                                                        //
//                                                                                                                                                                                        //
//                                                                                                                                                                                        //
//════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════//
//* 
//  * project_name : LABAN-XMD
//  * author : laban
//  * youtube : https://www.youtube.com/Xchristech 
//  * description : LABAN-XMD ,A Multi-Device whatsapp user bot.
//*
//*
//re-upload? recode? copy code? give credit to gaajutech 2026:)
//Instagram: asvia
//Telegram: t.me/Official_ChrisGaaju
//GitHub: laban391 
//WhatsApp: +254708700675
//want more free bot scripts? subscribe to my youtube channel: https://youtube.com/@Xchristech
//   * Created By Github: laban.
//   * Credit To laban
//   * © 2026 LABAN-XMD.
// ⛥┌┤
// */

/**
 * ============================================
 *  LABAN-XMD BOT SETTINGS
 * ============================================
 * 
 * BOT LANGUAGE SETTINGS:
 * ----------------------
 * Change the default language by setting botLanguage to one of the codes below:
 * 
 * ┌────────────┬──────────────────┬──────────────────────┐
 * │ Code       │ Language         │ Native Name          │
 * ├────────────┼──────────────────┼──────────────────────┤
 * │ en         │ English          │ English              │
 * │ ha         │ Hausa            │ Hausa                │
 * │ yo         │ Yoruba           │ Èdè Yorùbá           │
 * │ ig         │ Igbo             │ Asụsụ Igbo           │
 * │ fr         │ French           │ Français             │
 * │ de         │ German           │ Deutsch              │
 * │ ar         │ Arabic           │ العربية              │
 * │ zh         │ Chinese          │ 中文                 │
 * │ hi         │ Hindi            │ हिन्दी               │
 * │ es         │ Spanish          │ Español              │
 * │ pt         │ Portuguese       │ Português            │
 * │ ru         │ Russian          │ Русский              │
 * │ ur         │ Urdu             │ اردو                 │
 * │ bn         │ Bengali          │ বাংলা                │
 * │ pcm        │ Pidgin           │ Pidgin               │
 * │ it         │ Italian          │ Italiano             │
 * │ id         │ Indonesian       │ Bahasa Indonesia     │
 * │ ja         │ Japanese         │ 日本語               │
 * │ sw         │ Swahili          │ Kiswahili            │
 * │ tr         │ Turkish          │ Türkçe               │
 * │ ko         │ Korean           │ 한국어               │
 * │ vi         │ Vietnamese       │ Tiếng Việt           │
 * │ ta         │ Tamil            │ தமிழ்                │
 * └────────────┴──────────────────┴──────────────────────┘
 * 
 * EXAMPLE:
 * botLanguage: "ha"    // Sets bot default language to Hausa
 * botLanguage: "yo"    // Sets bot default language to Yoruba
 * botLanguage: "ig"    // Sets bot default language to Igbo
 * botLanguage: "en"    // Sets bot default language to English (Default)
 * 
 * USERS CAN STILL CHANGE LANGUAGE USING: .language <code>
 * ============================================
 */

const settings = {
  // ========== BOT INFORMATION ==========
  packname: 'LABAN-XMD',
  author: '‎Laban',
  botName: "LABAN-XMD",
  botOwner: 'Laban',
  description: "Laban-XMD ,A Multi-Device whatsapp user bot",
  version: "3.0.5",
  
  // ========== BOT LANGUAGE ==========
  // Change this to any language code from the table above
  // Default: "en" (English)
  botLanguage: "en",  // ← Change this to your preferred language code
  
  // ========== BOT CONFIGURATION ==========
  timezone: 'Africa/Lagos',
  prefix: '.',
  ownerNumber: '254708700675',
  commandMode: "private",
  
  // ========== API KEYS ==========
  giphyApiKey: 'qnl7ssQChTdPjsKta2Ax2LMaGXz303tq',
  
  // ========== STORAGE SETTINGS ==========
  maxStoreMessages: 20,
  storeWriteInterval: 10000,
  
  // ========== UPDATE SETTINGS ==========
  updateZipUrl: "https://github.com/Xchristech2/GAAJU-XMD/archive/refs/heads/main.zip",
};

module.exports = settings;
