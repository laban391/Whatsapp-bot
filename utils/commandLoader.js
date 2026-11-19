
/**
 * LABAN-XMD Command Loader
 * Compatible with original GAAJU-MD command structure
 */

const fs = require('fs');
const path = require('path');

const loadCommands = () => {
    const commands = new Map();
    const commandsPath = path.join(__dirname, '..', 'commands');

    if (!fs.existsSync(commandsPath)) {
        console.error('[COMMANDS] Commands directory not found');
        return commands;
    }

    function loadDirectory(directory) {
        const files = fs.readdirSync(directory);

        for (const file of files) {
            const fullPath = path.join(directory, file);

            try {
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    loadDirectory(fullPath);
                    continue;
                }

                if (!file.endsWith('.js')) continue;

                delete require.cache[require.resolve(fullPath)];

                const exported = require(fullPath);
                const cmds = Array.isArray(exported)
                    ? exported
                    : [exported];

                for (const command of cmds) {
                    if (!command || !command.name) {
                        console.warn(`[COMMANDS] Invalid command: ${file}`);
                        continue;
                    }

                    const names = [
                        command.name,
                        ...(Array.isArray(command.aliases)
                            ? command.aliases
                            : command.aliases
                                ? [command.aliases]
                                : [])
                    ];

                    for (const name of names) {
                        const key = String(name).toLowerCase().trim();

                        if (!key) continue;

                        commands.set(key, command);
                    }
                }

                console.log(`[COMMANDS] Loaded: ${file}`);

            } catch (error) {
                console.error(
                    `[COMMANDS] Error loading ${file}:`,
                    error.stack || error.message
                );
            }
        }
    }

    loadDirectory(commandsPath);

    console.log(
        `[COMMANDS] Successfully registered ${commands.size} command names.`
    );

    return commands;
};

module.exports = {
    loadCommands
};
