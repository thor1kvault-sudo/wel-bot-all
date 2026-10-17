'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildApplicationCommands, validateCommandPayload } = require('../src/commands/commandRegistry');
const { dispatchCommand } = require('../src/commands/commandDispatcher');
const { STATIC_HELP_CATEGORIES } = require('../src/commands/helpData');

test('AUDIT-1: Zero duplicate top-level application commands in registry', () => {
  const commands = buildApplicationCommands().map(c => typeof c.toJSON === 'function' ? c.toJSON() : c);
  const names = commands.map(c => c.name);
  const counts = {};
  for (const n of names) {
    counts[n] = (counts[n] || 0) + 1;
  }
  const duplicates = Object.entries(counts).filter(([, c]) => c > 1);
  assert.equal(duplicates.length, 0, `Duplicate top-level commands found: ${JSON.stringify(duplicates)}`);
  assert.equal(commands.length, 100, 'Must have exactly 100 commands to meet Discord global limit');
});

test('AUDIT-2: Registry-to-handler consistency — every command has an active handler in dispatcher', () => {
  const commands = buildApplicationCommands().map(c => typeof c.toJSON === 'function' ? c.toJSON() : c);
  const dispatcherSrc = fs.readFileSync(path.join(__dirname, '../src/commands/commandDispatcher.js'), 'utf8');

  const unhandled = [];
  for (const cmd of commands) {
    const pattern = new RegExp(`commandName === ['"]${cmd.name}['"]`);
    if (!pattern.test(dispatcherSrc)) {
      unhandled.push(cmd.name);
    }
  }

  assert.equal(unhandled.length, 0, `Commands missing dispatch handlers: ${unhandled.join(', ')}`);
});

test('AUDIT-3: All command and subcommand descriptions are non-empty and conform to Discord character limits', () => {
  const commands = buildApplicationCommands().map(c => typeof c.toJSON === 'function' ? c.toJSON() : c);

  for (const cmd of commands) {
    assert.ok(cmd.description && cmd.description.length >= 2, `Command /${cmd.name} has invalid description`);
    assert.ok(cmd.description.length <= 100, `Command /${cmd.name} description exceeds 100 characters`);

    if (cmd.options) {
      for (const opt of cmd.options) {
        assert.ok(opt.description && opt.description.length >= 2, `Option /${cmd.name} ${opt.name} has invalid description`);
        assert.ok(opt.description.length <= 100, `Option /${cmd.name} ${opt.name} description exceeds 100 characters`);

        if (opt.options) {
          for (const sub of opt.options) {
            assert.ok(sub.description && sub.description.length >= 2, `Nested option /${cmd.name} ${opt.name} ${sub.name} has invalid description`);
            assert.ok(sub.description.length <= 100, `Nested option /${cmd.name} ${opt.name} ${sub.name} description exceeds 100 characters`);
          }
        }
      }
    }
  }
});

test('AUDIT-4: Help categories in helpData are complete and match supported bot systems', () => {
  const expectedCategories = [
    'overview', 'moderation', 'security', 'automod',
    'logs', 'welcome', 'music', 'utility', 'fun',
    'economy', 'integrations', 'admin', 'advanced'
  ];

  for (const cat of expectedCategories) {
    assert.ok(STATIC_HELP_CATEGORIES[cat], `Help category "${cat}" must exist in STATIC_HELP_CATEGORIES`);
    assert.ok(STATIC_HELP_CATEGORIES[cat].title, `Category "${cat}" must have a title`);
    assert.ok(STATIC_HELP_CATEGORIES[cat].description, `Category "${cat}" must have a description`);
  }
});

test('AUDIT-5: Full payload passes Discord API v10 validation with 0 errors', () => {
  const commands = buildApplicationCommands().map(c => typeof c.toJSON === 'function' ? c.toJSON() : c);
  const result = validateCommandPayload(commands);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('AUDIT-6: Zero duplicate subcommands or subcommand groups within any command', () => {
  const commands = buildApplicationCommands().map(c => typeof c.toJSON === 'function' ? c.toJSON() : c);

  for (const cmd of commands) {
    if (!cmd.options) continue;
    const subNames = [];
    for (const opt of cmd.options) {
      if (opt.type === 1 || opt.type === 2) {
        subNames.push(opt.name);
      }
      if (opt.type === 2 && opt.options) {
        const nestedNames = [];
        for (const nested of opt.options) {
          if (nested.type === 1) {
            nestedNames.push(nested.name);
          }
        }
        const nestedDupes = nestedNames.filter((item, index) => nestedNames.indexOf(item) !== index);
        assert.equal(nestedDupes.length, 0, `Duplicate nested subcommands in /${cmd.name} ${opt.name}: ${nestedDupes.join(', ')}`);
      }
    }
    const dupes = subNames.filter((item, index) => subNames.indexOf(item) !== index);
    assert.equal(dupes.length, 0, `Duplicate subcommands in /${cmd.name}: ${dupes.join(', ')}`);
  }
});

test('AUDIT-7: Canonical registration scope — deploy and index guarantee zero guild-scoped duplicate registration', () => {
  const deploySrc = fs.readFileSync(path.join(__dirname, '../deploy.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

  // Must use applicationCommands (global) as primary
  assert.ok(deploySrc.includes('Routes.applicationCommands(user.id)'), 'deploy.js must register global commands');
  assert.ok(indexSrc.includes('Routes.applicationCommands(client.user.id)'), 'index.js must register global commands');

  // Must actively purge guild commands with empty body to prevent duplicate UI entries
  assert.ok(deploySrc.includes('Routes.applicationGuildCommands(user.id, g.id), { body: [] }'), 'deploy.js must purge guild-scoped commands');
  assert.ok(indexSrc.includes('Routes.applicationGuildCommands(client.user.id, g.id), { body: [] }'), 'index.js must purge guild-scoped commands on ready');

  // Must NOT deploy full payload to guilds across all connected guilds
  assert.ok(!deploySrc.includes('Routes.applicationGuildCommands(user.id, g.id), { body: payload }'), 'deploy.js must not push payload to all guilds');
});

test('AUDIT-8: Idempotent payload generation — repeated calls produce identical deterministic payloads', () => {
  const firstRun = buildApplicationCommands().map(c => typeof c.toJSON === 'function' ? c.toJSON() : c);
  const secondRun = buildApplicationCommands().map(c => typeof c.toJSON === 'function' ? c.toJSON() : c);

  assert.equal(firstRun.length, secondRun.length);
  assert.equal(JSON.stringify(firstRun), JSON.stringify(secondRun));
});

test('AUDIT-9: Dispatcher single-handler execution integrity — no double-reply or unhandled commands', () => {
  const commands = buildApplicationCommands().map(c => typeof c.toJSON === 'function' ? c.toJSON() : c);
  const dispatcherSrc = fs.readFileSync(path.join(__dirname, '../src/commands/commandDispatcher.js'), 'utf8');

  for (const cmd of commands) {
    const regex = new RegExp(`commandName === ['"]${cmd.name}['"]`, 'g');
    const matches = dispatcherSrc.match(regex);
    assert.ok(matches && matches.length === 1, `Command /${cmd.name} must appear in exactly one dispatch condition in dispatcher, found: ${matches?.length || 0}`);
  }
});
