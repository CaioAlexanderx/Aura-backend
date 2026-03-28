#!/bin/bash
# ============================================================
# AURA. — Setup Supabase
# fix(B-05): aplica todas as migrations em ordem
#
# Pré-requisitos:
#   export SUPABASE_DB_URL=postgresql://postgres:[senha]@[host]:5432/postgres
#
# Uso:
#   chmod +x setup_supabase.sh
#   ./setup_supabase.sh
# ============================================================

set -e

echo ""
echo "🚀 Aura. — Inicializando banco Supabase"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ -z "$SUPABASE_DB_URL" ]; then
  echo "❌ SUPABASE_DB_URL não definida"
  echo "   Exporte antes de rodar:"
  echo "   export SUPABASE_DB_URL=postgresql://postgres:[senha]@[host]:5432/postgres"
  exit 1
fi

echo ""
echo "▶ Aplicando migrations em ordem..."
echo ""

for f in $(ls migrations/*.sql | sort); do
  echo "  → $f"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
  echo "    ✅ OK"
done

echo ""
echo "▶ Aplicando seed de desenvolvimento..."
if [ -f "seeds/001_seed_2026.sql" ]; then
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f seeds/001_seed_2026.sql
  echo "  ✅ Seed aplicado"
else
  echo "  ⚠️  seeds/001_seed_2026.sql não encontrado — pulando"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Banco inicializado com sucesso!"
echo ""
echo "Próximos passos:"
echo "  1. No Supabase Dashboard → Table Editor → users"
echo "     Atualize o password_hash do usuário joao@getaura.com.br"
echo "     (gere com: node -e \"require('bcrypt').hash('SUA_SENHA',12).then(console.log)\")"
echo "  2. Configure as variáveis no Railway"
echo "  3. npm run dev para testar localmente"
echo ""
