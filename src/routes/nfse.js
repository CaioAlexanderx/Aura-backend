// ============================================================
// AURA. — W2-03 F3: Rotas NFS-e cross-vertical
//
// Endpoints (todos sob /companies/:cid/nfse):
//
//   Config:
//     GET    /config           ler config (sem decifrar api_key!) + passo a passo
//     PUT    /config           atualizar config (cifra api_key)
//     POST   /teste            nota de teste em produção restrita (migration 441)
//
//   Notas:
//     POST   /                 emitir NFS-e
//     GET    /                 listar (filtros: status, customer_id, date_from, date_to)
//     GET    /:id              detalhe + provider_response
//     POST   /:id/cancel       cancelar (motivo obrigatorio min 15 chars)
//     POST   /:id/refresh      reconsulta status no provider (util pra status=processando)
//     GET    /:id/pdf          redirect/proxy pro PDF
//     GET    /:id/xml          redirect/proxy pro XML
//
// Mountada em private.js como /nfse — disponivel pra qualquer
// plano (todos os planos podem emitir NFS-e). Nao acoplada
// a vertical especifica.
//
// 09/11/2026 — provider 'nacional' (Emissor Público Nacional, API Sefin
// Nacional, services/nfseNacional): POST / exige chave de idempotência
// (corpo idempotency_key ou header Idempotency-Key) e o tomador é opcional;
// cancel/refresh/pdf/xml da nota nacional vão ao serviço. Liga geral
// NFSE_NACIONAL_ENABLED (desligada = nada sai).
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  getProvider,
  validateInvoiceData,
  NfseProviderError,
} = require('../services/nfseProvider');
// 09/11/2026: provider 'nacional' (Emissor Público Nacional, API Sefin
// Nacional). Emissão, cancelamento, consulta e DANFSe saem do serviço
// próprio, que lê o A1 do cofre da empresa (company_certificates). Liga
// geral NFSE_NACIONAL_ENABLED: desligada, nada é enviado.
const nacional = require('../services/nfseNacional');
const { validarCamposNacional, validarRetencao } = require('../services/nfseNacional/config');
const { producaoHabilitada, normalizarAmbiente } = require('../services/nfseNacional/endpoints');
const { NfseNacionalError, httpStatusDe } = require('../services/nfseNacional/errors');

const requireWrite = requireRole('client', 'analyst', 'admin');

const NACIONAL_CAMPOS = [
  'municipio_ibge', 'ctribnac_padrao', 'cnbs_padrao', 'op_simp_nac',
  'reg_ap_trib_sn', 'reg_esp_trib', 'p_tot_trib_sn', 'next_dps_number',
  // migration 441: passo a passo da configuração da loja
  'prefeitura_cadastro_confirmado', 'cliente_retem_iss', 'aliquota_iss_retencao_sn',
];

function sendNacionalError(res, where, err) {
  console.error(`[nfse nacional ${where}]`, err.code, err.message);
  const body = { error: err.message, code: err.code };
  if (Array.isArray(err.details)) body.detalhes = err.details;
  return res.status(httpStatusDe(err.code)).json(body);
}

function nacionalResposta(nota, extra = {}) {
  return {
    nfse_id: nota.id,
    status: nota.status,
    chave_acesso: nota.chave_acesso || null,
    nfse_number: nota.nfse_number || null,
    dps_serie: nota.dps_serie || null,
    dps_number: nota.dps_number != null ? String(nota.dps_number) : null,
    ambiente: nota.ambiente || null,
    rejection_reason: nota.rejection_reason || null,
    error_codes: nota.error_codes || null,
    ...extra,
  };
}

/** Corpo do POST / (mesmos nomes do fluxo antigo) → nota do serviço nacional. */
function notaNacionalDoCorpo(body) {
  const b = body || {};
  const a = b.recipient_address || null;
  const temTomador = b.recipient_doc || b.recipient_name;
  return {
    descricao: b.service_description,
    valor: b.service_amount,
    competencia: b.competence_date || undefined,
    ctribnac: b.service_code || undefined,
    cnbs: b.cnbs || undefined,
    iss_retido: b.iss_retained === true,
    aliquota_iss: b.iss_rate,
    tot_trib: b.tot_trib || undefined,
    customer_id: b.customer_id || undefined,
    payment_id: b.payment_id || undefined,
    // migration 437: serviço do estoque; os campos dele preenchem o que a
    // nota não trouxe (nota → item → padrão da empresa).
    product_id: b.product_id || undefined,
    source_type: b.source_type || undefined,
    tomador: temTomador ? {
      doc: b.recipient_doc,
      nome: b.recipient_name,
      email: b.recipient_email || null,
      fone: b.recipient_phone || null,
      im: b.recipient_im || null,
      endereco: a ? {
        logradouro: a.logradouro, numero: a.numero, complemento: a.complemento,
        bairro: a.bairro, cMun: a.codigo_municipio, cep: a.cep,
      } : null,
    } : undefined,
  };
}

async function emitirNacional(req, res) {
  const key = (req.body && req.body.idempotency_key) || req.get('Idempotency-Key');
  try {
    const r = await nacional.emitir(db, {
      companyId: req.params.id,
      idempotencyKey: key,
      nota: notaNacionalDoCorpo(req.body),
    });
    const corpo = nacionalResposta(r.nota, { replay: !!r.replay, aguardando_confirmacao: !!r.aguardando });
    if (r.aguardando) return res.status(202).json(corpo);
    if (r.nota.status === 'rejeitada') return res.status(422).json(corpo);
    if (r.nota.status === 'erro') return res.status(502).json(corpo);
    return res.status(r.replay ? 200 : 201).json(corpo);
  } catch (err) {
    if (err instanceof NfseNacionalError) return sendNacionalError(res, 'emit', err);
    console.error('[nfse nacional emit] unexpected:', err.message);
    return res.status(500).json({ error: 'Erro ao emitir NFS-e' });
  }
}

// ─────────────────────────────────────────────────────────
// Helpers de cifragem das credentials
// ─────────────────────────────────────────────────────────
//
// Estrategia AES-256-GCM com chave em env AURA_ENCRYPTION_KEY (32 bytes,
// 64 chars hex). Em prod a chave fica em Railway env var.
//
// INC-2026-10-21-03 (tq-101): havia uma chave fixa de desenvolvimento no
// codigo (repositorio publico) usada quando a env faltava — qualquer um
// decifraria as credenciais do provedor. Agora:
//   - com AURA_ENCRYPTION_KEY valida: usa ela;
//   - NODE_ENV=test sem a env: chave aleatoria por processo (nunca literal);
//   - qualquer outro caso (producao inclusive): cifrar/decifrar lanca
//     NfseEncryptionKeyError -> 500 controlado + console.error. Nunca chave fixa.
//
// Formato: base64(iv || authTag || ciphertext)
// IV 12 bytes (96 bits) — padrao GCM
// AuthTag 16 bytes (128 bits)
// ─────────────────────────────────────────────────────────

class NfseEncryptionKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NfseEncryptionKeyError';
    this.code = 'NFSE_ENCRYPTION_KEY_MISSING';
  }
}

let _testOnlyKey = null;

// Lida a cada uso (nao no load do modulo): a env pode entrar sem redeploy do
// codigo e os testes conseguem exercitar os dois lados.
function getEncryptionKey() {
  const hex = process.env.AURA_ENCRYPTION_KEY;
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      // Mensagem sem ecoar o valor recebido.
      throw new NfseEncryptionKeyError('AURA_ENCRYPTION_KEY invalida (esperado: 64 chars hex).');
    }
    return Buffer.from(hex, 'hex');
  }
  if (process.env.NODE_ENV === 'test') {
    if (!_testOnlyKey) _testOnlyKey = crypto.randomBytes(32);
    return _testOnlyKey;
  }
  throw new NfseEncryptionKeyError(
    'AURA_ENCRYPTION_KEY ausente: credenciais de NFS-e nao podem ser cifradas nem decifradas.'
  );
}

function sendKeyError(res, where, err) {
  console.error(`[nfse ${where}] ${err.code}: ${err.message}`);
  return res.status(500).json({
    error: 'NFS-e indisponivel: chave de criptografia nao configurada no servidor.',
    code: err.code,
  });
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decrypt(encoded) {
  if (!encoded) return null;
  // Fora do try: chave ausente/invalida NAO vira "api key nao configurada";
  // sobe como NfseEncryptionKeyError para a rota responder 500 controlado.
  const key = getEncryptionKey();
  try {
    const buf = Buffer.from(encoded, 'base64');
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[nfse decrypt] failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// Helpers de DB
// ─────────────────────────────────────────────────────────

async function getCompany(cid) {
  const { rows } = await db.query(
    `SELECT id, legal_name, trade_name, cnpj, address_street AS logradouro,
            address_number AS numero, address_complement AS complemento,
            address_neighborhood AS bairro, address_city AS municipio,
            address_state AS uf, address_zip AS cep, address_city_code AS codigo_municipio
       FROM companies WHERE id = $1`,
    [cid]
  );
  return rows[0] || null;
}

async function getNfseConfig(cid) {
  const { rows } = await db.query(
    `SELECT * FROM nfse_config WHERE company_id = $1`,
    [cid]
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────

// GET /config — leitura. NUNCA retorna api_key/cert_pwd descifrados.
router.get('/config', requireAuth, async (req, res) => {
  try {
    const config = await getNfseConfig(req.params.id);
    if (!config) {
      // 10/11/2026 (migration 441): a tela "Pronto para emitir NFS-e?" mostra
      // os passos e os dados da empresa mesmo antes da primeira gravação.
      let situacao = null;
      try {
        situacao = await nacional.situacaoConfig(db, req.params.id);
      } catch (e) {
        console.error('[nfse get config nacional]', e.message);
      }
      return res.json({ config: null, has_config: false, nacional: situacao });
    }

    // Mascara campos sensiveis
    const safe = { ...config };
    safe.api_key_encrypted = config.api_key_encrypted ? '***configured***' : null;
    safe.api_secret = config.api_secret ? '***configured***' : null;
    safe.certificate_pwd = config.certificate_pwd ? '***configured***' : null;
    delete safe.api_key_encrypted;
    safe.has_api_key = !!config.api_key_encrypted;
    safe.has_certificate = !!config.certificate_url;

    // Emissor nacional: diz se a empresa está apta e o que falta (sem segredo).
    // 10/11/2026 (migration 441): para qualquer provider — a tela "Pronto
    // para emitir NFS-e?" grava provider 'nacional' no primeiro passo.
    {
      try {
        safe.nacional = await nacional.situacaoConfig(db, req.params.id);
        if (config.provider === 'nacional') safe.has_certificate = !!safe.nacional.certificado;
      } catch (e) {
        console.error('[nfse get config nacional]', e.message);
        safe.nacional = null;
      }
    }

    res.json({ config: safe, has_config: true });
  } catch (err) {
    console.error('[nfse get config]', err.message);
    res.status(500).json({ error: 'Erro ao buscar config' });
  }
});

// PUT /config — upsert
router.put('/config', requireAuth, requireWrite, async (req, res) => {
  const ALLOWED = [
    'provider', 'ambiente',
    'inscricao_municipal', 'regime_tributario', 'regime_especial',
    'optante_simples_nacional', 'incentivador_cultural',
    'default_service_code', 'default_cnae', 'default_iss_rate',
    'serie', 'is_active',
  ];

  const body = req.body || {};
  const data = {};
  for (const k of ALLOWED) {
    if (body[k] !== undefined) data[k] = body[k];
  }

  try {
    // api_key e secret sao tratados separadamente — cifrados antes de salvar
    // (dentro do try: sem chave, encrypt lanca e a rota responde 500 controlado)
    if (body.api_key) data.api_key_encrypted = encrypt(body.api_key);
    if (body.api_secret) data.api_secret = body.api_secret; // alguns providers nao cifram secret
    if (body.certificate_url) data.certificate_url = body.certificate_url;
    if (body.certificate_pwd) data.certificate_pwd = encrypt(body.certificate_pwd);

    // Upsert
    const existing = await getNfseConfig(req.params.id);

    // Emissor nacional (09/11/2026): campos próprios, validados; ambiente só
    // 'producao_restrita' | 'producao'. O certificado é o A1 do cofre da
    // empresa (POST /fiscal-certificate) — URL/senha soltas aqui não servem.
    const providerFinal = data.provider !== undefined ? data.provider : (existing && existing.provider);
    const temCampoNacional = NACIONAL_CAMPOS.some((k) => body[k] !== undefined);
    if (providerFinal === 'nacional' || temCampoNacional) {
      const camposNac = {};
      for (const k of NACIONAL_CAMPOS) if (body[k] !== undefined) camposNac[k] = body[k];
      if (providerFinal === 'nacional') {
        if (body.ambiente !== undefined) camposNac.ambiente = body.ambiente;
        if (body.serie !== undefined) camposNac.serie = body.serie;
        // alíquota padrão do ISS: já estava em ALLOWED (sem validar); no
        // nacional ela é o último degrau da precedência nota → item → empresa,
        // então passa pela mesma régua do cadastro do item (0 a 5).
        if (body.default_iss_rate !== undefined) camposNac.default_iss_rate = body.default_iss_rate;
        if (body.inscricao_municipal !== undefined) camposNac.inscricao_municipal = body.inscricao_municipal;
        if (body.certificate_url || body.certificate_pwd) {
          return res.status(400).json({
            error: 'No emissor nacional o certificado é o A1 da empresa: envie o arquivo .pfx em Configurações > Nota Fiscal.',
            code: 'CERTIFICADO',
          });
        }
      }
      const { data: nac, erros } = validarCamposNacional(camposNac);
      if (erros.length) return res.status(400).json({ error: erros.join(' '), code: 'INVALID_INPUT', detalhes: erros });
      Object.assign(data, nac);
      // alíquota do ISSQN retido: só com cliente que retém e ME/EPP do Simples
      const errosRet = validarRetencao(existing, data);
      if (errosRet.length) return res.status(400).json({ error: errosRet.join(' '), code: 'INVALID_INPUT', detalhes: errosRet });
      if (providerFinal === 'nacional' && body.serie_confirmada === true) data.serie_confirmada_em = new Date();
      // nunca nasce (nem migra de outro provider) em produção sem pedir
      if (providerFinal === 'nacional' && (!existing || existing.provider !== 'nacional') && data.ambiente === undefined) {
        data.ambiente = 'producao_restrita';
      }
    }

    // Ligar a NFS-e (migration 441): só com a nota de teste aceita em
    // produção restrita e os passos obrigatórios prontos. Ligar sem dizer o
    // ambiente = produção, que continua travada no servidor sem
    // NFSE_NACIONAL_PRODUCAO.
    if (providerFinal === 'nacional' && data.is_active === true) {
      const ambienteFinal = normalizarAmbiente(data.ambiente !== undefined ? data.ambiente
        : (existing && existing.is_active ? existing.ambiente : 'producao'));
      const jaLigada = existing && existing.is_active === true && normalizarAmbiente(existing.ambiente) === ambienteFinal;
      if (!jaLigada) {
        if (data.ambiente === undefined) data.ambiente = ambienteFinal;
        const final = { ...(existing || {}), ...data, provider: 'nacional' };
        const v = await nacional.avaliarLigar(db, req.params.id, final);
        if (!v.ok) {
          return res.status(409).json({ error: v.motivos.join(' '), code: 'NAO_PODE_LIGAR', detalhes: v.motivos, passos: v.passos });
        }
        if (ambienteFinal === 'producao' && !producaoHabilitada()) {
          return res.status(409).json({
            error: 'Sua loja está pronta! A Aura está liberando a emissão em produção e avisa você assim que terminar. Nada mudou na sua configuração.',
            code: 'PRODUCAO_NAO_LIBERADA',
          });
        }
      }
    }

    if (existing) {
      const fields = [];
      const values = [];
      let idx = 1;
      for (const [k, v] of Object.entries(data)) {
        // a numeração da DPS só anda pra frente (número já usado nunca volta)
        fields.push(k === 'next_dps_number'
          ? `next_dps_number = GREATEST(next_dps_number, $${idx++})`
          : `${k} = $${idx++}`);
        values.push(v);
      }
      if (fields.length === 0) return res.status(400).json({ error: 'Nada pra atualizar' });
      values.push(req.params.id);

      const { rows } = await db.query(
        `UPDATE nfse_config SET ${fields.join(', ')} WHERE company_id = $${idx} RETURNING id`,
        values
      );
      return res.json({ ok: true, config_id: rows[0].id });
    } else {
      // Insert
      data.company_id = req.params.id;
      const cols = Object.keys(data);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await db.query(
        `INSERT INTO nfse_config (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
        Object.values(data)
      );
      return res.status(201).json({ ok: true, config_id: rows[0].id });
    }
  } catch (err) {
    if (err instanceof NfseEncryptionKeyError) return sendKeyError(res, 'put config', err);
    console.error('[nfse put config]', err.message);
    res.status(500).json({ error: 'Erro ao salvar config' });
  }
});

// POST /teste — "Emitir nota de teste" (migration 441). Sempre em produção
// restrita (tpAmb 2), série de teste com contador próprio, chave
// "teste:<idempotency_key>". Não exige is_active. Responde 200 com o
// resultado traduzido (ok, rejeitado, erro) e a situação atualizada.
router.post('/teste', requireAuth, requireWrite, async (req, res) => {
  const key = (req.body && req.body.idempotency_key) || req.get('Idempotency-Key');
  try {
    const r = await nacional.emitirTeste(db, { companyId: req.params.id, idempotencyKey: key });
    let situacao = null;
    try {
      situacao = await nacional.situacaoConfig(db, req.params.id);
    } catch (e) {
      console.error('[nfse teste situacao]', e.message);
    }
    return res.json({
      resultado: r.resultado,
      nota: r.nota ? nacionalResposta(r.nota) : null,
      replay: !!r.replay,
      nacional: situacao,
    });
  } catch (err) {
    if (err instanceof NfseNacionalError) return sendNacionalError(res, 'teste', err);
    console.error('[nfse nacional teste] unexpected:', err.message);
    return res.status(500).json({ error: 'Não conseguimos emitir a nota de teste agora. Tente de novo em instantes.' });
  }
});

// ─────────────────────────────────────────────────────────
// NOTAS
// ─────────────────────────────────────────────────────────

// POST / — emitir NFS-e
router.post('/', requireAuth, requireWrite, async (req, res) => {
  const cid = req.params.id;
  const {
    customer_id, appointment_id, treatment_plan_id, payment_id, source_type,
    service_code, service_description, service_amount,
    iss_rate, iss_retained, deductions,
    inss_value, ir_value, csll_value, cofins_value, pis_value,
    competence_date,
    recipient_name, recipient_doc, recipient_email, recipient_phone, recipient_address,
    recipient_type,
  } = req.body || {};

  // Com product_id a descrição pode vir do item (emissor nacional); sem
  // item, segue obrigatória como sempre.
  if (!service_description && !(req.body && req.body.product_id)) {
    return res.status(400).json({ error: 'service_description obrigatorio' });
  }
  if (!service_amount || service_amount <= 0) {
    return res.status(400).json({ error: 'service_amount deve ser > 0' });
  }

  const client = await db.connect();
  let released = false;
  try {
    await client.query('BEGIN');

    // Carrega config + decifra api_key
    const config = await getNfseConfig(cid);
    if (!config) {
      throw new NfseProviderError('NFS-e nao configurada nesta empresa', 'CONFIG_MISSING');
    }
    if (!config.is_active) {
      throw new NfseProviderError('NFS-e desativada. Ative no painel de config.', 'CONFIG_INACTIVE');
    }

    // Emissor nacional (09/11/2026): fluxo próprio — numeração, idempotência
    // e certificado ficam no serviço. Tomador é opcional no leiaute nacional.
    if (config.provider === 'nacional') {
      await client.query('ROLLBACK');
      client.release();
      released = true;
      return emitirNacional(req, res);
    }

    // providers antigos: descrição e tomador obrigatórios (como sempre foi);
    // product_id só é lido pelo emissor nacional.
    if (!service_description) throw new NfseProviderError('service_description obrigatorio', 'INVALID_INPUT');
    // providers antigos: tomador obrigatório (como sempre foi)
    if (!recipient_name) throw new NfseProviderError('recipient_name obrigatorio', 'INVALID_INPUT');
    if (!recipient_doc) throw new NfseProviderError('recipient_doc (CPF/CNPJ) obrigatorio', 'INVALID_INPUT');

    config._decrypted_api_key = decrypt(config.api_key_encrypted);
    if (!config._decrypted_api_key && config.provider !== 'mock') {
      throw new NfseProviderError(
        'API key nao configurada. Configure em /nfse/config.',
        'CONFIG_MISSING'
      );
    }

    // Carrega empresa
    const company = await getCompany(cid);
    if (!company) throw new NfseProviderError('Empresa nao encontrada', 'CONFIG_MISSING');
    if (!company.cnpj) {
      throw new NfseProviderError('CNPJ da empresa nao cadastrado', 'CONFIG_MISSING');
    }

    // Defaults da config
    const finalServiceCode = service_code || config.default_service_code;
    const finalIssRate = iss_rate !== undefined ? iss_rate : config.default_iss_rate;
    const finalIssValue = parseFloat((service_amount * (finalIssRate / 100)).toFixed(2));

    if (!finalServiceCode) {
      throw new NfseProviderError(
        'service_code obrigatorio. Configure default_service_code ou passe explicito.',
        'INVALID_INPUT'
      );
    }

    // RPS atomico (chama funcao SQL)
    const { rows: rpsRows } = await client.query(
      `SELECT nfse_next_rps($1) AS rps_number`,
      [cid]
    );
    const rpsNumber = rpsRows[0].rps_number;

    // Monta invoiceData
    const invoiceData = {
      company,
      config,
      rps_number: rpsNumber,
      rps_serie:  config.serie || '1',
      service_code:        finalServiceCode,
      service_description,
      service_amount:      parseFloat(service_amount),
      iss_rate:            parseFloat(finalIssRate),
      iss_value:           finalIssValue,
      iss_retained:        !!iss_retained,
      competence_date:     competence_date || null,
      recipient: {
        type:    recipient_type || 'pf',
        name:    recipient_name,
        doc:     recipient_doc,
        email:   recipient_email,
        phone:   recipient_phone,
        address: recipient_address,
      },
    };

    // Valida
    const validationErrors = validateInvoiceData(invoiceData);
    if (validationErrors.length > 0) {
      throw new NfseProviderError(
        'Dados invalidos: ' + validationErrors.join('; '),
        'INVALID_INPUT',
        validationErrors
      );
    }

    // Insere registro com status pendente ANTES de chamar provider
    // (assim se a chamada falhar, ainda temos rastro)
    const { rows: nfseRows } = await client.query(
      `INSERT INTO nfse (
        company_id, customer_id, appointment_id, treatment_plan_id, payment_id, source_type,
        rps_number, rps_serie, status,
        recipient_type, recipient_name, recipient_doc, recipient_email, recipient_phone, recipient_address,
        service_code, service_description, service_amount,
        iss_rate, iss_value, iss_retained,
        deductions, inss_value, ir_value, csll_value, cofins_value, pis_value,
        net_amount, competence_date, provider
      ) VALUES (
        $1,$2,$3,$4,$5,$6, $7,$8,'pendente',
        $9,$10,$11,$12,$13,$14,
        $15,$16,$17, $18,$19,$20,
        $21,$22,$23,$24,$25,$26, $27,$28,$29
      ) RETURNING id`,
      [
        cid, customer_id || null, appointment_id || null, treatment_plan_id || null,
        payment_id || null, source_type || 'manual',
        rpsNumber, config.serie || '1',
        recipient_type || 'pf', recipient_name, recipient_doc,
        recipient_email || null, recipient_phone || null,
        recipient_address ? JSON.stringify(recipient_address) : null,
        finalServiceCode, service_description, service_amount,
        finalIssRate, finalIssValue, !!iss_retained,
        deductions || 0, inss_value || 0, ir_value || 0,
        csll_value || 0, cofins_value || 0, pis_value || 0,
        // net_amount = service_amount - deductions - iss(se retido) - inss - ir - csll - cofins - pis
        parseFloat(service_amount) - parseFloat(deductions || 0)
          - (iss_retained ? finalIssValue : 0)
          - parseFloat(inss_value || 0) - parseFloat(ir_value || 0)
          - parseFloat(csll_value || 0) - parseFloat(cofins_value || 0)
          - parseFloat(pis_value || 0),
        competence_date || null,
        config.provider,
      ]
    );
    const nfseId = nfseRows[0].id;

    await client.query('COMMIT');

    // Chama provider FORA da transacao (rede pode demorar)
    let result;
    try {
      const provider = getProvider(config);
      result = await provider.emit(invoiceData);
    } catch (err) {
      // Marca como rejeitada e retorna erro
      await db.query(
        `UPDATE nfse SET status = 'rejeitada', rejection_reason = $1 WHERE id = $2`,
        [err.message || 'Erro desconhecido', nfseId]
      );
      throw err;
    }

    // Atualiza com response do provider
    await db.query(
      `UPDATE nfse SET
        status = $1,
        provider_id = $2,
        nfse_number = $3,
        verification_code = $4,
        pdf_url = $5,
        xml_url = $6,
        issued_at = $7,
        provider_response = $8
       WHERE id = $9`,
      [
        result.status,
        result.provider_id,
        result.nfse_number,
        result.verification_code,
        result.pdf_url,
        result.xml_url,
        result.issued_at,
        JSON.stringify(result.raw_response),
        nfseId,
      ]
    );

    res.status(201).json({
      nfse_id: nfseId,
      status: result.status,
      nfse_number: result.nfse_number,
      verification_code: result.verification_code,
      pdf_url: result.pdf_url,
      xml_url: result.xml_url,
      rps_number: rpsNumber,
    });
  } catch (err) {
    if (!released) { try { await client.query('ROLLBACK'); } catch (_) {} }

    if (err instanceof NfseProviderError) {
      console.error('[nfse emit]', err.code, err.message);
      const status = err.code === 'CONFIG_MISSING' || err.code === 'CONFIG_INACTIVE' ? 400
                  : err.code === 'INVALID_INPUT' ? 400
                  : err.code === 'PROVIDER_NOT_IMPLEMENTED' ? 501
                  : err.code === 'TIMEOUT' ? 504
                  : 502;
      return res.status(status).json({ error: err.message, code: err.code });
    }

    if (err instanceof NfseEncryptionKeyError) return sendKeyError(res, 'emit', err);
    console.error('[nfse emit] unexpected:', err.message);
    res.status(500).json({ error: 'Erro ao emitir NFS-e' });
  } finally {
    if (!released) client.release();
  }
});

// GET / — listar
router.get('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { status, customer_id, date_from, date_to, limit = 50 } = req.query;
  const incluirTeste = req.query.incluir_teste === '1' || req.query.incluir_teste === 'true';
  // a nota de teste (produção restrita, sem valor fiscal) não é documento
  // da loja: fica fora da lista e das contas, salvo ?incluir_teste=1
  const semTeste = incluirTeste ? '' : " AND n.source_type IS DISTINCT FROM 'teste'";

  const params = [cid];
  let where = 'WHERE n.company_id = $1' + semTeste;

  if (status) { params.push(status); where += ` AND n.status = $${params.length}`; }
  if (customer_id) { params.push(customer_id); where += ` AND n.customer_id = $${params.length}`; }
  if (date_from) {
    params.push(date_from);
    where += ` AND n.created_at >= $${params.length}`;
  }
  if (date_to) {
    params.push(date_to);
    where += ` AND n.created_at <= $${params.length}`;
  }
  params.push(Math.min(parseInt(limit) || 50, 200));

  try {
    const { rows } = await db.query(
      `SELECT n.id, n.rps_number, n.rps_serie, n.nfse_number, n.verification_code,
              n.status, n.rejection_reason,
              n.recipient_name, n.recipient_doc, n.recipient_type,
              n.service_description, n.service_amount, n.iss_value, n.iss_rate,
              n.net_amount, n.issued_at, n.competence_date, n.cancelled_at,
              n.pdf_url, n.xml_url, n.provider, n.source_type,
              n.created_at, n.updated_at,
              c.full_name AS customer_full_name, c.name AS customer_name
         FROM nfse n
         LEFT JOIN customers c ON c.id = n.customer_id
         ${where}
        ORDER BY n.created_at DESC
        LIMIT $${params.length}`,
      params
    );

    // Stats agregadas
    const { rows: stats } = await db.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(service_amount), 0)::numeric AS total
         FROM nfse n WHERE n.company_id = $1${semTeste}
         GROUP BY status`,
      [cid]
    );

    res.json({ nfse: rows, stats });
  } catch (err) {
    console.error('[nfse list]', err.message);
    res.status(500).json({ error: 'Erro ao listar' });
  }
});

// GET /:id — detalhe
router.get('/:nid', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT n.*,
              c.full_name AS customer_full_name, c.name AS customer_name
         FROM nfse n
         LEFT JOIN customers c ON c.id = n.customer_id
        WHERE n.id = $1 AND n.company_id = $2`,
      [req.params.nid, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NFS-e nao encontrada' });
    res.json({ nfse: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar NFS-e' });
  }
});

// POST /:id/cancel — cancelar
router.post('/:nid/cancel', requireAuth, requireWrite, async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || reason.trim().length < 15) {
    return res.status(400).json({ error: 'reason obrigatorio (min 15 caracteres)' });
  }

  try {
    const { rows } = await db.query(
      `SELECT n.*, n.provider AS nota_provider,
              c.api_key_encrypted, c.provider, c.is_active, c.ambiente,
              c.inscricao_municipal, c.regime_tributario, c.regime_especial,
              c.optante_simples_nacional
         FROM nfse n
         JOIN nfse_config c ON c.company_id = n.company_id
        WHERE n.id = $1 AND n.company_id = $2`,
      [req.params.nid, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NFS-e nao encontrada' });

    const nfse = rows[0];

    // Emissor nacional: evento de cancelamento 101101 assinado com o A1.
    // motivo_codigo: 1 erro na emissão, 2 serviço não prestado, 9 outros (padrão).
    if (nfse.nota_provider === 'nacional') {
      try {
        const r = await nacional.cancelar(db, {
          companyId: req.params.id,
          nfseId: req.params.nid,
          cMotivo: (req.body || {}).motivo_codigo != null ? Number(req.body.motivo_codigo) : 9,
          xMotivo: reason,
        });
        return res.json({ ok: true, ...nacionalResposta(r.nota, { replay: !!r.replay }) });
      } catch (e) {
        if (e instanceof NfseNacionalError) return sendNacionalError(res, 'cancel', e);
        throw e;
      }
    }

    if (nfse.status === 'cancelada') {
      return res.status(409).json({ error: 'NFS-e ja foi cancelada' });
    }
    if (nfse.status !== 'autorizada') {
      return res.status(409).json({ error: `Nao e possivel cancelar NFS-e com status "${nfse.status}"` });
    }
    if (!nfse.provider_id) {
      return res.status(409).json({ error: 'NFS-e sem provider_id (nao foi processada)' });
    }

    const config = {
      provider:                 nfse.provider,
      is_active:                nfse.is_active,
      ambiente:                 nfse.ambiente,
      inscricao_municipal:      nfse.inscricao_municipal,
      regime_tributario:        nfse.regime_tributario,
      regime_especial:          nfse.regime_especial,
      optante_simples_nacional: nfse.optante_simples_nacional,
      _decrypted_api_key:       decrypt(nfse.api_key_encrypted),
    };

    const provider = getProvider(config);
    await provider.cancel(nfse.provider_id, reason);

    await db.query(
      `UPDATE nfse SET status = 'cancelada', cancelled_at = NOW(), cancel_reason = $1
        WHERE id = $2`,
      [reason, req.params.nid]
    );

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof NfseEncryptionKeyError) return sendKeyError(res, 'cancel', err);
    if (err instanceof NfseProviderError) {
      return res.status(502).json({ error: err.message, code: err.code });
    }
    console.error('[nfse cancel]', err.message);
    res.status(500).json({ error: 'Erro ao cancelar NFS-e' });
  }
});

// POST /:id/refresh — reconsulta status no provider
router.post('/:nid/refresh', requireAuth, requireWrite, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT n.id, n.provider_id, n.status, n.provider AS nota_provider,
              c.api_key_encrypted, c.provider AS config_provider, c.is_active,
              c.ambiente, c.inscricao_municipal, c.regime_tributario,
              c.regime_especial, c.optante_simples_nacional
         FROM nfse n
         JOIN nfse_config c ON c.company_id = n.company_id
        WHERE n.id = $1 AND n.company_id = $2`,
      [req.params.nid, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NFS-e nao encontrada' });

    const nfse = rows[0];

    // Emissor nacional: consulta pela chave (ou pela DPS, se ainda pendente — sem reenviar).
    if (nfse.nota_provider === 'nacional') {
      try {
        const r = await nacional.consultar(db, { companyId: req.params.id, nfseId: req.params.nid });
        return res.json(nacionalResposta(r.nota));
      } catch (e) {
        if (e instanceof NfseNacionalError) return sendNacionalError(res, 'refresh', e);
        throw e;
      }
    }

    if (!nfse.provider_id) {
      return res.status(409).json({ error: 'NFS-e sem provider_id' });
    }

    const config = {
      provider: nfse.config_provider,
      is_active: nfse.is_active,
      ambiente: nfse.ambiente,
      inscricao_municipal: nfse.inscricao_municipal,
      regime_tributario: nfse.regime_tributario,
      regime_especial: nfse.regime_especial,
      optante_simples_nacional: nfse.optante_simples_nacional,
      _decrypted_api_key: decrypt(nfse.api_key_encrypted),
    };

    const provider = getProvider(config);
    const result = await provider.consult(nfse.provider_id);

    await db.query(
      `UPDATE nfse SET
        status = $1,
        nfse_number = COALESCE($2, nfse_number),
        verification_code = COALESCE($3, verification_code),
        pdf_url = COALESCE($4, pdf_url),
        xml_url = COALESCE($5, xml_url),
        issued_at = COALESCE($6::timestamptz, issued_at),
        rejection_reason = $7,
        provider_response = $8
       WHERE id = $9`,
      [
        result.status,
        result.nfse_number,
        result.verification_code,
        result.pdf_url,
        result.xml_url,
        result.issued_at,
        result.rejection_reason || null,
        JSON.stringify(result.raw_response),
        req.params.nid,
      ]
    );

    res.json({ status: result.status, nfse_number: result.nfse_number });
  } catch (err) {
    if (err instanceof NfseEncryptionKeyError) return sendKeyError(res, 'refresh', err);
    if (err instanceof NfseProviderError) {
      return res.status(502).json({ error: err.message, code: err.code });
    }
    console.error('[nfse refresh]', err.message);
    res.status(500).json({ error: 'Erro ao consultar NFS-e' });
  }
});

// GET /:id/pdf e /:id/xml — redirect pro URL salvo
router.get('/:nid/pdf', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT pdf_url, provider FROM nfse WHERE id = $1 AND company_id = $2`,
    [req.params.nid, req.params.id]
  );
  // Emissor nacional: DANFSe direto do ADN (mTLS com o A1), repassado aqui.
  if (rows[0] && rows[0].provider === 'nacional') {
    try {
      const pdf = await nacional.danfse(db, { companyId: req.params.id, nfseId: req.params.nid });
      if (!pdf) return res.status(404).json({ error: 'DANFSe ainda não disponível. Tente de novo em instantes.' });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="nfse-${req.params.nid}.pdf"`);
      return res.send(pdf);
    } catch (e) {
      if (e instanceof NfseNacionalError) return sendNacionalError(res, 'danfse', e);
      console.error('[nfse nacional danfse]', e.message);
      return res.status(502).json({ error: 'Não foi possível buscar o DANFSe agora.' });
    }
  }
  if (!rows[0]?.pdf_url) return res.status(404).json({ error: 'PDF nao disponivel' });
  res.redirect(rows[0].pdf_url);
});

router.get('/:nid/xml', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT xml_url, provider FROM nfse WHERE id = $1 AND company_id = $2`,
    [req.params.nid, req.params.id]
  );
  // Emissor nacional: o XML da NFS-e fica gravado na própria nota.
  if (rows[0] && rows[0].provider === 'nacional') {
    const { rows: x } = await db.query(
      'SELECT xml_nfse FROM nfse WHERE id = $1 AND company_id = $2',
      [req.params.nid, req.params.id]
    );
    if (!x[0] || !x[0].xml_nfse) return res.status(404).json({ error: 'XML nao disponivel' });
    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res.send(x[0].xml_nfse);
  }
  if (!rows[0]?.xml_url) return res.status(404).json({ error: 'XML nao disponivel' });
  res.redirect(rows[0].xml_url);
});

module.exports = router;
// Exposto para teste (tq-101): sem chave em producao, cifrar/decifrar recusa.
module.exports._crypto = { encrypt, decrypt, getEncryptionKey, NfseEncryptionKeyError };
