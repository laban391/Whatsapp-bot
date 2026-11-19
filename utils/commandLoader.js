
const fs = require('fs');
const path = require('path');

const commands = new Map();
const commandFiles = new Map();

function loadCommands() {
    commands.clear();
    commandFiles.clear();

    const commandsDir = path.join(__dirname, '..', 'commands');

    if (!fs.existsSync(commandsDir)) {
        console.error('[COMMANDS] Folder not found:', commandsDir);
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
                console.error(`[COMMANDS] Invalid export: ${file}`);
                continue;
            }

            const names = [
                ...(Array.isArray(command.command)
                    ? command.command
                    : command.command ? [command.command] : []),
                ...(Array.isArray(command.alias)
                    ? command.alias
                    : command.alias ? [command.alias] : []),
                ...(Array.isArray(command.aliases)
                    ? command.aliases
                    : command.aliases ? [command.aliases] : []),
                ...(command.name ? [command.name] : [])
            ];

            if (!names.length) {
                console.warn(`[COMMANDS] No command name: ${file}`);
                continue;
            }

            for (const name of names) {
                const key = String(name).toLowerCase().trim();

                if (!key) continue;

                commands.set(key, command);
                commandFiles.set(key, file);
            }

            console.log(`[COMMANDS] Loaded ${file}`);
        } catch (error) {
            console.error(`[COMMANDS] FAILED ${file}:`, error.message);
        }
    }

    console.log(
        `[COMMANDS] ${files.length} files scanned; ${commands.size} command names registered.`
    );

    return commands;
}

function getCommand(name) {
    return commands.get(String(name).toLowerCase().trim());
}

module.exports = {
    commands,
    commandFiles,
    loadCommands,
    getCommand
};
