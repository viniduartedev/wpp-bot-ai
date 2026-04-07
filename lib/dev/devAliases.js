// Nesta fase o bot opera apenas com o tenant piloto. O alias curto fica só para
// manter compatibilidade com testes/demo antigos do Sandbox.
const DEFAULT_DEV_PROJECT_ALIASES = Object.freeze({
  clinica: 'clinica-devtec',
});

function listDevProjectAliases(aliases) {
  return Object.keys(aliases || {}).filter(Boolean);
}

module.exports = {
  DEFAULT_DEV_PROJECT_ALIASES,
  listDevProjectAliases,
};
