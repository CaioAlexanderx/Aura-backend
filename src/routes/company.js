// ============================================================
// AURA. — Company Profile CRUD
// PR37 (2026-04-28): whitelist expandida com campos compliance odonto.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { normalizarTelefone } = require('../utils/telefone');
const { nomeDaLoja, nomeFantasiaParaGravar } = require('../utils/nomeDaLoja');
const { esquecerPagina } = require('../services/cacheDaPaginaDaLoja');

router.get('/profile', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, trade_name, legal_name, cnpj, phone, email, address,
              tax_regime, plan, billing_status, logo_url,
              trial_ends_at, onboarding_step, created_at, updated_at,
              vigilancia_alvara_expires_at, vigilancia_alvara_number,
              vigilancia_alvara_reminder_enabled,
              cro_state, cro_pj_number, cro_rt_number, cro_rt_user_id,
              cnes_number, uses_controlled_meds, dental_compliance_enabled,
              to_jsonb(c)->>'cpf' AS cpf
       FROM companies c WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const c = rows[0];
    res.json({
      id:              c.id,
      name:            nomeDaLoja(c, ''),
      trade_name:      c.trade_name  || '',
      legal_name:      c.legal_name  || '',
      cnpj:            c.cnpj         || '',
      // 20/10/2026: conta sem CNPJ, cadastrada com CPF (migration 400; o
      // to_jsonb acima devolve null se a coluna ainda nao existir). Sem CNPJ
      // nao ha regime vindo da Receita: o app mostra "a confirmar".
      cpf:             c.cpf          || '',
      regime_a_confirmar: !c.cnpj,
      phone:           c.phone        || '',
      email:           c.email        || '',
      address:         c.address      || '',
      tax_regime:      c.tax_regime   || 'simples',
      plan:            c.plan         || 'essencial',
      billing_status:  c.billing_status || 'inactive',
      logo_url:        c.logo_url     || '',
      trial_ends_at:   c.trial_ends_at,
      onboarding_step: c.onboarding_step,
      created_at:      c.created_at,
      updated_at:      c.updated_at,
      // PR37: compliance odonto
      vigilancia_alvara_expires_at:        c.vigilancia_alvara_expires_at,
      vigilancia_alvara_number:            c.vigilancia_alvara_number,
      vigilancia_alvara_reminder_enabled:  c.vigilancia_alvara_reminder_enabled !== false,
      cro_state:                           c.cro_state,
      cro_pj_number:                       c.cro_pj_number,
      cro_rt_number:                       c.cro_rt_number,
      cro_rt_user_id:                      c.cro_rt_user_id,
      cnes_number:                         c.cnes_number,
      uses_controlled_meds:                !!c.uses_controlled_meds,
      dental_compliance_enabled:           c.dental_compliance_enabled !== false,
    });
  } catch (err) {
    console.error('[company] GET /profile error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

router.put('/profile', async (req, res) => {
  const allowedFields = {
    trade_name: 'trade_name',
    name:       'trade_name',
    legal_name: 'legal_name',
    cnpj:       'cnpj',
    phone:      'phone',
    email:      'email',
    address:    'address',
    tax_regime: 'tax_regime',
    logo_url:   'logo_url',
    // PR37: compliance odonto
    vigilancia_alvara_expires_at:        'vigilancia_alvara_expires_at',
    vigilancia_alvara_number:            'vigilancia_alvara_number',
    vigilancia_alvara_reminder_enabled:  'vigilancia_alvara_reminder_enabled',
    cro_state:                           'cro_state',
    cro_pj_number:                       'cro_pj_number',
    cro_rt_number:                       'cro_rt_number',
    cro_rt_user_id:                      'cro_rt_user_id',
    cnes_number:                         'cnes_number',
    uses_controlled_meds:                'uses_controlled_meds',
    dental_compliance_enabled:           'dental_compliance_enabled',
  };

  const updates = [];
  const values  = [];
  let idx = 1;
  const seen = new Set();

  for (const [bodyKey, dbCol] of Object.entries(allowedFields)) {
    if (req.body[bodyKey] !== undefined && !seen.has(dbCol)) {
      if (dbCol === 'cnpj' && req.body[bodyKey]) {
        const nums = String(req.body[bodyKey]).replace(/\D/g, '');
        if (nums.length !== 0 && nums.length !== 11 && nums.length !== 14) {
          return res.status(400).json({ error: 'CNPJ/CPF invalido' });
        }
      }
      // 10/11/2026: telefone com +55 perde o 55 antes de gravar; com
      // digitos a mais, 400 com mensagem gentil (nunca corta).
      if (dbCol === 'phone') {
        const tel = normalizarTelefone(req.body[bodyKey]);
        if (!tel.ok) return res.status(400).json({ error: tel.error, code: tel.code, field: 'phone' });
        req.body[bodyKey] = tel.valor;
      }
      // 21/11/2026: nome fantasia em branco vira NULL (utils/nomeDaLoja.js):
      // assim o COALESCE(trade_name, legal_name) dos SQL cai na razao social
      // em vez de imprimir vazio no carne e no recibo.
      if (dbCol === 'trade_name') req.body[bodyKey] = nomeFantasiaParaGravar(req.body[bodyKey]);
      if (dbCol === 'tax_regime' && req.body[bodyKey]) {
        const valid = ['mei', 'simples', 'simples_nacional', 'lucro_presumido', 'lucro_real', 'pessoa_fisica'];
        if (!valid.includes(req.body[bodyKey])) {
          return res.status(400).json({ error: 'Regime tributario invalido' });
        }
      }
      updates.push(`${dbCol} = $${idx}`);
      values.push(req.body[bodyKey]);
      idx++;
      seen.add(dbCol);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  updates.push('updated_at = NOW()');
  values.push(req.params.id);

  try {
    // 21/11/2026: o nome da loja antes da troca, para a vitrine acompanhar
    // (abaixo). So le quando o pedido mexe no nome.
    const mexeNoNome = seen.has('trade_name') || seen.has('legal_name');
    let nomeAntes = null;
    if (mexeNoNome) {
      const { rows: antes } = await db.query(
        'SELECT trade_name, legal_name FROM companies WHERE id = $1', [req.params.id]
      );
      nomeAntes = antes.length ? nomeDaLoja(antes[0], null) : null;
    }
    const result = await db.query(
      `UPDATE companies SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const c = result.rows[0];
    // 23/11/2026: o app avisa a lojista quando a loja online mudou junto.
    const siteNameAtualizado = mexeNoNome
      ? await vitrineAcompanhaONome(req.params.id, nomeAntes, nomeDaLoja(c, null))
      : false;
    res.json({
      id:         c.id,
      name:       nomeDaLoja(c, ''),
      trade_name: c.trade_name || '',
      // 21/11/2026: o app atualiza a empresa guardada na hora (nome da loja
      // = nome fantasia, senao razao social) sem precisar sair e entrar.
      legal_name: c.legal_name || '',
      cnpj:       c.cnpj        || '',
      phone:      c.phone       || '',
      email:      c.email       || '',
      address:    c.address     || '',
      tax_regime: c.tax_regime  || 'simples',
      logo_url:   c.logo_url   || '',
      vigilancia_alvara_expires_at:        c.vigilancia_alvara_expires_at,
      vigilancia_alvara_reminder_enabled:  c.vigilancia_alvara_reminder_enabled !== false,
      cro_state:                           c.cro_state,
      cro_pj_number:                       c.cro_pj_number,
      cnes_number:                         c.cnes_number,
      uses_controlled_meds:                !!c.uses_controlled_meds,
      site_name_atualizado: siteNameAtualizado,
      updated:    true,
    });
  } catch (err) {
    // 20/10/2026: CNPJ informado depois (conta que nasceu com CPF) que ja
    // pertence a outra conta: antes caia no 500 generico.
    if (err.code === '23505' && /cnpj/i.test(String(err.constraint || err.detail || ''))) {
      return res.status(409).json({ error: 'Ja existe uma conta Aura com este CNPJ. Fale com o suporte da Aura.', code: 'CNPJ_ALREADY_REGISTERED' });
    }
    console.error('[company] PUT /profile error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar perfil' });
  }
});

// -- A vitrine acompanha o nome da loja (21/11/2026) ----------------------
// O nome da vitrine (digital_channel_config.site_name) nasce com o nome da
// loja (GET /digital-channel sem config) e, gravado, ficava parado: trocar o
// nome em Configuracoes nao chegava a vitrine, ao link de aprovacao, ao
// orcamento nem ao e-mail do pedido. Regra: se o nome da vitrine e o mesmo
// nome antigo da loja (a lojista nunca deu um nome proprio a vitrine), ele
// passa a ser o nome novo. Nome proprio da vitrine nao e tocado.
// Best-effort: a troca do nome ja foi gravada; falha aqui so loga.
// Devolve true quando o nome da vitrine mudou (23/11: o app mostra o aviso).
async function vitrineAcompanhaONome(companyId, nomeAntes, nomeDepois) {
  if (!nomeAntes || !nomeDepois || nomeAntes.trim() === nomeDepois.trim()) return false;
  try {
    const { rows } = await db.query(
      `UPDATE digital_channel_config
          SET site_name = LEFT($2, 100)
        WHERE company_id = $1
          AND BTRIM(site_name) = BTRIM($3)
        RETURNING slug`,
      [companyId, nomeDepois.trim(), nomeAntes]
    );
    for (const r of rows) esquecerPagina(r.slug || undefined);
    return rows.length > 0;
  } catch (err) {
    console.warn('[company] vitrine nao acompanhou o nome:', err.message);
    return false;
  }
}

module.exports = router;
module.exports.vitrineAcompanhaONome = vitrineAcompanhaONome;
