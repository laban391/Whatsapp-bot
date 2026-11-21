
const APIs = require('../lib/api');

async function aiCommand(sock, chatId, message) {
    const rawText =
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        message.message?.imageMessage?.caption ||
        message.message?.videoMessage?.caption ||
        '';

    const match = rawText.trim().match(
        /^\.(?:ai|gpt|gemini)(?:\s+([\s\S]*))?$/i
    );

    if (!match) return;

    const query = match[1]?.trim();

    if (!query) {
        return sock.sendMessage(chatId, {
            text: '🤖 *LABAN-XMD AI*\n\n' +
                'Usage: .ai <question>\n' +
                'Aliases: .gpt, .gemini\n\n' +
                'Example: .ai Hello'
        }, { quoted: message });
    }

    try {
        await sock.sendMessage(chatId, {
            react: { text: '🤖', key: message.key }
        });

        const answer = await APIs.geminiAI(query);

        const output = `🤖 *LABAN-XMD AI*\n\n${answer}`;
        const chunks = output.match(/[\s\S]{1,3500}/g) || [output];

        for (const chunk of chunks) {
            await sock.sendMessage(chatId, {
                text: chunk
            }, { quoted: message });
        }

        await sock.sendMessage(chatId, {
            react: { text: '✅', key: message.key }
        });

    } catch (err) {
        console.error('[LABAN-XMD AI]', err);

        let reply = '❌ AI service is temporarily unavailable. Try again later.';

        if (err.code === 'AI_CONFIG_MISSING') {
            reply = '⚙️ Gemini API key is missing. Check Pxxl environment variables.';
        } else if (err.code === 'AI_API_KEY_INVALID') {
            reply = '🔑 Gemini API key is invalid. Check your API key.';
        } else if (err.code === 'AI_RATE_LIMIT') {
            reply = '⏳ Gemini free-tier limit reached. Please wait and retry.';
        }

        await sock.sendMessage(chatId, {
            text: reply
        }, { quoted: message });
    }
}

module.exports = aiCommand;
