const { DEFAULT_DEV_PROJECT_ALIASES } = require('./devAliases');

// O modo `/dev` existe para contornar a limitacao do Twilio Sandbox em
// desenvolvimento/demo. Em producao, esta feature deve permanecer desativada.
function normalizeDevText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function parseAllowedNumbers(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(',')
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function parseProjectAliases(value) {
  if (!String(value || '').trim()) {
    return {};
  }

  try {
    const parsedValue = JSON.parse(value);

    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      console.warn('[dev] DEV_PROJECT_ALIASES invalido. Use um objeto JSON simples.');
      return {};
    }

    return Object.entries(parsedValue).reduce((aliases, [alias, slug]) => {
      const normalizedAlias = normalizeDevText(alias);
      const normalizedSlug = normalizeDevText(slug);

      if (normalizedAlias && normalizedSlug) {
        aliases[normalizedAlias] = normalizedSlug;
      }

      return aliases;
    }, {});
  } catch (error) {
    console.warn('[dev] Falha ao interpretar DEV_PROJECT_ALIASES. Ignorando configuracao.', {
      message: error.message,
    });
    return {};
  }
}

function buildComparablePhoneValues(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  if (!normalizedValue) {
    return [];
  }

  const bareValue = normalizedValue.startsWith('whatsapp:')
    ? normalizedValue.slice('whatsapp:'.length)
    : normalizedValue;

  return Array.from(new Set([normalizedValue, bareValue, `whatsapp:${bareValue}`]));
}

const ENABLE_DEV_COMMANDS = process.env.ENABLE_DEV_COMMANDS === 'true';
const DEV_ALLOWED_NUMBERS = parseAllowedNumbers(process.env.DEV_ALLOWED_NUMBERS);
const DEV_PROJECT_ALIASES = {
  ...DEFAULT_DEV_PROJECT_ALIASES,
  ...parseProjectAliases(process.env.DEV_PROJECT_ALIASES),
};

function isDevCommandsEnabled() {
  return ENABLE_DEV_COMMANDS;
}

function isAllowedDevNumber(phone) {
  if (!DEV_ALLOWED_NUMBERS.length) {
    return true;
  }

  const comparableValues = buildComparablePhoneValues(phone);
  return DEV_ALLOWED_NUMBERS.some((allowedNumber) => comparableValues.includes(allowedNumber));
}

module.exports = {
  DEV_PROJECT_ALIASES,
  isAllowedDevNumber,
  isDevCommandsEnabled,
  normalizeDevText,
};
