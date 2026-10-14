/**
 * payloadValidator.js — Validates Discord Application Slash Command Payloads
 * against official Discord API v10 rules before deployment.
 */

const NAME_REGEX = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

function validateCommandPayload(commands) {
  const errors = [];

  if (!Array.isArray(commands)) {
    return { valid: false, errors: ['Commands payload must be an array'] };
  }

  if (commands.length > 100) {
    errors.push(`Total commands (${commands.length}) exceeds Discord limit of 100 application commands.`);
  }

  const commandNames = new Set();

  for (const rawCmd of commands) {
    const cmd = typeof rawCmd.toJSON === 'function' ? rawCmd.toJSON() : rawCmd;
    const cmdName = cmd.name;

    // 1. Name check
    if (!cmdName || typeof cmdName !== 'string') {
      errors.push(`Command missing required name: ${JSON.stringify(cmd)}`);
      continue;
    }

    if (commandNames.has(cmdName)) {
      errors.push(`Duplicate top-level command name: "${cmdName}"`);
    }
    commandNames.add(cmdName);

    if (cmdName !== cmdName.toLowerCase()) {
      errors.push(`Command "/${cmdName}" name must be entirely lowercase.`);
    }

    if (!NAME_REGEX.test(cmdName)) {
      errors.push(`Command "/${cmdName}" name does not match Discord name rules (1-32 alphanumeric/hyphen/underscore).`);
    }

    // 2. Description check
    if (!cmd.description || typeof cmd.description !== 'string' || cmd.description.length < 1 || cmd.description.length > 100) {
      errors.push(`Command "/${cmdName}" description must be between 1 and 100 characters.`);
    }

    // 3. Options validation
    if (cmd.options && Array.isArray(cmd.options)) {
      if (cmd.options.length > 25) {
        errors.push(`Command "/${cmdName}" has ${cmd.options.length} options (Discord limit: 25).`);
      }

      const hasSubcommandsOrGroups = cmd.options.some(o => o.type === 1 || o.type === 2);
      const hasArgumentOptions = cmd.options.some(o => o.type >= 3);

      if (hasSubcommandsOrGroups && hasArgumentOptions) {
        errors.push(`Command "/${cmdName}" mixes argument options with subcommands or subcommand groups.`);
      }

      validateOptionsList(cmd.options, `/${cmdName}`, errors, 1);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    commandCount: commands.length,
  };
}

function validateOptionsList(options, path, errors, depth) {
  const optionNames = new Set();
  let seenOptional = false;

  for (const opt of options) {
    const optName = opt.name;

    if (!optName || typeof optName !== 'string') {
      errors.push(`${path}: Option missing name`);
      continue;
    }

    if (optionNames.has(optName)) {
      errors.push(`${path}: Duplicate option name "${optName}"`);
    }
    optionNames.add(optName);

    if (optName !== optName.toLowerCase()) {
      errors.push(`${path} option "${optName}" name must be lowercase.`);
    }

    if (!NAME_REGEX.test(optName)) {
      errors.push(`${path} option "${optName}" name violates regex format.`);
    }

    if (!opt.description || typeof opt.description !== 'string' || opt.description.length < 1 || opt.description.length > 100) {
      errors.push(`${path} option "${optName}" description must be between 1 and 100 characters.`);
    }

    // Required before optional ordering rule (only applies to argument options, not subcommands)
    if (opt.type >= 3) {
      if (opt.required === true) {
        if (seenOptional) {
          errors.push(`${path}: Required option "${optName}" appears after an optional option.`);
        }
      } else {
        seenOptional = true;
      }
    }

    // Subcommand Group (type 2) checks
    if (opt.type === 2) {
      if (depth > 1) {
        errors.push(`${path} group "${optName}": Subcommand groups cannot be nested inside other groups.`);
      }
      if (!opt.options || !Array.isArray(opt.options) || opt.options.length === 0) {
        errors.push(`${path} group "${optName}" must contain at least one subcommand.`);
      } else {
        const invalidChildren = opt.options.filter(c => c.type !== 1);
        if (invalidChildren.length > 0) {
          errors.push(`${path} group "${optName}" can only contain subcommands (type 1).`);
        }
        validateOptionsList(opt.options, `${path} ${optName}`, errors, depth + 1);
      }
    }

    // Subcommand (type 1) checks
    if (opt.type === 1) {
      if (opt.options && Array.isArray(opt.options)) {
        if (opt.options.length > 25) {
          errors.push(`${path} ${optName} has ${opt.options.length} options (max 25).`);
        }
        const nestedSubs = opt.options.filter(c => c.type === 1 || c.type === 2);
        if (nestedSubs.length > 0) {
          errors.push(`${path} ${optName}: Subcommands cannot contain nested subcommands or groups.`);
        }
        validateOptionsList(opt.options, `${path} ${optName}`, errors, depth + 1);
      }
    }

    // Choices check
    if (opt.choices && Array.isArray(opt.choices)) {
      if (opt.choices.length > 25) {
        errors.push(`${path} option "${optName}" has ${opt.choices.length} choices (max 25).`);
      }
      for (const ch of opt.choices) {
        if (!ch.name || ch.name.length < 1 || ch.name.length > 100) {
          errors.push(`${path} option "${optName}" choice name must be 1-100 characters.`);
        }
      }
    }
  }
}

module.exports = {
  validateCommandPayload,
};
