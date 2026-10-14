const {
  SlashCommandBuilder, PermissionsBitField, ChannelType
} = require('discord.js');
const { validateCommandPayload } = require('./payloadValidator');

/**
 * Builds the canonical list of Application Slash Commands.
 * Strict canonical group order:
 *  1. SECURITY
 *  2. SONGS
 *  3. WELCOME
 *  4. LEFT
 *  5. LOGS
 *  6. INV
 *  7. GAMES
 *  Followed by GENERAL UTILITIES
 */
function buildApplicationCommands() {
  const commands = [
    // =============================================================================
    // 1. SECURITY COMMAND GROUP
    // =============================================================================,

    new SlashCommandBuilder()
      .setName('security')
      .setDescription('Server security engine, anti-nuke, anti-mod, lockdown and recovery')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      // Core security subcommands
      .addSubcommand(s => s.setName('status').setDescription('View security protection overview, thresholds & recent incidents'))
      .addSubcommand(s => s.setName('diagnostics').setDescription('View measured internal latency (p50/p95/p99) and telemetry'))
      .addSubcommand(s => s.setName('incidents').setDescription('View recent security incident history'))
      .addSubcommand(s => s.setName('audit').setDescription('View high-level security configuration & permission health check'))
      .addSubcommand(s => s.setName('test').setDescription('Simulate and test security event pipeline and alert dispatch'))
      // Lockdown and recovery subcommands
      .addSubcommand(s => s.setName('lockdown').setDescription('Engage emergency lockdown while preserving private & log channels'))
      .addSubcommand(s => s.setName('unlock').setDescription('Lift emergency lockdown and restore saved permissions'))
      // Anti-nuke subcommand group
      .addSubcommandGroup(g => g.setName('antinuke').setDescription('High-speed anti-nuke protection')
        .addSubcommand(s => s.setName('status').setDescription('View anti-nuke protection status, limits and active thresholds'))
        .addSubcommand(s => s.setName('configure').setDescription('Configure anti-nuke thresholds, actions, and time windows')
          .addStringOption(o => o.setName('toggle').setDescription('Enable or disable anti-nuke').setRequired(false).addChoices(
            { name: 'Enable', value: 'enable' },
            { name: 'Disable', value: 'disable' }
          ))
          .addStringOption(o => o.setName('action').setDescription('Enforcement action').setRequired(false).addChoices(
            { name: 'Strip Roles & Instant Ban (Recommended)', value: 'strip_and_ban' },
            { name: 'Strip Dangerous Roles Only (Safe)', value: 'strip_roles' },
            { name: 'Instant Ban Only', value: 'ban' },
            { name: 'Instant Kick', value: 'kick' },
            { name: 'Quarantine Only', value: 'quarantine' },
            { name: 'Alert Only (No Punishment)', value: 'alert' }
          ))
          .addIntegerOption(o => o.setName('channel_delete_limit').setDescription('Max channel deletions allowed in window').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('channel_create_limit').setDescription('Max channel creations allowed in window').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('role_delete_limit').setDescription('Max role deletions allowed in window').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('role_create_limit').setDescription('Max role creations allowed in window').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('ban_limit').setDescription('Max member bans allowed in window').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('kick_limit').setDescription('Max member kicks allowed in window').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('window_seconds').setDescription('Rolling window in seconds (default: 15s)').setRequired(false).setMinValue(3).setMaxValue(120)))
        .addSubcommand(s => s.setName('test').setDescription('Simulate an anti-nuke event and measure pipeline reaction time')))
      // Anti-moderator abuse subcommand group (user requested /security antomod)
      .addSubcommandGroup(g => g.setName('antomod').setDescription('Anti-moderator abuse protection')
        .addSubcommand(s => s.setName('status').setDescription('View anti-moderator abuse status and velocity thresholds'))
        .addSubcommand(s => s.setName('configure').setDescription('Configure anti-moderator abuse thresholds and containment')
          .addStringOption(o => o.setName('toggle').setDescription('Enable or disable anti-mod engine').setRequired(false).addChoices(
            { name: 'Enable', value: 'enable' },
            { name: 'Disable', value: 'disable' }
          ))
          .addStringOption(o => o.setName('action').setDescription('Containment action').setRequired(false).addChoices(
            { name: 'Strip Roles & Quarantine (Safe)', value: 'strip_roles' },
            { name: 'Strip Roles & Instant Ban', value: 'strip_and_ban' },
            { name: 'Instant Ban', value: 'ban' },
            { name: 'Instant Kick', value: 'kick' },
            { name: 'Alert Only', value: 'alert' }
          ))
          .addIntegerOption(o => o.setName('ban_limit').setDescription('Max mod bans before containment').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('kick_limit').setDescription('Max mod kicks before containment').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('timeout_limit').setDescription('Max timeouts before containment').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('role_limit').setDescription('Max role assignments before containment').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('window_seconds').setDescription('Burst window in seconds (default: 30s)').setRequired(false).setMinValue(5).setMaxValue(120)))
        .addSubcommand(s => s.setName('test').setDescription('Simulate a mod velocity check and evaluate containment')))
      // Anti-moderator abuse alias (for standard /security antimod)
      .addSubcommandGroup(g => g.setName('antimod').setDescription('Anti-moderator abuse protection (standard alias)')
        .addSubcommand(s => s.setName('status').setDescription('View anti-moderator abuse status and velocity thresholds'))
        .addSubcommand(s => s.setName('configure').setDescription('Configure anti-moderator abuse thresholds and containment')
          .addStringOption(o => o.setName('toggle').setDescription('Enable or disable anti-mod engine').setRequired(false).addChoices(
            { name: 'Enable', value: 'enable' },
            { name: 'Disable', value: 'disable' }
          ))
          .addStringOption(o => o.setName('action').setDescription('Containment action').setRequired(false).addChoices(
            { name: 'Strip Roles & Quarantine (Safe)', value: 'strip_roles' },
            { name: 'Strip Roles & Instant Ban', value: 'strip_and_ban' },
            { name: 'Instant Ban', value: 'ban' },
            { name: 'Instant Kick', value: 'kick' },
            { name: 'Alert Only', value: 'alert' }
          ))
          .addIntegerOption(o => o.setName('ban_limit').setDescription('Max mod bans before containment').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('kick_limit').setDescription('Max mod kicks before containment').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('timeout_limit').setDescription('Max timeouts before containment').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('role_limit').setDescription('Max role assignments before containment').setRequired(false).setMinValue(1).setMaxValue(20))
          .addIntegerOption(o => o.setName('window_seconds').setDescription('Burst window in seconds (default: 30s)').setRequired(false).setMinValue(5).setMaxValue(120)))
        .addSubcommand(s => s.setName('test').setDescription('Simulate a mod velocity check and evaluate containment')))
      // Anti-raid subcommand group
      .addSubcommandGroup(g => g.setName('antiraid').setDescription('Anti-raid protection and mass join quarantine')
        .addSubcommand(s => s.setName('status').setDescription('View anti-raid status, risk thresholds and quarantine count'))
        .addSubcommand(s => s.setName('configure').setDescription('Configure anti-raid join thresholds and quarantine behavior')
          .addStringOption(o => o.setName('toggle').setDescription('Enable or disable anti-raid').setRequired(false).addChoices(
            { name: 'Enable', value: 'enable' },
            { name: 'Disable', value: 'disable' }
          ))
          .addStringOption(o => o.setName('action').setDescription('Raid containment action').setRequired(false).addChoices(
            { name: 'Quarantine Member (Recommended)', value: 'quarantine' },
            { name: 'Instant Kick', value: 'kick' },
            { name: 'Instant Ban', value: 'ban' },
            { name: 'Alert Only', value: 'alert' }
          ))
          .addIntegerOption(o => o.setName('join_threshold').setDescription('Max joins in window before raid trigger (default: 5)').setRequired(false).setMinValue(2).setMaxValue(30))
          .addIntegerOption(o => o.setName('window_seconds').setDescription('Join window in seconds (default: 10s)').setRequired(false).setMinValue(3).setMaxValue(60))
          .addIntegerOption(o => o.setName('quarantine_duration_minutes').setDescription('Auto-expire quarantine in minutes (0 to disable, default: 30)').setRequired(false).setMinValue(0).setMaxValue(1440)))
        .addSubcommand(s => s.setName('test').setDescription('Simulate a raid join wave and test risk scoring')))
      // Trusted users and roles subcommand group
      .addSubcommandGroup(g => g.setName('trust').setDescription('Manage trusted identities exempt from security containment')
        .addSubcommand(s => s.setName('add').setDescription('Add an authorized user or role to trusted exemptions')
          .addUserOption(o => o.setName('user').setDescription('User to trust').setRequired(false))
          .addRoleOption(o => o.setName('role').setDescription('Role to trust').setRequired(false)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove a user or role from trusted exemptions')
          .addUserOption(o => o.setName('user').setDescription('User to untrust').setRequired(false))
          .addRoleOption(o => o.setName('role').setDescription('Role to untrust').setRequired(false)))
        .addSubcommand(s => s.setName('list').setDescription('List all currently trusted users and roles')))
      // Security configuration subcommand group
      .addSubcommandGroup(g => g.setName('config').setDescription('Security engine configuration and management')
        .addSubcommand(s => s.setName('view').setDescription('View complete active security engine configuration'))
        .addSubcommand(s => s.setName('reset').setDescription('Reset all security configuration back to safe factory defaults')
          .addBooleanOption(o => o.setName('confirm').setDescription('Confirm reset to factory security defaults').setRequired(true)))),
    
    // ── AUTOMOD ──,

    new SlashCommandBuilder()
      .setName('automod')
      .setDescription('Manage AutoMod system and filters')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('enable').setDescription('Enable AutoMod engine or a specific rule')
        .addStringOption(o => o.setName('rule').setDescription('Select specific rule or select all').setRequired(false).addChoices(
          { name: '✨ Select All / Enable All Rules', value: 'all' },
          { name: 'Anti-Spam (Message Flood)', value: 'antiSpam' },
          { name: 'Duplicate Messages', value: 'antiDuplicate' },
          { name: 'Mention Spam', value: 'antiMentionSpam' },
          { name: 'Unauthorized @everyone / @here', value: 'antiEveryone' },
          { name: 'Discord Invite Links', value: 'antiInvites' },
          { name: 'External / Suspicious Links', value: 'antiLinks' },
          { name: 'NSFW / Adult Links', value: 'antiNsfwLinks' },
          { name: 'Word Blacklist', value: 'wordFilter' },
          { name: 'Caps Lock Filter', value: 'antiCaps' },
          { name: 'Emoji Spam', value: 'antiEmojiSpam' },
          { name: 'Alt Account Detection', value: 'altDetection' },
          { name: 'Anti-Raid Join Flood', value: 'antiRaid' },
        )))
      .addSubcommand(s => s.setName('disable').setDescription('Disable AutoMod engine or a specific rule')
        .addStringOption(o => o.setName('rule').setDescription('Select specific rule or select all').setRequired(false).addChoices(
          { name: '⚠️ Select All / Disable All Rules', value: 'all' },
          { name: 'Anti-Spam (Message Flood)', value: 'antiSpam' },
          { name: 'Duplicate Messages', value: 'antiDuplicate' },
          { name: 'Mention Spam', value: 'antiMentionSpam' },
          { name: 'Unauthorized @everyone / @here', value: 'antiEveryone' },
          { name: 'Discord Invite Links', value: 'antiInvites' },
          { name: 'External / Suspicious Links', value: 'antiLinks' },
          { name: 'NSFW / Adult Links', value: 'antiNsfwLinks' },
          { name: 'Word Blacklist', value: 'wordFilter' },
          { name: 'Caps Lock Filter', value: 'antiCaps' },
          { name: 'Emoji Spam', value: 'antiEmojiSpam' },
          { name: 'Alt Account Detection', value: 'altDetection' },
          { name: 'Anti-Raid Join Flood', value: 'antiRaid' },
        )))
      .addSubcommand(s => s.setName('enableall').setDescription('Enable all AutoMod rules at once'))
      .addSubcommand(s => s.setName('disableall').setDescription('Disable all AutoMod rules at once'))
      .addSubcommand(s => s.setName('status').setDescription('View AutoMod active rules'))
      .addSubcommand(s => s.setName('config').setDescription('Interactive AutoMod dashboard'))
      .addSubcommand(s => s.setName('whitelist').setDescription('Manage AutoMod exemptions')
        .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
          { name: 'Add to whitelist', value: 'add' },
          { name: 'Remove from whitelist', value: 'remove' },
          { name: 'List whitelisted', value: 'list' }
        ))
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(false))
        .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(false))
        .addChannelOption(o => o.setName('channel').setDescription('Channel to ignore').setRequired(false)))
      .addSubcommand(s => s.setName('blacklist').setDescription('Manage word blacklist')
        .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
          { name: 'Add word', value: 'add' },
          { name: 'Remove word', value: 'remove' },
          { name: 'List words', value: 'list' }
        ))
        .addStringOption(o => o.setName('word').setDescription('Word to add/remove').setRequired(false)))
      .addSubcommand(s => s.setName('test').setDescription('Test AutoMod filter evaluation'))
      .addSubcommand(s => s.setName('punishment').setDescription('Customize punishment action for AutoMod rules')
        .addStringOption(o => o.setName('rule').setDescription('AutoMod rule to configure').setRequired(true).addChoices(
          { name: 'Anti-Spam (Message Flood)', value: 'antiSpam' },
          { name: 'Duplicate Messages', value: 'antiDuplicate' },
          { name: 'Mention Spam', value: 'antiMentionSpam' },
          { name: 'Unauthorized @everyone / @here', value: 'antiEveryone' },
          { name: 'Discord Invite Links', value: 'antiInvites' },
          { name: 'External / Suspicious Links', value: 'antiLinks' },
          { name: 'NSFW / Adult Links', value: 'antiNsfwLinks' },
          { name: 'Word Blacklist', value: 'wordFilter' },
          { name: 'Caps Lock Filter', value: 'antiCaps' },
          { name: 'Emoji Spam', value: 'antiEmojiSpam' },
          { name: 'Alt Account Detection', value: 'altDetection' },
          { name: 'Anti-Raid Join Flood', value: 'antiRaid' },
          { name: '✨ Select All / Enable All Rules (Bulk Update)', value: 'all' },
        ))
        .addStringOption(o => o.setName('action').setDescription('Punishment action to apply').setRequired(true).addChoices(
          { name: '🗑️ Delete Message Only', value: 'delete' },
          { name: '⚠️ Delete + Issue Warning Strike', value: 'warn' },
          { name: '⏳ Delete + Timeout User', value: 'timeout' },
          { name: '👢 Delete + Kick User', value: 'kick' },
          { name: '🔨 Delete + Ban User', value: 'ban' },
          { name: '📝 Log Only (No Punishment)', value: 'log' },
          { name: '🟢 Enable Rule(s)', value: 'enable' },
          { name: '🔴 Disable Rule(s)', value: 'disable' },
        ))
        .addStringOption(o => o.setName('timeout_duration').setDescription('Timeout duration if action is timeout (e.g. 60s, 5m, 10m, 1h)').setRequired(false))),
    
    // ── LOGGING ──,

    new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Issue an official warning to a member')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for warning').setRequired(false)),

    new SlashCommandBuilder()
      .setName('warnings')
      .setDescription('View active warnings for a member')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)),

    new SlashCommandBuilder()
      .setName('clearwarnings')
      .setDescription('Clear all warnings for a member')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)),

    new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Timeout a member (e.g. 10m, 1h, 1d)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption(o => o.setName('duration').setDescription('Duration (e.g. 5m, 1h, 1d)').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

    new SlashCommandBuilder()
      .setName('untimeout')
      .setDescription('Remove timeout from a member')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)),

    new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a member from the server')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a user from the server')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
      .addIntegerOption(o => o.setName('delete_days').setDescription('Days of message history to delete (0-7)').setRequired(false).setMinValue(0).setMaxValue(7)),

    new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Unban a user by their User ID')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers)
      .addStringOption(o => o.setName('userid').setDescription('User ID').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

    new SlashCommandBuilder()
      .setName('softban')
      .setDescription('Ban and instantly unban to purge messages')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

    new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Bulk delete messages from the current channel')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
      .addIntegerOption(o => o.setName('amount').setDescription('Number of messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .addStringOption(o => o.setName('filter').setDescription('Filter type').setRequired(false).addChoices(
        { name: 'All messages', value: 'all' },
        { name: 'Bot messages only', value: 'bot' },
        { name: 'Messages with links', value: 'links' }
      )),

    new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('Set slowmode delay for a channel')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
      .addIntegerOption(o => o.setName('seconds').setDescription('Seconds (0 to disable, max 21600)').setRequired(true).setMinValue(0).setMaxValue(21600))
      .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false)),

    new SlashCommandBuilder()
      .setName('lock')
      .setDescription('Lock a channel to prevent member messages')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
      .addChannelOption(o => o.setName('channel').setDescription('Channel to lock (defaults to current)').setRequired(false))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

    new SlashCommandBuilder()
      .setName('unlock')
      .setDescription('Unlock a previously locked channel')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
      .addChannelOption(o => o.setName('channel').setDescription('Channel to unlock (defaults to current)').setRequired(false)),

    new SlashCommandBuilder()
      .setName('nick')
      .setDescription('Change a member nickname')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageNicknames)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption(o => o.setName('nickname').setDescription('New nickname (leave blank to reset)').setRequired(false)),

    new SlashCommandBuilder()
      .setName('modlogs')
      .setDescription('View moderation history for a member')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)),
    
    // ── SECURITY & ANTI-NUKE ──
    // ── SECURITY COMMAND SYSTEM (CANONICAL ARCHITECTURE) ──,

    new SlashCommandBuilder()
      .setName('antispam')
      .setDescription('Toggle anti-spam filter')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),

    new SlashCommandBuilder()
      .setName('antilink')
      .setDescription('Toggle anti-link filter')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),

    new SlashCommandBuilder()
      .setName('antiraid')
      .setDescription('Toggle anti-raid filter')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),

    new SlashCommandBuilder()
      .setName('altdetection')
      .setDescription('Toggle alt account detection')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
      .addIntegerOption(o => o.setName('mindays').setDescription('Minimum account age in days').setRequired(false)),

    new SlashCommandBuilder()
      .setName('wordfilter')
      .setDescription('Toggle word filter')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),

    new SlashCommandBuilder()
      .setName('lockdown')
      .setDescription('Toggle server-wide lockdown')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),

    new SlashCommandBuilder()
      .setName('whitelist')
      .setDescription('Interactive Whitelist management for Anti-Nuke & Security')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
        { name: 'remove (user or role)', value: 'remove' },
        { name: 'add (user or role)', value: 'add' },
        { name: 'manage (interactive panel)', value: 'manage' },
        { name: 'list whitelisted', value: 'list' },
        { name: 'clear all', value: 'clear' }
      ))
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(false))
      .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(false)),
    
    // ── INVITES & MUSIC ──,

    new SlashCommandBuilder()
      .setName('threat')
      .setDescription('Instantly switch server DEFCON threat level')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    new SlashCommandBuilder()
      .setName('quarantine')
      .setDescription('Anti-Raid quarantine management')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('status').setDescription('View current quarantine status'))
      .addSubcommand(s => s.setName('release').setDescription('Release all quarantined members')
        .addUserOption(o => o.setName('user').setDescription('Specific user to release (leave blank for all)').setRequired(false))),
    
    // ── 22 NEW ADVANCED SUITE COMMANDS ──
    // 8: Translate,

    new SlashCommandBuilder()
      .setName('quickmod')
      .setDescription('Launch rapid one-click interactive moderation panel')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
      .addUserOption(o => o.setName('user').setDescription('Target member to moderate').setRequired(true)),
    
    // 98: Roleplay Actions,

    new SlashCommandBuilder()
      .setName('vpncheck')
      .setDescription('Detect suspicious accounts, alts, and lookup hosting/VPN IPs')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
      .addSubcommand(s => s.setName('user').setDescription('Analyze account suspicion score, age, avatar, and risk rating')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)))
      .addSubcommand(s => s.setName('ip').setDescription('Check public IP address for datacenter, proxy or VPN flags')
        .addStringOption(o => o.setName('ip').setDescription('IPv4 or IPv6 address').setRequired(true))),
    
    // S5: Raid Mode Surgical Response,

    new SlashCommandBuilder()
      .setName('raidmode')
      .setDescription('Manual raid defense mode with rapid countermeasures')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('on').setDescription('Activate raid countermeasures')
        .addStringOption(o => o.setName('action').setDescription('Action to take (default: slowmode)').setRequired(false).addChoices(
          { name: 'Mass Channel Slowmode (15s)', value: 'slowmode' },
          { name: 'Strict Verification Level', value: 'strict_verification' },
          { name: 'Auto-Quarantine New Joins', value: 'quarantine' }
        )))
      .addSubcommand(s => s.setName('off').setDescription('Deactivate raidmode and restore previous channel states'))
      .addSubcommand(s => s.setName('status').setDescription('View current raidmode active status')),
    
    // M1: Lyrics Search,

    // =============================================================================
    // 2. SONGS & 24/7 MUSIC COMMAND GROUP
    // =============================================================================,

    new SlashCommandBuilder()
      .setName('songs')
      .setDescription('THOR APEX Music & 24/7 Voice System')
      .addSubcommandGroup(g =>
        g.setName('24-7')
          .setDescription('24/7 persistent voice connection management')
          .addSubcommand(s =>
            s.setName('enable')
              .setDescription('Enable persistent voice-channel connection for the current server')
              .addChannelOption(o => o.setName('channel').setDescription('Voice channel (defaults to current)').setRequired(false).addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice))
          )
          .addSubcommand(s =>
            s.setName('disable')
              .setDescription('Disable persistent mode and allow normal disconnect behavior')
          )
          .addSubcommand(s =>
            s.setName('status')
              .setDescription('Show 24/7 status, configured voice channel, and connection state')
          )
          .addSubcommand(s =>
            s.setName('setup')
              .setDescription('Configure designated voice channel for 24/7 persistent connection')
              .addChannelOption(o => o.setName('channel').setDescription('Designated voice channel').setRequired(true).addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice))
          )
      )
      .addSubcommandGroup(g =>
        g.setName('playback')
          .setDescription('Audio playback controls')
          .addSubcommand(s =>
            s.setName('play')
              .setDescription('Stream any song or Spotify link in voice channel')
              .addStringOption(o => o.setName('song').setDescription('Title or URL').setRequired(true))
          )
          .addSubcommand(s =>
            s.setName('pause')
              .setDescription('Pause current playback')
          )
          .addSubcommand(s =>
            s.setName('resume')
              .setDescription('Resume paused playback')
          )
          .addSubcommand(s =>
            s.setName('skip')
              .setDescription('Skip currently playing track')
          )
          .addSubcommand(s =>
            s.setName('stop')
              .setDescription('Stop playback and clear queue')
          )
          .addSubcommand(s =>
            s.setName('nowplaying')
              .setDescription('Display currently playing track info and player card')
          )
          .addSubcommand(s =>
            s.setName('previous')
              .setDescription('Replay previously played track')
          )
          .addSubcommand(s =>
            s.setName('playnow')
              .setDescription('Jump queue and stream immediately')
              .addStringOption(o => o.setName('song').setDescription('Song title or URL').setRequired(true))
          )
          .addSubcommand(s =>
            s.setName('seek')
              .setDescription('Seek to timestamp (e.g. 1:30 or 90)')
              .addStringOption(o => o.setName('time').setDescription('Time in MM:SS or seconds').setRequired(true))
          )
          .addSubcommand(s =>
            s.setName('disconnect')
              .setDescription('Disconnect bot from voice channel')
          )
      )
      .addSubcommandGroup(g =>
        g.setName('queue')
          .setDescription('Music queue management')
          .addSubcommand(s =>
            s.setName('view')
              .setDescription('View upcoming songs in queue')
              .addIntegerOption(o => o.setName('page').setDescription('Page number').setRequired(false).setMinValue(1))
          )
          .addSubcommand(s =>
            s.setName('clear')
              .setDescription('Clear all upcoming tracks from queue')
          )
          .addSubcommand(s =>
            s.setName('shuffle')
              .setDescription('Shuffle all upcoming queued tracks')
          )
          .addSubcommand(s =>
            s.setName('loop')
              .setDescription('Set loop mode')
              .addStringOption(o => o.setName('mode').setDescription('Loop mode').setRequired(true).addChoices(
                { name: 'Off', value: 'off' },
                { name: 'Track (Repeat Current Song)', value: 'track' },
                { name: 'Queue (Repeat Entire Queue)', value: 'queue' }
              ))
          )
      )
      .addSubcommandGroup(g =>
        g.setName('audio')
          .setDescription('Audio settings & diagnostics')
          .addSubcommand(s =>
            s.setName('volume')
              .setDescription('Adjust playback volume (1-100)')
              .addIntegerOption(o => o.setName('level').setDescription('Volume % (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
          )
          .addSubcommand(s =>
            s.setName('radio')
              .setDescription('Stream 24/7 internet radio genre')
              .addStringOption(o => o.setName('genre').setDescription('Radio genre').setRequired(true).addChoices(
                { name: 'Lofi Hip Hop', value: 'lofi' },
                { name: 'EDM / Dance Hits', value: 'edm' },
                { name: 'Synthwave / Chillwave', value: 'synthwave' },
                { name: 'Classical Focus', value: 'classical' },
                { name: 'Rock Classics', value: 'rock' }
              ))
          )
          .addSubcommand(s =>
            s.setName('search')
              .setDescription('Search for tracks across providers')
              .addStringOption(o => o.setName('query').setDescription('Song search term').setRequired(true))
          )
          .addSubcommand(s =>
            s.setName('status')
              .setDescription('View audio subsystem health and connection status')
          )
          .addSubcommand(s =>
            s.setName('lyrics')
              .setDescription('Find lyrics for currently playing or searched song')
              .addStringOption(o => o.setName('song').setDescription('Song title').setRequired(false))
          )
      ),

    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play a song from YouTube, Spotify, or Soundcloud')
      .addStringOption(o => o.setName('song').setDescription('Song name or URL').setRequired(true)),

    new SlashCommandBuilder()
      .setName('pause')
      .setDescription('Pause music playback'),

    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('Resume music playback'),

    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('Skip current song'),

    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop playback and leave voice channel'),

    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Manage and view the music queue')
      .addSubcommand(s => s.setName('view').setDescription('View current music queue')
        .addIntegerOption(o => o.setName('page').setDescription('Page number').setRequired(false)))
      .addSubcommand(s => s.setName('remove').setDescription('Remove a track from queue')
        .addIntegerOption(o => o.setName('position').setDescription('Track number in queue').setRequired(true).setMinValue(1)))
      .addSubcommand(s => s.setName('move').setDescription('Move a track position in queue')
        .addIntegerOption(o => o.setName('from').setDescription('Current position').setRequired(true).setMinValue(1))
        .addIntegerOption(o => o.setName('to').setDescription('New destination position').setRequired(true).setMinValue(1)))
      .addSubcommand(s => s.setName('jump').setDescription('Skip directly to a position in queue')
        .addIntegerOption(o => o.setName('position').setDescription('Track number').setRequired(true).setMinValue(1)))
      .addSubcommand(s => s.setName('export').setDescription('Export current queue playlist to text'))
      .addSubcommand(s => s.setName('clear').setDescription('Clear all upcoming tracks from queue')),

    new SlashCommandBuilder()
      .setName('nowplaying')
      .setDescription('Show currently playing track'),

    new SlashCommandBuilder()
      .setName('radio')
      .setDescription('Play 24/7 radio stream')
      .addStringOption(o => o.setName('genre').setDescription('Genre').setRequired(false).addChoices(
        { name: 'Lofi Chill', value: 'lofi' },
        { name: 'Gaming Beats', value: 'gaming' },
        { name: 'Pop Hits', value: 'pop' },
        { name: 'Chill Hop', value: 'chill' }
      )),

    new SlashCommandBuilder()
      .setName('volume')
      .setDescription('Adjust music volume')
      .addIntegerOption(o => o.setName('level').setDescription('Volume (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)),

    new SlashCommandBuilder()
      .setName('loop')
      .setDescription('Set music repeat mode')
      .addStringOption(o => o.setName('mode').setDescription('Mode').setRequired(true).addChoices(
        { name: 'Off', value: 'off' },
        { name: 'Track', value: 'track' },
        { name: 'Queue', value: 'queue' }
      )),

    new SlashCommandBuilder()
      .setName('shuffle')
      .setDescription('Shuffle the music queue'),

    new SlashCommandBuilder()
      .setName('previous')
      .setDescription('Play the previous track in history'),

    new SlashCommandBuilder()
      .setName('playnow')
      .setDescription('Play a track immediately at the front of the queue')
      .addStringOption(o => o.setName('song').setDescription('Song name, Spotify link, or audio URL').setRequired(true)),

    new SlashCommandBuilder()
      .setName('disconnect')
      .setDescription('Leave the voice channel and release player resources'),

    new SlashCommandBuilder()
      .setName('search')
      .setDescription('Search supported sources for music tracks')
      .addStringOption(o => o.setName('query').setDescription('Song title or artist to search').setRequired(true)),

    new SlashCommandBuilder()
      .setName('seek')
      .setDescription('Seek to a playback position in the current track')
      .addStringOption(o => o.setName('time').setDescription('Timestamp (e.g. 1:30 or 90s)').setRequired(true)),

    new SlashCommandBuilder()
      .setName('musicstatus')
      .setDescription('Display real-time music engine, voice connection, and queue diagnostics'),

    new SlashCommandBuilder()
      .setName('musicupdate')
      .setDescription('Owner-only music auto-update and self-healing system')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addSubcommand(s => s.setName('status').setDescription('Current music engine health and installed dependency versions'))
      .addSubcommand(s => s.setName('check').setDescription('Check NPM registry for compatible music library updates'))
      .addSubcommand(s => s.setName('logs').setDescription('View recent music playback incidents and self-healing logs'))
      .addSubcommand(s => s.setName('repair').setDescription('Safely reinitialize and repair the music subsystem'))
      .addSubcommand(s => s.setName('apply').setDescription('Review verified update status and deployment instructions')),
    
    // ── INTERACTIVE CONTROL CENTRE & DEFCON ──,

    new SlashCommandBuilder()
      .setName('lyrics')
      .setDescription('Search real-time lyrics for the current song or any track')
      .addStringOption(o => o.setName('song').setDescription('Song title to search (leave empty for current playing track)').setRequired(false)),
    
    // W2: External Integrations (No extra text channels created),

    // =============================================================================
    // 3. WELCOME COMMAND GROUP
    // =============================================================================,

    new SlashCommandBuilder()
      .setName('welcome')
      .setDescription('Manage high-conversion Welcome cards')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('setup').setDescription('Set welcome channel')
        .addChannelOption(o => o.setName('channel').setDescription('Welcome channel').setRequired(true)))
      .addSubcommand(s => s.setName('config').setDescription('View current welcome card settings'))
      .addSubcommand(s => s.setName('test').setDescription('Preview welcome card & run permission diagnostic'))
      .addSubcommand(s => s.setName('enable').setDescription('Enable welcome messages'))
      .addSubcommand(s => s.setName('disable').setDescription('Disable welcome messages'))
      .addSubcommand(s => s.setName('banner').setDescription('Set or sync welcome banner image')
        .addAttachmentOption(o => o.setName('image').setDescription('Upload banner image file').setRequired(false))
        .addStringOption(o => o.setName('url').setDescription('Or paste banner image URL (or "server" / "reset")').setRequired(false))),

    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Auto-setup bot channels and configuration')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

    new SlashCommandBuilder()
      .setName('setwelcome')
      .setDescription('Set welcome channel')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(false)),

    new SlashCommandBuilder()
      .setName('setrules')
      .setDescription('Set rules channel for welcome card')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setroles')
      .setDescription('Set self-roles channel for welcome card')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setgeneral')
      .setDescription('Set main chat channel for welcome card')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setfun')
      .setDescription('Set fun channel for welcome card')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setedit')
      .setDescription('Set editing channel for welcome card')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setgaming')
      .setDescription('Set gaming channel for welcome card')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setwelcomecolor')
      .setDescription('Set welcome embed color (hex e.g. #FF0000)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(o => o.setName('color').setDescription('Hex color code e.g. #FF0000').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setwelcometext')
      .setDescription('Customize welcome text fields')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(o => o.setName('greeting').setDescription('Greeting prefix').setRequired(false))
      .addStringOption(o => o.setName('subtitle').setDescription('Welcome subtitle').setRequired(false))
      .addStringOption(o => o.setName('outro').setDescription('Closing line').setRequired(false)),

    new SlashCommandBuilder()
      .setName('setbanner')
      .setDescription('Set or sync welcome banner image (upload file, paste URL, or use server banner)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addAttachmentOption(o => o.setName('image').setDescription('Upload banner image file').setRequired(false))
      .addStringOption(o => o.setName('url').setDescription('Or paste banner image URL (or "server" / "reset")').setRequired(false)),

    new SlashCommandBuilder()
      .setName('setlogo')
      .setDescription('Set or sync welcome card logo/icon (upload file, paste URL, or use server icon)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addAttachmentOption(o => o.setName('image').setDescription('Upload logo image file').setRequired(false))
      .addStringOption(o => o.setName('url').setDescription('Or paste logo image URL (or "server" / "reset")').setRequired(false)),

    new SlashCommandBuilder()
      .setName('serverbanner')
      .setDescription('Display server banner and optionally apply it to welcome card')
      .addBooleanOption(o => o.setName('apply_welcome').setDescription('Apply as welcome card banner?').setRequired(false)),

    new SlashCommandBuilder()
      .setName('setautorole')
      .setDescription('Set auto-role assigned upon joining')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),

    // =============================================================================
    // 4. LEFT COMMAND GROUP
    // =============================================================================,

    new SlashCommandBuilder()
      .setName('left')
      .setDescription('Manage Member Leave and Goodbye Announcements')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s =>
        s.setName('setup')
          .setDescription('Set channel for leave / goodbye announcements')
          .addChannelOption(o => o.setName('channel').setDescription('Leave channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
      )
      .addSubcommand(s =>
        s.setName('config')
          .setDescription('View current goodbye message settings')
      )
      .addSubcommand(s =>
        s.setName('test')
          .setDescription('Preview leave message & check permissions')
      )
      .addSubcommand(s =>
        s.setName('enable')
          .setDescription('Enable leave / goodbye announcements')
      )
      .addSubcommand(s =>
        s.setName('disable')
          .setDescription('Disable leave / goodbye announcements')
      )
      .addSubcommand(s =>
        s.setName('message')
          .setDescription('Customize goodbye text (use {username}, {tag}, {membercount})')
          .addStringOption(o => o.setName('text').setDescription('Goodbye message template').setRequired(true))
      ),

    new SlashCommandBuilder()
      .setName('goodbye')
      .setDescription('Manage departure and leave messages')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('setup').setDescription('Set goodbye channel')
        .addChannelOption(o => o.setName('channel').setDescription('Goodbye channel').setRequired(true)))
      .addSubcommand(s => s.setName('config').setDescription('View current goodbye message settings'))
      .addSubcommand(s => s.setName('test').setDescription('Preview goodbye message'))
      .addSubcommand(s => s.setName('enable').setDescription('Enable goodbye messages'))
      .addSubcommand(s => s.setName('disable').setDescription('Disable goodbye messages')),
    
    // ── UTILITY ──,

    new SlashCommandBuilder()
      .setName('setleave')
      .setDescription('Set leave/goodbye channel')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setleavetext')
      .setDescription('Customize leave message')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(o => o.setName('message').setDescription('Use {username} {user} {membercount}').setRequired(true)),

    // =============================================================================
    // 5. LOGS COMMAND GROUP
    // =============================================================================,

    new SlashCommandBuilder()
      .setName('logs')
      .setDescription('Configure 15 dedicated log channels under SERVER LOGS category')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('setup').setDescription('Auto-create category and 15 separate log channels'))
      .addSubcommand(s => s.setName('status').setDescription('View all 15 log channel destinations'))
      .addSubcommand(s => s.setName('configure').setDescription('Set channel for a specific log category')
        .addStringOption(o => o.setName('category').setDescription('Log category').setRequired(true).addChoices(
          { name: 'Member Logs (#member-logs)', value: 'member' },
          { name: 'Message Logs (#message-logs)', value: 'message' },
          { name: 'Moderation Logs (#moderation-logs)', value: 'moderation' },
          { name: 'Security Logs (#security-logs)', value: 'security' },
          { name: 'Anti-Nuke Logs (#anti-nuke-logs)', value: 'antiNuke' },
          { name: 'AutoMod Logs (#automod-logs)', value: 'automod' },
          { name: 'Role Logs (#role-logs)', value: 'role' },
          { name: 'Channel Logs (#channel-logs)', value: 'channel' },
          { name: 'Voice Logs (#voice-logs)', value: 'voice' },
          { name: 'Server Settings (#server-settings-logs)', value: 'serverSettings' },
          { name: 'Invite Logs (#invite-logs)', value: 'invite' },
          { name: 'Webhook Logs (#webhook-logs)', value: 'webhook' },
          { name: 'Bot Logs (#bot-logs)', value: 'bot' },
          { name: 'Welcome Logs (#welcome-logs)', value: 'welcome' },
          { name: 'Drag Logs (#drag-logs)', value: 'drag' }
        ))
        .addChannelOption(o => o.setName('channel').setDescription('Target text channel').setRequired(true)))
      .addSubcommand(s => s.setName('test').setDescription('Send test embeds to all configured log channels'))
      .addSubcommand(s => s.setName('disable').setDescription('Disable logging for a category')
        .addStringOption(o => o.setName('category').setDescription('Category').setRequired(true).addChoices(
          { name: 'All Log Channels', value: 'all' },
          { name: 'Member Logs', value: 'member' },
          { name: 'Message Logs', value: 'message' },
          { name: 'Voice Logs', value: 'voice' },
          { name: 'Drag Logs', value: 'drag' }
        ))),
    
    // ── WELCOME & GOODBYE ──,

    // =============================================================================
    // 6. INV COMMAND GROUP
    // =============================================================================,

    new SlashCommandBuilder()
      .setName('inv')
      .setDescription('Server Invite Tracking and Leaderboards')
      .addSubcommand(s =>
        s.setName('check')
          .setDescription('Check invite statistics for a member')
          .addUserOption(o => o.setName('user').setDescription('Target user (defaults to you)').setRequired(false))
      )
      .addSubcommand(s =>
        s.setName('leaderboard')
          .setDescription('View server top inviter leaderboard')
      )
      .addSubcommand(s =>
        s.setName('me')
          .setDescription('View your own invite statistics')
      ),

    new SlashCommandBuilder()
      .setName('myinvites')
      .setDescription('Check your total server invites'),

    new SlashCommandBuilder()
      .setName('invites')
      .setDescription('Check server invites for a user')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(false)),

    new SlashCommandBuilder()
      .setName('invitetop')
      .setDescription('Top inviters leaderboard'),

    // =============================================================================
    // 7. GAMES COMMAND GROUP
    // =============================================================================,

    new SlashCommandBuilder()
      .setName('games')
      .setDescription('Interactive games, fun, and economy points')
      .addSubcommand(s =>
        s.setName('coinflip')
          .setDescription('Flip a coin (Heads or Tails)')
      )
      .addSubcommand(s =>
        s.setName('dice')
          .setDescription('Roll a die (default 6-sided)')
          .addIntegerOption(o => o.setName('sides').setDescription('Number of sides (2-100)').setRequired(false).setMinValue(2).setMaxValue(100))
      )
      .addSubcommand(s =>
        s.setName('8ball')
          .setDescription('Ask the Magic 8-Ball a question')
          .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true))
      )
      .addSubcommand(s =>
        s.setName('rps')
          .setDescription('Play Rock, Paper, Scissors')
          .addStringOption(o => o.setName('choice').setDescription('Your choice').setRequired(true).addChoices(
            { name: 'Rock', value: 'rock' },
            { name: 'Paper', value: 'paper' },
            { name: 'Scissors', value: 'scissors' }
          ))
      )
      .addSubcommand(s =>
        s.setName('points')
          .setDescription('Check economy points balance')
          .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false))
      )
      .addSubcommand(s =>
        s.setName('leaderboard')
          .setDescription('View top economy points leaderboard')
      ),

    new SlashCommandBuilder()
      .setName('fun')
      .setDescription('Fun minigames and entertainment pack')
      .addSubcommand(s => s.setName('coinflip').setDescription('Flip a fair coin (Heads or Tails)'))
      .addSubcommand(s => s.setName('dice').setDescription('Roll dice')
        .addIntegerOption(o => o.setName('sides').setDescription('Number of dice sides (default: 6)').setRequired(false).setMinValue(2).setMaxValue(1000)))
      .addSubcommand(s => s.setName('8ball').setDescription('Ask the Magic 8-Ball a question')
        .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true)))
      .addSubcommand(s => s.setName('rps').setDescription('Play Rock, Paper, Scissors')
        .addStringOption(o => o.setName('choice').setDescription('Your play').setRequired(true).addChoices(
          { name: 'Rock 🪨', value: 'rock' },
          { name: 'Paper 📄', value: 'paper' },
          { name: 'Scissors ✂️', value: 'scissors' }
        ))),
    
    // 60: Points Economy,

    new SlashCommandBuilder()
      .setName('points')
      .setDescription('Server points and economy system')
      .addSubcommand(s => s.setName('check').setDescription('Check points balance')
        .addUserOption(o => o.setName('user').setDescription('Target user (defaults to yourself)').setRequired(false)))
      .addSubcommand(s => s.setName('give').setDescription('Award points to a member')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Amount of points').setRequired(true).setMinValue(1)))
      .addSubcommand(s => s.setName('take').setDescription('Deduct points from a member')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Amount of points').setRequired(true).setMinValue(1)))
      .addSubcommand(s => s.setName('leaderboard').setDescription('View top 10 members with highest points'))
      .addSubcommand(s => s.setName('reset').setDescription('Reset points for a user or entire server')
        .addUserOption(o => o.setName('user').setDescription('User to reset (leave blank for all)').setRequired(false))),
    
    // 79: Serverconfig Master Dashboard,

    // =============================================================================
    // GENERAL UTILITIES & ADVANCED TOOLS
    // =============================================================================,

    new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check bot heartbeat latency and gateway ping'),

    new SlashCommandBuilder()
      .setName('uptime')
      .setDescription('Check bot continuous running time and process health'),

    new SlashCommandBuilder()
      .setName('botinfo')
      .setDescription('View bot statistics, node runtime, memory, and architecture'),

    new SlashCommandBuilder()
      .setName('serverinfo')
      .setDescription('View server statistics, security level, and member counts'),

    new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('View member profile, roles, creation date, and join position')
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false)),

    new SlashCommandBuilder()
      .setName('permissions')
      .setDescription('Inspect bot and member permissions in the current channel')
      .addUserOption(o => o.setName('user').setDescription('Target user (defaults to you)').setRequired(false)),

    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Display comprehensive guide to all bot commands'),
    
    // ── LEGACY & SHORTCUT COMMANDS PRESERVED ──,

    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Open the THOR APEX interactive admin control centre')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    new SlashCommandBuilder()
      .setName('translate')
      .setDescription('Translate text into another language')
      .addStringOption(o => o.setName('text').setDescription('The text to translate').setRequired(true))
      .addStringOption(o => o.setName('to').setDescription('Target language code (e.g. es, fr, de, hi, ja, it, ru, zh)').setRequired(true))
      .addStringOption(o => o.setName('from').setDescription('Source language code (default: auto)').setRequired(false)),
    
    // 13: Appeal,

    new SlashCommandBuilder()
      .setName('appeal')
      .setDescription('Unban and punishment appeal system')
      .addSubcommand(s => s.setName('submit').setDescription('Submit an unban or punishment appeal')
        .addStringOption(o => o.setName('reason').setDescription('Why should your punishment be revoked?').setRequired(true))
        .addStringOption(o => o.setName('details').setDescription('Additional context or evidence').setRequired(false)))
      .addSubcommand(s => s.setName('status').setDescription('Check current appeal status')
        .addUserOption(o => o.setName('user').setDescription('Target user to check appeal for (defaults to yourself)').setRequired(false)))
      .addSubcommand(s => s.setName('review').setDescription('Staff decision on an appeal')
        .addUserOption(o => o.setName('user').setDescription('User whose appeal to review').setRequired(true))
        .addStringOption(o => o.setName('decision').setDescription('Approve or Reject the appeal').setRequired(true).addChoices(
          { name: 'Approve', value: 'approve' },
          { name: 'Reject', value: 'reject' }
        ))
        .addStringOption(o => o.setName('reason').setDescription('Decision note').setRequired(false)))
      .addSubcommand(s => s.setName('setup').setDescription('Configure appeal notifications channel')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to receive appeals').setRequired(true))),
    
    // 17: Server Stat Voice Channels (Voice channels only, NO text channels),

    new SlashCommandBuilder()
      .setName('serverstat')
      .setDescription('Configure server voice stat channels (voice only, no text channels created)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('setup').setDescription('Setup voice stat counter channels')
        .addChannelOption(o => o.setName('category').setDescription('Category to place voice stat channels in').setRequired(false)))
      .addSubcommand(s => s.setName('update').setDescription('Refresh voice stat counters now'))
      .addSubcommand(s => s.setName('disable').setDescription('Disable and remove voice stat channels')),
    
    // 18: AFK System,

    new SlashCommandBuilder()
      .setName('afk')
      .setDescription('Set or check your AFK status')
      .addSubcommand(s => s.setName('set').setDescription('Set your AFK status')
        .addStringOption(o => o.setName('message').setDescription('Reason for going AFK').setRequired(false)))
      .addSubcommand(s => s.setName('clear').setDescription('Clear your AFK status'))
      .addSubcommand(s => s.setName('status').setDescription('Check a member\'s AFK status')
        .addUserOption(o => o.setName('user').setDescription('User to check (defaults to yourself)').setRequired(false))),
    
    // 31: Member Badges,

    new SlashCommandBuilder()
      .setName('badge')
      .setDescription('Manage custom member recognition badges')
      .addSubcommand(s => s.setName('give').setDescription('Award a badge to a member')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addStringOption(o => o.setName('badge').setDescription('Badge icon or emoji (e.g. 🏆, ⭐, 🛡️, 💎)').setRequired(true))
        .addStringOption(o => o.setName('name').setDescription('Badge title or reason').setRequired(false)))
      .addSubcommand(s => s.setName('remove').setDescription('Remove a badge from a member')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addStringOption(o => o.setName('badge').setDescription('Badge icon/name to remove').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('View badges of a member')
        .addUserOption(o => o.setName('user').setDescription('Target user (defaults to yourself)').setRequired(false))),
    
    // 39: Staff DM Dispatcher,

    new SlashCommandBuilder()
      .setName('dm')
      .setDescription('Staff direct message dispatcher')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('user').setDescription('Send an official staff direct message to a user')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true)))
      .addSubcommand(s => s.setName('role').setDescription('Send an official direct message to members of a role')
        .addRoleOption(o => o.setName('role').setDescription('Target role').setRequired(true))
        .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true))),
    
    // 45: Nightmode Quiet Hours,

    new SlashCommandBuilder()
      .setName('nightmode')
      .setDescription('Scheduled server quiet hours')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('setup').setDescription('Configure nightmode quiet hours')
        .addStringOption(o => o.setName('start_time').setDescription('Start time (HH:MM in 24h format, e.g. 23:00)').setRequired(true))
        .addStringOption(o => o.setName('end_time').setDescription('End time (HH:MM in 24h format, e.g. 07:00)').setRequired(true))
        .addIntegerOption(o => o.setName('slowmode').setDescription('Slowmode seconds during nightmode (e.g. 30)').setRequired(false)))
      .addSubcommand(s => s.setName('toggle').setDescription('Enable or disable nightmode schedule')
        .addBooleanOption(o => o.setName('enabled').setDescription('Toggle state').setRequired(true)))
      .addSubcommand(s => s.setName('status').setDescription('View current nightmode configuration')),
    
    // 46: Devmode Diagnostics,

    new SlashCommandBuilder()
      .setName('devmode')
      .setDescription('Bot performance diagnostics and health monitoring')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('stats').setDescription('Display CPU, memory, uptime, latency and cache metrics'))
      .addSubcommand(s => s.setName('diagnostics').setDescription('Run system integrity and bot permission verification'))
      .addSubcommand(s => s.setName('simulate').setDescription('Simulate security and event workflows safely')
        .addStringOption(o => o.setName('event').setDescription('Event to simulate').setRequired(true).addChoices(
          { name: 'Member Join', value: 'join' },
          { name: 'Phishing Attack', value: 'phish' },
          { name: 'Spam Burst', value: 'spam' }
        ))),
    
    // 55: Fun Minigames,

    new SlashCommandBuilder()
      .setName('serverconfig')
      .setDescription('Master server configuration overview and management')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('view').setDescription('Comprehensive dashboard overview of all active modules'))
      .addSubcommand(s => s.setName('export').setDescription('Export current server settings as clean JSON snippet'))
      .addSubcommand(s => s.setName('reset').setDescription('Reset specific module configuration to factory defaults')
        .addStringOption(o => o.setName('module').setDescription('Module to reset').setRequired(true).addChoices(
          { name: 'All Modules', value: 'all' },
          { name: 'AutoMod', value: 'automod' },
          { name: 'Anti-Nuke / Security', value: 'security' },
          { name: 'Welcome', value: 'welcome' },
          { name: 'Goodbye', value: 'goodbye' },
          { name: 'Logs', value: 'logs' }
        ))),
    
    // 88: Birthday Tracker,

    new SlashCommandBuilder()
      .setName('birthday')
      .setDescription('Member birthday tracker and celebration')
      .addSubcommand(s => s.setName('set').setDescription('Set your birthday')
        .addIntegerOption(o => o.setName('month').setDescription('Month (1-12)').setRequired(true).setMinValue(1).setMaxValue(12))
        .addIntegerOption(o => o.setName('day').setDescription('Day (1-31)').setRequired(true).setMinValue(1).setMaxValue(31)))
      .addSubcommand(s => s.setName('check').setDescription('Check a member\'s birthday')
        .addUserOption(o => o.setName('user').setDescription('Target user (defaults to yourself)').setRequired(false)))
      .addSubcommand(s => s.setName('upcoming').setDescription('View upcoming birthdays in the next 30 days'))
      .addSubcommand(s => s.setName('channel').setDescription('Set birthday announcement channel')
        .addChannelOption(o => o.setName('channel').setDescription('Announcement channel').setRequired(true))),
    
    // 89: Maintenance Mode,

    new SlashCommandBuilder()
      .setName('maintenance')
      .setDescription('Toggle server bot maintenance mode')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('enable').setDescription('Enable maintenance mode')
        .addStringOption(o => o.setName('reason').setDescription('Maintenance explanation').setRequired(false)))
      .addSubcommand(s => s.setName('disable').setDescription('Disable maintenance mode'))
      .addSubcommand(s => s.setName('status').setDescription('Check current maintenance mode status')),
    
    // 91: Server Clone / Export / Import,

    new SlashCommandBuilder()
      .setName('clone')
      .setDescription('Export or import configuration template between servers')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addSubcommand(s => s.setName('export').setDescription('Export server configuration as a portable template token'))
      .addSubcommand(s => s.setName('import').setDescription('Import configuration template into this server')
        .addStringOption(o => o.setName('data').setDescription('Paste template token / data string').setRequired(true))),
    
    // 93: Module Toggles,

    new SlashCommandBuilder()
      .setName('module')
      .setDescription('Toggle server bot feature modules on or off')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('enable').setDescription('Enable a specific feature module')
        .addStringOption(o => o.setName('name').setDescription('Module name').setRequired(true).addChoices(
          { name: 'AutoMod', value: 'automod' },
          { name: 'Security & Anti-Nuke', value: 'security' },
          { name: 'Music', value: 'music' },
          { name: 'Welcome', value: 'welcome' },
          { name: 'Logging', value: 'logging' },
          { name: 'Economy / Points', value: 'economy' },
          { name: 'Birthday Tracker', value: 'birthday' },
          { name: 'Integrations', value: 'integrations' }
        )))
      .addSubcommand(s => s.setName('disable').setDescription('Disable a specific feature module')
        .addStringOption(o => o.setName('name').setDescription('Module name').setRequired(true).addChoices(
          { name: 'AutoMod', value: 'automod' },
          { name: 'Security & Anti-Nuke', value: 'security' },
          { name: 'Music', value: 'music' },
          { name: 'Welcome', value: 'welcome' },
          { name: 'Logging', value: 'logging' },
          { name: 'Economy / Points', value: 'economy' },
          { name: 'Birthday Tracker', value: 'birthday' },
          { name: 'Integrations', value: 'integrations' }
        )))
      .addSubcommand(s => s.setName('list').setDescription('Display status of all modules')),
    
    // 94: QuickMod Rapid Panel,

    new SlashCommandBuilder()
      .setName('roleplay')
      .setDescription('Expressive roleplay and anime action interactions')
      .addSubcommand(s => s.setName('hug').setDescription('Give a member a warm hug')
        .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true)))
      .addSubcommand(s => s.setName('pat').setDescription('Gently pat a member on the head')
        .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true)))
      .addSubcommand(s => s.setName('slap').setDescription('Playfully or dramatically slap a member')
        .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true)))
      .addSubcommand(s => s.setName('highfive').setDescription('High five a member')
        .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true)))
      .addSubcommand(s => s.setName('wave').setDescription('Wave friendly hello to a member')
        .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true))),
    
    // S1: VPN & Account Suspicion Checker,

    new SlashCommandBuilder()
      .setName('integration')
      .setDescription('Connect YouTube, Twitch, and GitHub alerts (no extra text channels created)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(s => s.setName('youtube').setDescription('Add YouTube channel upload alerts')
        .addStringOption(o => o.setName('channel_id').setDescription('YouTube Channel ID (e.g. UC...)').setRequired(true))
        .addChannelOption(o => o.setName('alert_channel').setDescription('Existing text channel for alerts').setRequired(true)))
      .addSubcommand(s => s.setName('twitch').setDescription('Add Twitch stream live alerts')
        .addStringOption(o => o.setName('streamer').setDescription('Twitch streamer name').setRequired(true))
        .addChannelOption(o => o.setName('alert_channel').setDescription('Existing text channel for alerts').setRequired(true)))
      .addSubcommand(s => s.setName('github').setDescription('Add GitHub repository release/commit alerts')
        .addStringOption(o => o.setName('repo').setDescription('GitHub repository (e.g. owner/repo)').setRequired(true))
        .addChannelOption(o => o.setName('alert_channel').setDescription('Existing text channel for alerts').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List active external integrations'))
      .addSubcommand(s => s.setName('remove').setDescription('Remove an external integration')
        .addStringOption(o => o.setName('type').setDescription('Integration type').setRequired(true).addChoices(
          { name: 'YouTube', value: 'youtube' },
          { name: 'Twitch', value: 'twitch' },
          { name: 'GitHub', value: 'github' }
        ))
        .addStringOption(o => o.setName('id').setDescription('Channel ID, streamer, or repo name to remove').setRequired(true)))
  ];

  return commands;
}

module.exports = {
  buildApplicationCommands,
  validateCommandPayload,
};
