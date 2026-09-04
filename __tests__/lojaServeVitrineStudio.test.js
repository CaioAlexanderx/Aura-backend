// ============================================================
// loja.getaura.com.br/<slug> serve a vitrine Studio (04/09/2026)
//
// A mesma empresa tinha duas lojas em dois enderecos, e a lojista
// divulgava a errada — o painel copiava o endereco da loja comum e a
// vitrine que ela vende morava em `app.getaura.com.br/cardapio/studio/`.
//
// A decisao: empresa em modo Studio tem UMA loja, neste endereco. O que
// estes testes guardam e o que torna isso seguro — o interruptor certo,
// o bundle apontando para onde ele existe, e a queda do app nao levando
// a loja junto.
// ============================================================
const fs = require('fs');
const path = require('path');

const {
  ehLojaStudio, apontarParaOApp, recadoParaOApp, cspDaVitrineStudio, HOST_DO_APP,
} = require('../src/services/vitrineStudioShell');

describe('quem recebe a vitrine no lugar da loja comum', () => {
  test('so a empresa com o modo Studio ligado', () => {
    expect(ehLojaStudio({ pdv_settings: { studio_enabled: true } })).toBe(true);
    expect(ehLojaStudio({ pdv_settings: { studio_enabled: false } })).toBe(false);
  });

  test('o mesmo interruptor que o painel usa, inclusive como texto', () => {
    // `pdv_settings` e jsonb: dependendo de como a linha e lida, o valor
    // chega como booleano ou como a string "true". As seis lojas que nao
    // sao Studio nao podem trocar de vitrine por causa disso.
    expect(ehLojaStudio({ pdv_settings: { studio_enabled: 'true' } })).toBe(true);
    expect(ehLojaStudio({ pdv_settings: { studio_enabled: 'false' } })).toBe(false);
  });

  test('empresa sem o campo, ou sem pdv_settings, fica na loja comum', () => {
    expect(ehLojaStudio({ pdv_settings: {} })).toBe(false);
    expect(ehLojaStudio({ pdv_settings: null })).toBe(false);
    expect(ehLojaStudio({})).toBe(false);
    expect(ehLojaStudio(null)).toBe(false);
  });
});

describe('a casca do app servida sob outro dominio', () => {
  const casca = `<!DOCTYPE html><html><head><title>Aura.</title>`
    + `<link rel="icon" href="/assets/favicon.png">`
    + `</head><body><div id="root"></div>`
    + `<script src="/_expo/static/js/web/entry-abc123.js" defer></script>`
    + `</body></html>`;

  test('o bundle passa a apontar para o host onde ele existe', () => {
    // Servido daqui, `/_expo/...` e 404: o bundle mora no app. Sem esta
    // reescrita a loja abre em branco.
    const r = apontarParaOApp(casca);
    expect(r).toContain(`src="${HOST_DO_APP}/_expo/static/js/web/entry-abc123.js"`);
    expect(r).not.toContain('src="/_expo/');
  });

  test('os assets tambem', () => {
    expect(apontarParaOApp(casca)).toContain(`href="${HOST_DO_APP}/assets/favicon.png"`);
  });

  test('nao mexe em caminho que nao seja do Expo', () => {
    // Um replace solto em `/` quebraria qualquer href da propria pagina.
    const outro = '<a href="/politica">Política</a><img src="/logo.png">';
    expect(apontarParaOApp(outro)).toBe(outro);
  });
});

describe('o recado que diz qual loja abrir', () => {
  test('leva o slug', () => {
    expect(recadoParaOApp('sheid-mania')).toContain('"sheid-mania"');
    expect(recadoParaOApp('sheid-mania')).toContain('window.__AURA_VITRINE__');
  });

  test('slug com aspas nao escapa do script', () => {
    // O slug vem da URL. Sem escape, `"</script>` fecharia a tag e o
    // resto viraria HTML — injecao pela barra de endereco.
    const r = recadoParaOApp('x" onload="alert(1)');
    expect(r).not.toContain('onload="alert(1)"');
    expect(r).toContain('\\"');
  });
});

describe('a CSP da vitrine', () => {
  const csp = cspDaVitrineStudio('https://api.getaura.com.br');

  test('libera o bundle do app e o three.js do motor 3D', () => {
    expect(csp).toContain(`script-src 'self' 'unsafe-inline' ${HOST_DO_APP} https://cdnjs.cloudflare.com`);
  });

  test('libera a API e o R2, que e de onde vem a foto da cliente', () => {
    expect(csp).toContain('https://api.getaura.com.br');
    expect(csp).toContain('https://*.r2.dev');
  });

  test('nao abre curinga em script-src', () => {
    const linha = csp.split('; ').find((d) => d.startsWith('script-src '));
    expect(linha).not.toContain("'unsafe-eval'");
    expect(linha).not.toMatch(/script-src[^;]*\s\*/);
  });
});

describe('a rota que decide', () => {
  const rota = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'storefront.js'), 'utf8');

  test('le o interruptor da empresa, nao do canal digital', () => {
    // `digital_channel_config` nao sabe se a empresa e Studio; quem sabe
    // e `companies.pdv_settings`.
    expect(rota).toContain('COALESCE(c.pdv_settings');
    expect(rota).toContain('ehLojaStudio(');
  });

  test('app fora do ar cai na loja comum em vez de derrubar a loja', () => {
    // `montarVitrineStudio` devolve null nesse caso; o `if (pagina)` e o
    // que impede a pagina em branco.
    expect(rota).toContain('const pagina = await montarVitrineStudio(slug)');
    expect(rota).toContain('if (pagina) {');
  });

  test('a vitrine sai com a CSP dela, nao com a da loja comum', () => {
    expect(rota).toContain('cspDaVitrineStudio(STOREFRONT_API_BASE)');
  });
});
