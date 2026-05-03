// ============================================================
// AURA. — Asaas Conta Filha (Canal Digital)
// POST /companies/:id/digital-channel/asaas/onboard
// GET  /companies/:id/digital-channel/asaas/status
// POST /companies/:id/digital-channel/asaas/bank-account
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');

const ASAAS_BASE = () => process.env.ASAAS_API_URL || 'https://api.asaas.com/api/v3';
const ASAAS_MASTER_TOKEN = () => process.env.ASAAS_API_KEY || '';

function asaasHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'access_token': token || ASAAS_MASTER_TOKEN(),
    'User-Agent': 'Aura/1.0',
  };
}

async function asaasFetch(path, opts = {}) {
  const url = ASAAS_BASE() + path;
  const resp = await fetch(url, {
    ...opts,
    headers: { ...asaasHeaders(opts.token), ...(opts.headers || {}) },
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

// ─── POST /onboard ──────────────────────────────────────────
// Cria Conta Filha Asaas para a empresa, salva token.
// Idempotente: se já onboardada, retorna os dados existentes.
router.post('/onboard', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;

  try {
    // Verifica se já tem subconta ativa
    const { rows: companies } = await db.query(
      `SELECT c.*, dcc.site_name, dcc.whatsapp
       FROM companies c
       LEFT JOIN digital_channel_config dcc ON dcc.company_id = c.id
       WHERE c.id = $1`, [cid]
    );
    if (!companies.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    const co = companies[0];

    // Idempotência: se subconta já existe, só atualiza status
    if (co.asaas_subconta_id && co.asaas_subconta_token) {
      const statusResp = await asaasFetch('/myAccount/commercialInfo', {
        token: co.asaas_subconta_token,
      });
      const kyc = statusResp.ok ? statusResp.data : {};
      return res.json({
        already_onboarded: true,
        subconta_id:     co.asaas_subconta_id,
        subconta_status: co.asaas_subconta_status,
        kyc_status:      kyc.commercialInfoStatus || 'unknown',
      });
    }

    // Monta payload para criar subconta
    const cpfCnpj = (co.cnpj || '').replace(/\D/g, '');
    if (!cpfCnpj) {
      return res.status(422).json({ error: 'CNPJ da empresa não cadastrado. Acesse Gestão > Empresa e complete o cadastro.' });
    }

    const companyType = (req.body.overrides && req.body.overrides.companyType) || 'MEI';
    const birthDate   = req.body.birth_date || (req.body.overrides && req.body.overrides.birthDate) || null;
    if ((companyType === 'INDIVIDUAL' || companyType === 'MEI') && !birthDate) {
      return res.status(422).json({ error: 'Data de nascimento (birth_date) é obrigatória para CPF/MEI no onboarding Asaas.' });
    }
    if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      return res.status(422).json({ error: 'birth_date deve estar no formato AAAA-MM-DD' });
    }

    const payload = {
      name:        co.trade_name || co.legal_name,
      email:       req.body.email || co.email,
      cpfCnpj,
      companyType,
      birthDate:   birthDate || undefined,
      phone:       (req.body.phone || co.phone || co.whatsapp || '').replace(/\D/g, ''),
      mobilePhone: (req.body.mobile_phone || co.phone || '').replace(/\D/g, ''),
      address:     co.address_street || req.body.address,
      addressNumber: co.address_number || req.body.address_number,
      province:    co.address_neighborhood || req.body.province,
      postalCode:  (co.cep || '').replace(/\D/g, ''),
      ...req.body.overrides, // permite ao frontend passar companyType correto
    };

    if (!payload.email) {
      return res.status(422).json({ error: 'E-mail da empresa necessário para criar subconta Asaas' });
    }
    if (!payload.phone && !payload.mobilePhone) {
      return res.status(422).json({ error: 'Telefone da empresa necessário para criar subconta Asaas' });
    }

    // Chama API Asaas com o token mestre (Aura é conta mãe)
    if (!ASAAS_MASTER_TOKEN()) {
      // Ambiente sem token configurado — modo demo
      const mockId    = 'sub_demo_' + cid.slice(0, 8);
      const mockToken = 'demo_token_' + Date.now();
      await db.query(`
        UPDATE companies SET
          asaas_subconta_id     = $1,
          asaas_subconta_token  = $2,
          asaas_subconta_status = 'active',
          asaas_subconta_onboarded_at = NOW()
        WHERE id = $3
      `, [mockId, mockToken, cid]);
      return res.json({
        subconta_id: mockId,
        subconta_status: 'active',
        kyc_status: 'APPROVED',
        mode: 'demo',
        message: 'Subconta criada em modo demo (ASAAS_API_KEY não configurada).',
      });
    }

    const { ok, status, data } = await asaasFetch('/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (!ok) {
      console.error('[asaas-subconta] create error:', JSON.stringify(data));
      const msg = data?.errors?.[0]?.description || data?.message || 'Erro ao criar subconta Asaas';
      return res.status(502).json({ error: msg, asaas_status: status });
    }

    const subcontaId    = data.id;
    const subcontaToken = data.accountToken;

    await db.query(`
      UPDATE companies SET
        asaas_subconta_id     = $1,
        asaas_subconta_token  = $2,
        asaas_subconta_status = 'pending',
        asaas_subconta_onboarded_at = NOW()
      WHERE id = $3
    `, [subcontaId, subcontaToken, cid]);

    res.status(201).json({
      subconta_id:     subcontaId,
      subconta_status: 'pending',
      kyc_status:      'PENDING',
      message: 'Subconta criada! O KYC (validação Asaas) pode levar até 24h. Você já pode receber Pix assim que aprovado.',
    });
  } catch (err) {
    console.error('[asaas-subconta] onboard error:', err.message);
    res.status(500).json({ error: 'Erro ao criar subconta Asaas' });
  }
});

// ─── GET /status ─────────────────────────────────────────────
// Retorna status da subconta + KYC Asaas.
router.get('/status', async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT asaas_subconta_id, asaas_subconta_token, asaas_subconta_status,
              asaas_subconta_onboarded_at
       FROM companies WHERE id = $1`, [cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    const co = rows[0];

    if (!co.asaas_subconta_id) {
      return res.json({
        onboarded: false,
        subconta_status: 'none',
        message: 'Subconta Asaas não configurada. Use POST /onboard para criar.',
      });
    }

    // Consulta status em tempo real na API Asaas
    let kycStatus = 'unknown';
    let accountData = {};
    if (co.asaas_subconta_token && ASAAS_MASTER_TOKEN()) {
      const { ok, data } = await asaasFetch('/myAccount/commercialInfo', {
        token: co.asaas_subconta_token,
      });
      if (ok) {
        kycStatus   = data.commercialInfoStatus || 'unknown';
        accountData = {
          name:   data.name,
          email:  data.email,
          status: data.commercialInfoStatus,
        };
        // Atualiza status no DB se mudou
        if (kycStatus === 'APPROVED' && co.asaas_subconta_status !== 'active') {
          await db.query(
            `UPDATE companies SET asaas_subconta_status = 'active' WHERE id = $1`, [cid]
          );
        }
      }
    }

    res.json({
      onboarded:       true,
      subconta_id:     co.asaas_subconta_id,
      subconta_status: co.asaas_subconta_status,
      onboarded_at:    co.asaas_subconta_onboarded_at,
      kyc_status:      kycStatus,
      account:         accountData,
    });
  } catch (err) {
    console.error('[asaas-subconta] status error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar status da subconta' });
  }
});

// ─── POST /bank-account ──────────────────────────────────────
// Vincula conta bancária para saques (opcional).
// Body: { bank, account, agency, account_type, cpfCnpj, owner_name }
router.post('/bank-account', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { bank, account, agency, account_type, cpfCnpj, owner_name } = req.body;

  if (!bank || !account || !agency) {
    return res.status(400).json({ error: 'bank, account e agency são obrigatórios' });
  }

  try {
    const { rows } = await db.query(
      `SELECT asaas_subconta_token FROM companies WHERE id = $1`, [cid]
    );
    if (!rows[0]?.asaas_subconta_token) {
      return res.status(422).json({ error: 'Subconta Asaas não configurada. Faça o onboarding primeiro.' });
    }

    if (!ASAAS_MASTER_TOKEN()) {
      return res.json({ linked: true, mode: 'demo', message: 'Conta bancária vinculada em modo demo.' });
    }

    const { ok, data } = await asaasFetch('/bankAccounts', {
      method: 'POST',
      token: rows[0].asaas_subconta_token,
      body: JSON.stringify({
        bank: { code: bank },
        accountName:  owner_name || 'Conta Principal',
        ownerName:    owner_name,
        cpfCnpj:      (cpfCnpj || '').replace(/\D/g, ''),
        agency,
        account,
        accountDigit: req.body.account_digit || '',
        bankAccountType: account_type || 'CONTA_CORRENTE',
      }),
    });

    if (!ok) {
      const msg = data?.errors?.[0]?.description || 'Erro ao vincular conta bancária';
      return res.status(502).json({ error: msg });
    }

    res.json({ linked: true, bank_account_id: data.id });
  } catch (err) {
    console.error('[asaas-subconta] bank-account error:', err.message);
    res.status(500).json({ error: 'Erro ao vincular conta bancária' });
  }
});

module.exports = router;
