const { getFirestoreClients } = require('../firebase-admin');
const {
  DEV_PROJECT_ALIASES,
  isAllowedDevNumber,
  isDevCommandsEnabled,
  normalizeDevText,
} = require('./config');

const PROJECT_COLLECTION_NAME = 'projects';

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

function isProjectInactive(projectData) {
  const normalizedStatus =
    typeof projectData.status === 'string' ? projectData.status.toLowerCase() : '';

  return (
    projectData.active === false ||
    projectData.isActive === false ||
    normalizedStatus === 'inactive'
  );
}

async function findProjectBySlug(slug) {
  const normalizedSlug = normalizeDevText(slug);

  if (!normalizedSlug) {
    return null;
  }

  const { db } = getFirestoreClients();
  const snapshot = await db
    .collection(PROJECT_COLLECTION_NAME)
    .where('slug', '==', normalizedSlug)
    .limit(2)
    .get();

  if (snapshot.empty) {
    return null;
  }

  if (snapshot.size > 1) {
    const error = new Error(
      `Mais de um projeto encontrado para o slug "${normalizedSlug}". Revise a base antes de usar o modo dev.`,
    );
    error.code = 'dev_project_duplicate';
    error.projectSlug = normalizedSlug;
    throw error;
  }

  const projectDoc = snapshot.docs[0];
  const project = {
    id: projectDoc.id,
    ...projectDoc.data(),
  };

  if (isProjectInactive(project)) {
    const error = new Error(
      `Projeto "${normalizedSlug}" encontrado, mas marcado como inativo para o modo dev.`,
    );
    error.code = 'dev_project_inactive';
    error.projectId = project.id;
    error.projectSlug = normalizedSlug;
    throw error;
  }

  return project;
}

async function resolveProjectByDevCommand(input) {
  const normalizedInput = normalizeDevText(input);

  if (!normalizedInput) {
    return null;
  }

  const projectBySlug = await findProjectBySlug(normalizedInput);

  if (projectBySlug) {
    return {
      project: projectBySlug,
      matchedBy: 'slug',
      lookupValue: normalizedInput,
    };
  }

  const aliasTarget = DEV_PROJECT_ALIASES[normalizedInput];

  if (!aliasTarget || aliasTarget === normalizedInput) {
    return null;
  }

  const projectByAlias = await findProjectBySlug(aliasTarget);

  if (!projectByAlias) {
    return null;
  }

  return {
    project: projectByAlias,
    matchedBy: 'alias',
    lookupValue: normalizedInput,
    resolvedSlug: aliasTarget,
  };
}

function getDevHelpMessage() {
  return `🔧 Modo dev disponível.
Comandos:

* /dev clinica
* /dev barbearia
* /dev reset`;
}

function getDevProjectChangedMessage(project) {
  return `🔧 Projeto alterado para ${project?.name || project?.slug || project?.id}.`;
}

function getDevResetMessage() {
  return '🔧 Override removido. Roteamento normal reativado.';
}

function getDevProjectNotFoundMessage() {
  return 'Não encontrei esse projeto. Digite /dev help para ver os comandos disponíveis.';
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

  try {
    const resolution = await resolveProjectByDevCommand(parsedCommand.normalizedInput);

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
  resolveProjectByDevCommand,
};
