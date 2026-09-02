// ============================================================
// Fotos de produto em dois tamanhos (02/09/2026, QA da Finesse)
//
// A lojista sobe o original do celular (3024x4032, 1-3 MB); a loja
// desenhava isso num card de 250px, 40 por pagina, e o Chrome congelava.
// Toda foto agora vira grande (ate 1600px) + miniatura (ate 640px), no
// upload e no acervo (job 001). Aqui: o helper de verdade (com sharp), o
// contrato das rotas e do payload, e o runner de jobs com um pool falso.
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');

const { derivarFotos, chavesDaFoto, chaveBaseDe, LADO_GRANDE, LADO_MINI } = require('../src/utils/fotosDeProduto');
const { rodarJobs, listarJobs } = require('../src/utils/jobRunner');
const job = require('../jobs/001_miniaturas_das_fotos');

const fonte = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('derivarFotos: grande ate 1600, miniatura ate 640, sempre JPEG', () => {
  let sharp;
  beforeAll(() => { sharp = require('sharp'); });

  test('um original 3000x4000 vira 1200x1600 e 480x640', async () => {
    const original = await sharp({ create: { width: 3000, height: 4000, channels: 3, background: '#c04060' } })
      .jpeg({ quality: 90 }).toBuffer();
    const r = await derivarFotos(original);
    const g = await sharp(r.grande).metadata();
    const m = await sharp(r.mini).metadata();
    expect([g.width, g.height]).toEqual([1200, 1600]);
    expect([m.width, m.height]).toEqual([480, 640]);
    expect(g.format).toBe('jpeg');
    expect(m.format).toBe('jpeg');
    expect(r.grande.length).toBeLessThan(original.length);
    expect(r.mini.length).toBeLessThan(r.grande.length);
    expect(r.bytesOriginais).toBe(original.length);
  });

  test('foto pequena nao e esticada; PNG com transparencia vira JPEG com fundo branco', async () => {
    const pequena = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png().toBuffer();
    const r = await derivarFotos(pequena);
    const g = await sharp(r.grande).metadata();
    expect([g.width, g.height]).toEqual([300, 200]);
    expect(g.format).toBe('jpeg');
    // O canto era transparente; em JPEG ficou branco.
    const { data } = await sharp(r.grande).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
  });

  test('aceita base64 e recusa vazio', async () => {
    const buf = await require('sharp')({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).jpeg().toBuffer();
    const r = await derivarFotos(buf.toString('base64'));
    expect(r.largura).toBe(10);
    await expect(derivarFotos('')).rejects.toThrow('imagem vazia');
  });

  test('limites: 1600 e 640', () => {
    expect(LADO_GRANDE).toBe(1600);
    expect(LADO_MINI).toBe(640);
  });
});

describe('chaves no R2', () => {
  test('a grande fica na chave canonica; a miniatura ganha .thumb', () => {
    expect(chavesDaFoto('c1/products/p1')).toEqual({ grande: 'c1/products/p1.jpg', mini: 'c1/products/p1.thumb.jpg' });
  });
  test('chaveBaseDe tira ?v=, a extensao e o .thumb', () => {
    expect(chaveBaseDe('c1/products/p1.jpg?v=123')).toBe('c1/products/p1');
    expect(chaveBaseDe('c1/products/p1.thumb.jpg')).toBe('c1/products/p1');
    expect(chaveBaseDe('c1/products/p1.PNG')).toBe('c1/products/p1');
    expect(chaveBaseDe('c1/products/p1')).toBe('c1/products/p1');
  });
});

describe('as rotas de upload salvam os dois tamanhos e apagam os dois', () => {
  const produto = fonte('src/routes/productImage.js');
  const variante = fonte('src/routes/variantImage.js');
  test('foto do produto', () => {
    expect(produto).toContain("salvarFotoEmDoisTamanhos(`${ownerCid}/products/${pid}`, content, content_type)");
    expect(produto).toContain('UPDATE products SET image_url=$1, image_thumb_url=$2, updated_at=NOW() WHERE id=$3');
    expect(produto).toContain('UPDATE products SET image_url=NULL, image_thumb_url=NULL, updated_at=NOW() WHERE id=$1');
    expect(produto).not.toContain('uploadToR2(');
  });
  test('foto da variante e da cor', () => {
    expect(variante).toContain('salvarFotoEmDoisTamanhos(`${ownerCid}/products/${pid}/variants/${variantId}`, content, content_type)');
    expect(variante).toContain('salvarFotoEmDoisTamanhos(`${ownerCid}/products/${pid}/colors/${hexKeyPart}`, content, content_type)');
    expect(variante).toContain('UPDATE product_variants SET image_url = $1, image_thumb_url = $2, updated_at = NOW() WHERE id = ANY($3::uuid[])');
    expect(variante).not.toContain('uploadToR2(');
  });
});

describe('o payload leva thumb_url e o template usa', () => {
  test('SELECTs da loja comum, do catalogo, da home e da vitrine trazem image_thumb_url', () => {
    for (const p of ['src/services/storefrontBuilder.js', 'src/services/catalogoPaginado.js', 'src/services/homeDaLoja.js', 'src/routes/studioStorefront.js']) {
      expect(fonte(p)).toContain('image_thumb_url');
    }
    expect(fonte('src/services/storefrontBuilder.js')).toContain('pv.image_url, pv.image_thumb_url');
  });
  test('grade, home e sacola preferem a miniatura', () => {
    expect(fonte('src/templates/storefront/parts/card.js')).toContain('var displayImg=p.thumb_url||p.image_url;');
    expect(fonte('src/templates/storefront/parts/home.js')).toContain('var img=p.thumb_url||p.image_url||comFoto.thumb_url||comFoto.image_url;');
    expect(fonte('src/templates/storefront/parts/cart.js')).toContain('image_url:p.thumb_url||p.image_url,qty:0');
  });
  test('a capa da categoria na home usa a miniatura primeiro', () => {
    expect(fonte('src/services/homeDaLoja.js')).toContain("COALESCE(NULLIF(btrim(p.image_thumb_url), ''), NULLIF(btrim(p.image_url), ''), p.gallery_urls->>0) AS url");
  });
  test('o boot agenda os jobs depois de subir', () => {
    expect(fonte('src/server.js')).toContain("agendarJobs({ pool: require('./config/database') });");
  });
});

describe('runner de jobs', () => {
  function poolFalso({ lock = true, tabela = true, feitos = [] } = {}) {
    const inserts = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: lock }] };
        if (/pg_advisory_unlock/.test(sql)) return { rows: [] };
        if (/SELECT key FROM jobs_run/.test(sql)) {
          if (!tabela) { const e = new Error('relation "jobs_run" does not exist'); e.code = '42P01'; throw e; }
          return { rows: feitos.map((k) => ({ key: k })) };
        }
        if (/INSERT INTO jobs_run/.test(sql)) { inserts.push(params); return { rows: [] }; }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    return { pool: { connect: async () => client }, client, inserts };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  fs.writeFileSync(path.join(dir, '001_ok.js'), 'module.exports={run:async()=>({concluido:true,n:3})};');
  fs.writeFileSync(path.join(dir, '002_pendente.js'), 'module.exports={run:async()=>({concluido:false,restam:5})};');
  fs.writeFileSync(path.join(dir, '003_quebra.js'), 'module.exports={run:async()=>{throw new Error("boom")}};');
  fs.writeFileSync(path.join(dir, 'rascunho.js'), 'module.exports={run:async()=>{throw new Error("nao devia rodar")}};');
  const log = () => {};

  test('lista so NNN_nome.js, em ordem', () => {
    expect(listarJobs(dir)).toEqual(['001_ok.js', '002_pendente.js', '003_quebra.js']);
  });
  test('concluido entra em jobs_run; pendente e quebrado ficam de fora; o lock e devolvido', async () => {
    const f = poolFalso();
    const r = await rodarJobs({ pool: f.pool, dir, log });
    expect(r.rodados.map((x) => x.key)).toEqual(['001_ok.js', '002_pendente.js', '003_quebra.js']);
    expect(f.inserts.map((p) => p[0])).toEqual(['001_ok.js']);
    expect(r.rodados[2].resultado.erro).toBe('boom');
    expect(f.client.query.mock.calls.some(([sql]) => /pg_advisory_unlock/.test(sql))).toBe(true);
    expect(f.client.release).toHaveBeenCalled();
  });
  test('ja feito nao roda de novo', async () => {
    const f = poolFalso({ feitos: ['001_ok.js', '002_pendente.js', '003_quebra.js'] });
    const r = await rodarJobs({ pool: f.pool, dir, log });
    expect(r.rodados).toEqual([]);
  });
  test('sem lock, desiste; sem tabela, sai em silencio', async () => {
    expect((await rodarJobs({ pool: poolFalso({ lock: false }).pool, dir, log })).pulado).toBe('lock');
    expect((await rodarJobs({ pool: poolFalso({ tabela: false }).pool, dir, log })).pulado).toBe('sem_tabela');
  });
  test('o job 001 existe e e o das miniaturas', () => {
    expect(listarJobs(path.join(__dirname, '..', 'jobs'))).toContain('001_miniaturas_das_fotos.js');
  });
});

describe('job 001: a chave sai da URL publica do R2', () => {
  const { R2_CONFIG } = require('../src/utils/r2Storage');
  const pub = R2_CONFIG.publicUrl;
  test('URL nossa vira chave; ?v= cai fora; URL de fora vira null', () => {
    expect(job.chaveDaUrl(pub + '/c1/products/p1.jpg?v=9')).toBe('c1/products/p1.jpg');
    expect(job.chaveDaUrl('https://outra.cdn/x.jpg')).toBeNull();
    expect(job.chaveDaUrl(null)).toBeNull();
  });
  test('sem R2 configurado o job nao conclui (fica pra producao)', async () => {
    if (R2_CONFIG.accessKey) return; // ambiente com R2 de verdade: nao roda aqui
    const r = await job.run({ pool: { query: async () => ({ rows: [] }) }, log: () => {} });
    expect(r.concluido).toBe(false);
    expect(r.motivo).toMatch(/R2/);
  });
  test('uma subida nunca vira maratona', () => {
    expect(job.MAX_POR_RODADA).toBeLessThanOrEqual(400);
    expect(job.PARALELO).toBeLessThanOrEqual(3);
  });
});
