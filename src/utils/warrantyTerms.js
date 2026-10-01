// ============================================================================
// AURA. — Termos padrao da Garantia de Produto
//
// Modelo generico (serve a qualquer segmento), adaptado do recibo que a Valen
// Eletronicos ja usava. O lojista edita UMA vez em Configuracoes > PDV
// (pdv_settings.warranty_terms) e o texto vigente e congelado em cada garantia
// emitida (warranties.terms_text).
//
// Formato do texto (lido por buildWarrantyHtml):
//   "## Titulo"  → cabecalho de secao
//   "- item"     → marcador
//   outra linha  → paragrafo
// ============================================================================

const DEFAULT_WARRANTY_TERMS = `## Condições da garantia
Os produtos listados neste documento têm garantia contra defeitos de fabricação em uso normal, pelo prazo indicado para cada item, contado a partir da data da compra.
Esta garantia complementa e não reduz a garantia legal prevista no Código de Defesa do Consumidor (Lei nº 8.078/90).
Produtos seminovos ou open box são testados antes da entrega, e o cliente é orientado sobre o funcionamento e o que caracteriza mau uso.
Para acionar a garantia, apresente este documento (ou o QR) e o produto à loja. A loja pode fazer análise técnica antes de confirmar a cobertura.
## Esta garantia não cobre
- Danos ou defeitos causados por mau uso, quedas, pancadas, pressão excessiva, oxidação, contato com líquidos, umidade, calor excessivo ou fogo.
- Produtos com número de série, lacres, selos ou etiquetas removidos, adulterados ou violados.
- Avarias estéticas constatadas após a retirada do produto da loja.
- Reparo, abertura ou intervenção realizada por pessoas ou assistências não autorizadas pela loja.
- Defeitos decorrentes de acessórios incompatíveis, danificados ou sem certificação.
- Problemas de software causados por aplicativos de terceiros, vírus, modificações de sistema ou desbloqueio.
- Bloqueios de conta (iCloud, Google, Samsung, Mi) ou de senha, PIN ou biometria vinculados ao usuário.
- Perda de dados, arquivos ou informações pessoais armazenadas no aparelho.
- Falhas por energia elétrica irregular, descargas ou adaptadores inadequados.
- Desgaste natural de componentes (bateria, conectores, botões, alto-falantes, película, capa e acessórios).
- Perda, furto, roubo ou extravio do produto.`;

module.exports = { DEFAULT_WARRANTY_TERMS };
