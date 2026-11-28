// ============================================================
// AURA. — Perfil do WhatsApp montado pelo cadastro da loja
//
// Depois da conexão a Aura põe no perfil do número a foto (logo da loja),
// a descrição, o endereço, o e-mail e o site: tudo do cadastro, nada
// inventado. Campo que a loja não preencheu não vai.
// O nome de exibição NÃO muda por aqui: a Meta só o define na conexão
// (já vem pré-preenchido pelo cadastro) e o aprova por conta própria.
// ============================================================
'use strict';

const db = require('../../config/database');
const { nomeDaLoja } = require('../../utils/nomeDaLoja');

const MAX_FOTO = 5 * 1024 * 1024;

const s = (v) => (typeof v === 'string' ? v.trim() : '');
const cortar = (v, n) => (v.length > n ? v.slice(0, n) : v);

function siteValido(raw) {
  const v = s(raw);
  return /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(v) ? v : '';
}

/** Endereço em uma linha: estruturado quando houver, senão o texto livre. */
function enderecoEmTexto(c) {
  const rua = [s(c.address_street), s(c.address_number)].filter(Boolean).join(', ');
  const compl = s(c.address_complement);
  const bairro = s(c.address_district);
  const cidade = s(c.address_city || c.city);
  const uf = s(c.address_state || c.state).toUpperCase();
  const cep = s(c.address_zip);
  const cidadeUf = [cidade, uf].filter(Boolean).join(' - ');
  const partes = [rua, compl, bairro, cidadeUf, cep ? `CEP ${cep}` : ''].filter(Boolean);
  if (rua) return partes.join(', ');
  return s(c.address) || partes.join(', ');
}

/** Linha da companies (to_jsonb) -> corpo do business profile. Sem foto. */
function montarPerfil(c) {
  const nome = s(nomeDaLoja(c, ''));
  const perfil = {};
  if (nome) perfil.about = cortar(nome, 139);
  const cidade = s(c.address_city || c.city);
  const uf = s(c.address_state || c.state).toUpperCase();
  const onde = [cidade, uf].filter(Boolean).join(' - ');
  const descricao = [nome, onde].filter(Boolean).join(' · ');
  if (descricao) perfil.description = cortar(descricao, 512);
  const end = enderecoEmTexto(c);
  if (end) perfil.address = cortar(end, 256);
  const email = s(c.email);
  if (email && email.length <= 128 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) perfil.email = email;
  const site = siteValido(c.website);
  if (site) perfil.websites = [cortar(site, 256)];
  return perfil;
}

async function carregarLoja(companyId) {
  const { rows } = await db.query('SELECT to_jsonb(c) AS c FROM companies c WHERE id = $1 LIMIT 1', [companyId]);
  return (rows[0] && rows[0].c) || null;
}

async function baixarLogo(url, fetchFn = fetch) {
  const u = s(url);
  if (!/^https:\/\//i.test(u)) return null;
  const r = await fetchFn(u);
  if (!r.ok) return null;
  const tipo = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (tipo !== 'image/jpeg' && tipo !== 'image/png') return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > MAX_FOTO) return null;
  return { buffer: buf, tipo };
}

/**
 * Aplica o perfil. Devolve { aplicado: [campos], foto: boolean }.
 * Lança se a Meta recusar o perfil; a foto é a parte opcional: se só ela
 * falhar, o resto vai e `foto` volta false.
 */
async function aplicarPerfil(companyId, { phoneNumberId, accessToken }, deps = {}) {
  const wa = deps.wa || require('../whatsapp');
  const loja = await carregarLoja(companyId);
  if (!loja) throw new Error('Loja não encontrada');
  const perfil = montarPerfil(loja);
  let foto = false;
  try {
    const logo = await baixarLogo(loja.logo_url, deps.fetch);
    if (logo) {
      perfil.profile_picture_handle = await wa.uploadProfilePictureHandle(accessToken, logo.buffer, logo.tipo);
      foto = true;
    }
  } catch (e) {
    console.warn(`[waConexao] foto do perfil não foi enviada company=${companyId}: ${String(e.message).slice(0, 120)}`);
  }
  if (Object.keys(perfil).length === 0) return { aplicado: [], foto: false, vazio: true };
  await wa.updateBusinessProfile(phoneNumberId, accessToken, perfil);
  return { aplicado: Object.keys(perfil), foto };
}

module.exports = { montarPerfil, enderecoEmTexto, aplicarPerfil, siteValido };
