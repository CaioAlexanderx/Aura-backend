import { defineRailway, project, service } from "railway/iac";

// Substitui o railway.toml (Config as Code, que a Railway deixa de ler em
// 2026-12-01). Gerado por `railway config migrate` e ajustado a mao:
// nomes reais do projeto/servico e a regiao de producao.
//
// ATENCAO: a Railway NAO le este arquivo no deploy. Ele so vale depois de
// `railway config apply` (CLI) ou da action railwayapp/config. Ate la o
// railway.toml continua sendo a fonte. Passo a passo no PR.
export const partial = "Aura-backend";

export default defineRailway(() => {
  const auraBackend = service("Aura-backend", {
    start: "node src/index.js",
    healthcheck: "/health",
    healthcheckTimeout: 60,
    // Roda UMA vez por deploy, antes da versao nova subir. Se falhar, o deploy
    // nao sobe (e o que se quer quando o codigo depende de coluna nova).
    // Ver src/utils/migrationRunner.js e scripts/migrate.js.
    preDeploy: "node scripts/migrate.js up",
    replicas: { "us-east4-eqdc4a": 1 },
    // Sem equivalente em railway.ts (documentacao de 27/11/2026):
    //   builder = NIXPACKS (nixpacks.toml: install com `npm install`)
    //   restartPolicyType = ON_FAILURE, restartPolicyMaxRetries = 3
  });
  return project("aura-backend", {
    resources: [auraBackend],
  });
});