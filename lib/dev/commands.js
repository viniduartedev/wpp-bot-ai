const {
  DEV_PROJECT_ALIASES,
  isAllowedDevNumber,
  isDevCommandsEnabled,
  normalizeDevText,
} = require('./config');
const { listDevProjectAliases } = require('./devAliases');
const { resolveProjectByDevInput } = require('./resolveProject');
const { ACTIVE_TENANT_SLUG } = require('../tenant');

function parseDevCommand(messageText) {
  const trimmedMessage = String(messageText || '').trim();

  if (!trimmedMessage) {
    return null;
  }

  const commandMatch = trimmedMessage.match(/^\/dev(?:\s+(.*))?$/i);

  if (!commandMatch) {
    return null;
  }

  const commandArgument = normalizeDevText(commandMatch[1] || '');

  if (!commandArgument || commandArgument === 'help') {
    return {
      type: 'help',
      rawInput: commandMatch[1] || '',
      normalizedInput: '',
    };
  }

  if (commandArgument === 'reset') {
    return {
      type: 'reset',
      rawInput: commandMatch[1] || '',
      normalizedInput: '',
    };
  }

  return {
    type: 'set_project',
    rawInput: commandMatch[1] || '',
    normalizedInput: commandArgument,
  };
}

function getDevHelpMessage() {
  const availableAliasCommands = listDevProjectAliases(DEV_PROJECT_ALIASES)
    .filter((alias) => DEV_PROJECT_ALIASES[alias] === ACTIVE_TENANT_SLUG)
    .map((alias) => `* /dev ${alias}`);

  return `🔧 Modo dev disponível apenas para ${ACTIVE_TENANT_SLUG}.
Comandos:

${[`* /dev ${ACTIVE_TENANT_SLUG}`, ...availableAliasCommands, '* /dev reset'].join('\n')}`;
}

function getDevProjectChangedMessage(project) {
  return `🔧 Tenant ativo: ${ACTIVE_TENANT_SLUG}.`;
}

function getDevResetMessage() {
  return `🔧 Sessão reiniciada. Tenant ativo: ${ACTIVE_TENANT_SLUG}.`;
}

function getDevProjectNotFoundMessage() {
  return `Nesta fase o bot está disponível apenas para ${ACTIVE_TENANT_SLUG}.`;
}

function getDevCommandUnavailableMessage() {
  return 'Este comando não está disponível neste ambiente.';
}

async function handleDevCommand({ from, messageText }) {
  const parsedCommand = parseDevCommand(messageText);

  if (!parsedCommand) {
    return {
      matched: false,
    };
  }

  if (!isDevCommandsEnabled() || !isAllowedDevNumber(from)) {
    return {
      matched: true,
      available: false,
      action: 'unavailable',
      parsedCommand,
      response: getDevCommandUnavailableMessage(),
    };
  }

  if (parsedCommand.type === 'help') {
    return {
      matched: true,
      available: true,
      action: 'help',
      parsedCommand,
      response: getDevHelpMessage(),
    };
  }

  if (parsedCommand.type === 'reset') {
    return {
      matched: true,
      available: true,
      action: 'reset',
      parsedCommand,
      response: getDevResetMessage(),
    };
  }

  const resolvedAliasSlug = DEV_PROJECT_ALIASES[parsedCommand.normalizedInput] || null;

  if (
    parsedCommand.normalizedInput !== ACTIVE_TENANT_SLUG &&
    resolvedAliasSlug !== ACTIVE_TENANT_SLUG
  ) {
    return {
      matched: true,
      available: true,
      action: 'invalid_project',
      parsedCommand,
      response: getDevProjectNotFoundMessage(),
    };
  }

  try {
    const resolution = await resolveProjectByDevInput(parsedCommand.normalizedInput);

    if (!resolution?.project) {
      return {
        matched: true,
        available: true,
        action: 'invalid_project',
        parsedCommand,
        response: getDevProjectNotFoundMessage(),
      };
    }

    return {
      matched: true,
      available: true,
      action: 'set_project',
      parsedCommand,
      project: resolution.project,
      resolution,
      response: getDevProjectChangedMessage(resolution.project),
    };
  } catch (error) {
    return {
      matched: true,
      available: true,
      action: 'invalid_project',
      parsedCommand,
      error,
      response: getDevProjectNotFoundMessage(),
    };
  }
}

module.exports = {
  handleDevCommand,
  parseDevCommand,
  resolveProjectByDevInput,
  resolveProjectByDevCommand: resolveProjectByDevInput,
};
