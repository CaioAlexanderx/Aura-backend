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

## Onde esta o que

- `worker.js` — o Worker inteiro, num arquivo so. **O editor do painel da
  Cloudflare aceita um modulo apenas**, e este arquivo e byte-identico ao
  que esta publicado la. Nao quebre em varios arquivos sem trocar o deploy
  para `wrangler`.
- `__tests__/workerDeDominios.test.js` (na raiz do repo) importa
  `worker.js` pelo loader ESM do Node, num processo filho, e exercita as
  funcoes de verdade. Nao existe copia das regras em lugar nenhum.

## Deploy

Duas formas, e as duas publicam o mesmo arquivo:

**Pelo painel** — Workers & Pages → `aura-dominios` → Edit code, colar
`worker.js` inteiro, Ctrl+S, Deploy. Foi assim que ele subiu em 03/09/2026.

**Pelo wrangler** — precisa de login (abre o navegador; o token nao passa
pelo repo):

```bash
cd workers/dominios
npx wrangler login
npx wrangler deploy
```

## As rotas, no painel da zona `getaura.com.br`

| Rota                          | Worker                          |
| ----------------------------- | ------------------------------- |
| `www.davicalcados2.com.br/*`  | `aura-dominios`                 |
| `getaura.com.br/*`            | *(nenhum — Workers desativados)* |
| `*.getaura.com.br/*`          | *(nenhum — Workers desativados)* |

**Uma rota por loja, e nunca um `*/*`.** O painel (`app`) e o site
(`getaura.com.br`) vivem nesta mesma zona; um curinga colocaria os dois
atras de um Worker que, com defeito, derrubaria tudo. As duas linhas sem
Worker sao rede de protecao caso alguem adicione um curinga um dia, e
`ehNosso()` dentro do codigo e a terceira camada.

## Cadastrar o dominio de uma lojista nova

1. **SSL/TLS → Custom Hostnames → Add Custom Hostname** com o dominio dela,
   validacao TXT. A Cloudflare devolve um par
   `_cf-custom-hostname.<dominio>` para ela publicar no registrador.
2. **Workers Routes → Add route**: `<dominio>/*` → `aura-dominios`.
3. No registrador dela: `www` CNAME → `lojas.getaura.com.br` (a origem de
   fallback), e o apex redirecionando para `https://www`.
4. No painel da Aura: Meu Site → dominio proprio, o mesmo hostname. Ele
   grava `custom_domain` e `custom_domain_status = 'active'`, que e o que
   `customDomain.js` procura.

## Custo

Workers Free: 100 mil requisicoes por dia, contando so o trafego dos
dominios proprios. Cloudflare for SaaS: 100 hostnames sem cobranca.
