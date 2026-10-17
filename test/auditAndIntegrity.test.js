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
