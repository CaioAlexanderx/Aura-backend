#!/bin/bash
# ============================================================
# AURA. — Setup Supabase
# Execute este script para inicializar o banco de dados
#
# Pré-requisitos:
#   npm install -g supabase
#   supabase login
#
# Uso:
#   chmod +x setup_supabase.sh
#   ./setup_supabase.sh
# ============================================================

set -e

echo ""
echo "🚀 Aura. — Inicializando banco Supabase"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Verificar variáveis de ambiente
if [ -z "$SUPABASE_DB_URL" ]; then
  echo "❌ SUPABASE_DB_URL não definida"
  echo "   Defina no .env ou exporte antes de rodar:"
  echo "   export SUPABASE_DB_URL=postgresql://postgres:[senha]@[host]:5432/postgres"
  exit 1
fi

echo ""
echo "▶ Rodando migration 001..."
psql "$SUPABASE_DB_URL" -f migrations/001_initial_schema.sql
echo "✅ Migration 001 concluída"

echo ""
echo "▶ Rodando seed 2026..."
psql "$SUPABASE_DB_URL" -f seeds/001_seed_2026.sql
echo "✅ Seed 2026 concluído"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Banco inicializado com sucesso!"
echo ""
echo "Próximos passos:"
echo "  1. Atualizar password_hash do usuário admin no Supabase Dashboard"
echo "     (Table Editor → users → editar registro joao@getaura.com.br)"
echo "  2. Configurar variáveis no Railway (.env)"
echo "  3. npm run dev para testar localmente"
echo ""
