// ==========================================
// LABAN-XMD REQUIRED GROUP LOOKUP
// ==========================================

async function getRequiredGroupJid(sock) {
    if (requiredGroupJid) {
        return requiredGroupJid;
    }

    console.log('[MEMBERSHIP] Starting group lookup...');

    // First attempt: use the group invite code
    try {
        const info = await sock.groupGetInviteInfo(
            REQUIRED_GROUP_INVITE
        );

        if (info && info.id) {
            requiredGroupJid = info.id;

            console.log(
                '[MEMBERSHIP] Group found using invite link:',
                requiredGroupJid
            );

            return requiredGroupJid;
        }
    } catch (error) {
        console.error(
            '[MEMBERSHIP] Invite lookup failed:',
            error.message
        );
    }

    // Second attempt: list groups the bot has joined
    try {
        console.log(
            '[MEMBERSHIP] Fetching groups joined by the bot...'
        );

        const groups = await sock.groupFetchAllParticipating();

        if (!groups || Object.keys(groups).length === 0) {
            throw new Error('The bot has not loaded any groups.');
        }

        console.log(
            '[MEMBERSHIP] GROUPS FOUND:',
            Object.values(groups).map(group => ({
                name: group.subject,
                id: group.id
            }))
        );

        throw new Error(
            'Could not identify the required group automatically. Check the group list in Pxxl logs.'
        );

    } catch (error) {
        console.error(
            '[MEMBERSHIP] Group lookup error:',
            error.message
        );

        throw error;
    }
}
