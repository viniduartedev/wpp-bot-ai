function collapseWhitespace(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function padNumber(value) {
  return String(value).padStart(2, '0');
}

function isValidCalendarDate(day, month, year) {
  const candidate = new Date(year, month - 1, day);

  return (
    candidate.getFullYear() === year &&
    candidate.getMonth() === month - 1 &&
    candidate.getDate() === day
  );
}

// Validacoes leves, suficientes para a demo.
// O objetivo aqui e evitar entradas absurdas sem adicionar parser complexo
// ou mudar o papel do bot, que segue como canal de entrada da solicitacao.
function normalizeNameInput(value) {
  const formattedValue = collapseWhitespace(value);
  const hasLetters = /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(formattedValue);

  return {
    isValid: formattedValue.length >= 2 && hasLetters,
    value: formattedValue,
  };
}

function normalizeDateInput(value) {
  const formattedValue = collapseWhitespace(value);
  const match = formattedValue.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);

  if (!match) {
    return {
      isValid: false,
      value: formattedValue,
    };
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const hasExplicitYear = Boolean(match[3]);
  const year = hasExplicitYear ? Number(match[3]) : new Date().getFullYear();

  if (!isValidCalendarDate(day, month, year)) {
    return {
      isValid: false,
      value: formattedValue,
    };
  }

  return {
    isValid: true,
    value: hasExplicitYear
      ? `${padNumber(day)}/${padNumber(month)}/${year}`
      : `${padNumber(day)}/${padNumber(month)}`,
  };
}

function normalizeTimeInput(value) {
  const formattedValue = collapseWhitespace(value);
  const match = formattedValue.match(/^(\d{1,2})(?::|h)(\d{2})?$/i);

  if (!match) {
    return {
      isValid: false,
      value: formattedValue,
    };
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2] || '0');

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return {
      isValid: false,
      value: formattedValue,
    };
  }

  return {
    isValid: true,
    value: `${padNumber(hours)}:${padNumber(minutes)}`,
  };
}

module.exports = {
  normalizeDateInput,
  normalizeNameInput,
  normalizeTimeInput,
};
