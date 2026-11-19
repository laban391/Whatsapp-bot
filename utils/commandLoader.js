
const fs = require('fs');
const path = require('path');

const commands = new Map();

function loadCommands() {
    commands.clear();

    const commandsDir = path.join(__dirname, '..', 'commands');

    if (!fs.existsSync(commandsDir)) {
        console.error('[COMMANDS] Commands directory not found:', commandsDir);
        return commands;
    }

    const files = fs.readdirSync(commandsDir)
        .filter(file => file.endsWith('.js'));

    for (const file of files) {
        const filePath = path.join(commandsDir, file);

        try {
            delete require.cache[require.resolve(filePath)];

            const command = require(filePath);

            if (!command || typeof command !== 'object') {
                console.warn(`[COMMANDS] Invalid command skipped: ${file}`);
                continue;
            }

            const name = command.command || command.name;

            if (!name) {
                console.warn(`[COMMANDS] No command name found: ${file}`);
                continue;
            }

            const names = Array.isArray(name) ? name : [name];

            for (const commandName of names) {
                commands.set(String(commandName).toLowerCase(), command);
            }

            console.log(`[COMMANDS] Loaded: ${file}`);
        } catch (error) {
            console.error(`[COMMANDS] Failed to load ${file}:`, error.message);
        }
    }

    console.log(`[COMMANDS] Loaded ${commands.size} command names.`);
    return commands;
}

function getCommand(name) {
    return commands.get(String(name).toLowerCase());
}

module.exports = {
    commands,
    loadCommands,
    getCommand
};
