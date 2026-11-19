
/**
 * LABAN-XMD Command Loader
 *
 * Recursively loads commands from the commands directory.
 * Supports:
 * - Nested command folders
 * - Commands in the root commands folder
 * - Single command exports
 * - Arrays of command exports
 * - String aliases
 * - Array aliases
 *
 * Original command files remain unchanged.
 */

const fs = require('fs');
const path = require('path');

function normalizeName(value) {
    return typeof value === 'string'
        ? value.trim().toLowerCase()
        : '';
}

function getCommandExports(exported) {
    if (Array.isArray(exported)) {
        return exported;
    }

    if (
        exported &&
        typeof exported === 'object' &&
        exported.default
    ) {
        return getCommandExports(exported.default);
    }

    return exported && typeof exported === 'object'
        ? [exported]
        : [];
}

function getAliases(aliases) {
    if (Array.isArray(aliases)) {
        return aliases;
    }

    if (typeof aliases === 'string') {
        return [aliases];
    }

    return [];
}

function loadCommands() {
    const commands = new Map();

    const commandRoot = path.join(
        __dirname,
        '..',
        'commands'
    );

    const discovered = [];
    const canonicalNames = new Map();

    if (!fs.existsSync(commandRoot)) {
        console.error(
            `[COMMANDS] Commands directory not found: ${commandRoot}`
        );

        return commands;
    }

    function walk(directory) {
        let entries;

        try {
            entries = fs.readdirSync(directory, {
                withFileTypes: true
            }).sort((a, b) =>
                a.name.localeCompare(b.name)
            );
        } catch (error) {
            console.error(
                `[COMMANDS] Cannot read ${directory}: ${error.message}`
            );

            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(
                directory,
                entry.name
            );

            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }

            if (
                !entry.isFile() ||
                !entry.name.toLowerCase().endsWith('.js')
            ) {
                continue;
            }

            try {
                const exported = require(fullPath);
                const items = getCommandExports(exported);

                for (const command of items) {
                    if (
                        !command ||
                        typeof command !== 'object'
                    ) {
                        continue;
                    }

                    const name = normalizeName(command.name);

                    if (!name) {
                        continue;
                    }

                    if (typeof command.execute !== 'function') {
                        console.error(
                            `[COMMANDS] Skipped "${name}" in ${path.relative(commandRoot, fullPath)}: execute() is missing.`
                        );

                        continue;
                    }

                    const relativeFile = path.relative(
                        commandRoot,
                        fullPath
                    );

                    if (canonicalNames.has(name)) {
                        console.error(
                            `[COMMANDS] Duplicate command "${name}" in ${relativeFile}; keeping ${canonicalNames.get(name)}.`
                        );

                        continue;
                    }

                    canonicalNames.set(name, relativeFile);

                    discovered.push({
                        name,
                        command,
                        aliases: getAliases(command.aliases),
                        file: relativeFile
                    });
                }
            } catch (error) {
                console.error(
                    `[COMMANDS] Failed to load ${path.relative(commandRoot, fullPath)}:`,
                    error && error.stack
                        ? error.stack
                        : error
                );
            }
        }
    }

    walk(commandRoot);

    // Register command names first.
    for (const item of discovered) {
        commands.set(item.name, item.command);
    }

    // Register aliases without overwriting real command names.
    for (const item of discovered) {
        for (const rawAlias of item.aliases) {
            const alias = normalizeName(rawAlias);

            if (!alias || alias === item.name) {
                continue;
            }

            if (canonicalNames.has(alias)) {
                console.warn(
                    `[COMMANDS] Alias "${alias}" from ${item.file} conflicts with a real command.`
                );

                continue;
            }

            if (commands.has(alias)) {
                console.warn(
                    `[COMMANDS] Duplicate alias "${alias}" from ${item.file}; first command kept.`
                );

                continue;
            }

            commands.set(alias, item.command);
        }
    }

    console.log(
        `[COMMANDS] Loaded ${discovered.length} command modules; registered ${commands.size} command names/aliases.`
    );

    return commands;
}

module.exports = {
    loadCommands
};
