# aura-dominios

O Worker que faz o dominio proprio da lojista chegar na loja dela.

## O problema, em uma frase

O Railway roteia pelo cabecalho `Host` e responde `Application not found`
a qualquer host que ele nao conheca — e no plano Hobby so cabem 2 dominios
por servico, ja ocupados por `loja` e `api`.

Reescrever o `Host` na propria Cloudflare resolveria, mas "Host Header" em
Origin Rules e exclusivo do plano Enterprise. Um Worker faz o mesmo de graca.

## O caminho de uma visita

```
www.davicalcados2.com.br
  → Cloudflare (certificado emitido por Cloudflare for SaaS)
  → Worker aura-dominios: Host vira loja.getaura.com.br, X-Aura-Host guarda o original
  → Railway (reconhece loja.getaura.com.br)
  → customDomain.js le X-Aura-Host (so quando cf-ray existe) e serve a loja certa
```

## Deploy

```bash
cd workers/dominios
npx wrangler login      # abre o navegador; o token nao passa por aqui
npx wrangler deploy
```

## As rotas, uma vez so, no painel

Workers Routes da zona `getaura.com.br`, nesta ordem. O padrao mais
especifico ganha, entao as duas primeiras protegem tudo que e nosso:

| Rota                  | Worker          |
| --------------------- | --------------- |
| `getaura.com.br/*`    | *(nenhum)*      |
| `*.getaura.com.br/*`  | *(nenhum)*      |
| `*/*`                 | `aura-dominios` |

Sem as duas primeiras, `loja.getaura.com.br` cairia no proprio Worker e
chamaria a si mesma. O `ehNosso()` no codigo e o cinto de seguranca para
esse caso, mas a rota e o cinto de verdade.

## Onde esta o que

- `src/regras.js` — a decisao toda, em CommonJS, porque o Jest deste repo
  roda CommonJS puro. E o arquivo que `__tests__/workerDeDominios.test.js`
  cobre.
- `src/index.mjs` — a casca no formato de modulo da Cloudflare. Chama as
  regras e nao decide nada por conta propria.

## Cadastrar o dominio de uma lojista

1. SSL/TLS → Custom Hostnames → **Add Custom Hostname**, com o dominio dela.
2. No DNS do registrador dela: `www` CNAME → `lojas.getaura.com.br`
   (a origem de fallback), e o apex redirecionando para `https://www`.
3. No painel da Aura: Meu Site → dominio proprio, o mesmo hostname.

## Custo

Workers Free: 100 mil requisicoes por dia, contando so o trafego dos
dominios proprios. Cloudflare for SaaS: 100 hostnames sem cobranca.
