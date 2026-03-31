// Aliases curtos facilitam a troca de tenant no Twilio Sandbox durante demo
// e testes internos, sem depender de slugs tecnicos do projeto. No futuro
// isso pode evoluir para uma configuracao dinamica, mas por enquanto um mapa
// local deixa o fluxo simples, previsivel e facil de manter.
const DEFAULT_DEV_PROJECT_ALIASES = Object.freeze({
  clinica: 'clinica-demo',
  barbearia: 'barbearia-premium',
});

function listDevProjectAliases(aliases) {
  return Object.keys(aliases || {}).filter(Boolean);
}

module.exports = {
  DEFAULT_DEV_PROJECT_ALIASES,
  listDevProjectAliases,
};
