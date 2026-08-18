// ============================================================
// AURA Studio — Acompanhamento publico da encomenda (K3)
// 18/08/2026
//
// Rota SEM auth, no mesmo padrao de studioApprovalPublic.js: o token e a
// credencial. Montada em index.js como /acompanhar/:token.
//
// Por que existe: o cliente de encomenda espera dias e nao tem como saber
// em que pe esta. A duvida vira mensagem no WhatsApp da lojista, varias
// vezes ao dia. A pesquisa de operational transparency (Buell/HBS) mediu
// +22% de qualidade percebida quando o cliente VE o trabalho acontecendo.
//
// O QUE NAO SAI DAQUI (a lista importa mais que a de campos expostos):
//   - CPF/CNPJ, telefone, e-mail e endereco do cliente
//   - sobrenome completo (so primeiro nome -- link pode ser reencaminhado)
//   - custo, margem, vendedor, desconto, forma de pagamento
//   - qualquer id interno alem do proprio pedido
//
// E, deliberadamente, NAO ha previsao de horario. O tracker mostra ETAPA e,
// quando existe, a data combinada. Prometer hora e o erro classico do
// genero (a propria industria do pizza tracker aprendeu isso): previsao
// furada destroi mais confianca do que a ausencia dela.
// ============================================================
const router = require('express').Router();
const db = require('../config/database');
const { resolvePixSetup } = require('../services/credit/collectionNotice');
const { buildStaticBrCode, sanitizeTxid } = require('../services/staticPixService');

// As etapas que o CLIENTE entende. O board tem 6 colunas operacionais;
// aqui viram 4 marcos, porque "aprovado" e "em producao" sao a mesma
// promessa pra quem espera: esta sendo feito.
const ETAPAS = [
  { key: 'recebido',  label: 'Pedido recebido' },
  { key: 'arte',      label: 'Criando a arte' },
  { key: 'producao',  label: 'Em produção' },
  { key: 'pronto',    label: 'Pronto' },
];

// status de producao -> indice da etapa concluida
function etapaDoStatus(status) {
  switch (status) {
    case 'awaiting_customization': return 0;
    case 'pending_art':            return 1;
    case 'approved':
    case 'in_production':          return 2;
    case 'ready':
    case 'delivered':              return 3;
    default:                       return 0; // venda sem producao: so "recebido"
  }
}

const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || 'você';

router.get('/:token', async function(req, res) {
  const token = String(req.params.token || '').trim();
  // Token curto nem chega ao banco: evita varredura barata.
  if (token.length < 16) return res.status(404).json({ error: 'Acompanhamento nao encontrado.' });

  try {
    const { rows } = await db.query(
      `SELECT s.id, s.company_id, s.created_at, s.total_amount, s.status,
              s.studio_production_status, s.promised_date,
              cu.name AS customer_name,
              COALESCE(co.trade_name, co.legal_name) AS loja,
              (SELECT json_agg(json_build_object(
                 'nome', COALESCE(p.name, si.product_name_snapshot),
                 'qtd',  si.quantity
               ) ORDER BY si.id)
                 FROM sale_items si
                 LEFT JOIN products p ON p.id = si.product_id
                WHERE si.sale_id = s.id) AS itens,
              (SELECT p.image_url FROM sale_items si2
                 JOIN products p ON p.id = si2.product_id
                WHERE si2.sale_id = s.id
                  AND NULLIF(TRIM(p.image_url), '') IS NOT NULL
                ORDER BY si2.id LIMIT 1) AS imagem
         FROM sales s
         LEFT JOIN customers cu ON cu.id = s.customer_id
         LEFT JOIN companies co ON co.id = s.company_id
        WHERE s.tracker_token = $1
        LIMIT 1`,
      [token]
    );

    if (!rows.length) return res.status(404).json({ error: 'Acompanhamento nao encontrado.' });
    const v = rows[0];

    // Venda cancelada nao vira 404: o cliente merece saber que foi cancelada,
    // e nao ficar olhando um tracker parado achando que esta em producao.
    if (String(v.status || '').toLowerCase() === 'cancelled') {
      return res.json({
        cancelado: true,
        loja: v.loja,
        cliente: primeiroNome(v.customer_name),
        pedido: String(v.id).slice(0, 8).toUpperCase(),
      });
    }

    const etapaAtual = etapaDoStatus(v.studio_production_status);

    // Saldo em aberto (venda com sinal). Defensivo: sem a tabela, o
    // acompanhamento continua funcionando -- so nao mostra saldo.
    let saldo = null;
    try {
      const { rows: br } = await db.query(
        `SELECT ci.id,
                ROUND((ci.amount_due - COALESCE(ci.covered_amount, 0))::numeric, 2) AS valor,
                ci.due_date
           FROM credit_installments ci
          WHERE ci.company_id = $1 AND ci.sale_id = $2
            AND ci.status NOT IN ('paid', 'cancelled')
            AND (ci.amount_due - COALESCE(ci.covered_amount, 0)) > 0.005
          ORDER BY ci.due_date ASC LIMIT 1`,
        [v.company_id, v.id]
      );
      if (br.length) {
        saldo = {
          valor:      parseFloat(br[0].valor),
          vencimento: br[0].due_date,
          pix:        null,
        };
        // Pix copia-e-cola: o cliente paga sem precisar pedir os dados.
        // Falha aqui nao pode derrubar o acompanhamento.
        try {
          const pix = await resolvePixSetup(v.company_id);
          if (pix && saldo.valor > 0) {
            saldo.pix = buildStaticBrCode({
              pixKey:          pix.pixKey,
              amount:          saldo.valor,
              beneficiaryName: pix.name,
              beneficiaryCity: pix.city,
              txid:            sanitizeTxid('ENC' + String(v.id).replace(/-/g, '')),
            });
          }
        } catch (_) { /* segue sem Pix */ }
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }

    return res.json({
      cancelado: false,
      loja:      v.loja,
      cliente:   primeiroNome(v.customer_name),
      pedido:    String(v.id).slice(0, 8).toUpperCase(),
      criado_em: v.created_at,
      entrega_combinada: v.promised_date,
      imagem:    v.imagem,
      itens:     v.itens || [],
      total:     parseFloat(v.total_amount) || 0,
      etapa_atual: etapaAtual,
      etapas:      ETAPAS,
      saldo,
    });
  } catch (err) {
    console.error('[studio/acompanhar]', err.message);
    return res.status(500).json({ error: 'Erro ao carregar o acompanhamento.' });
  }
});

module.exports = router;
module.exports._etapaDoStatus = etapaDoStatus;
module.exports._primeiroNome = primeiroNome;
module.exports._ETAPAS = ETAPAS;
