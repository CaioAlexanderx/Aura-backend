'use strict';
// t1-01: o /health lê o commit da própria Railway (RAILWAY_GIT_COMMIT_SHA)
// em vez do GIT_SHA que o workflow gravava com `railway variables set`
// (e que reiniciava o serviço a cada merge).
const fs = require('fs');
const path = require('path');
const { shaDaVersao, validateRuntimeEnv } = require('../../src/config/env');

describe('shaDaVersao', () => {
  it('usa o RAILWAY_GIT_COMMIT_SHA com 8 caracteres', () => {
    expect(shaDaVersao({ RAILWAY_GIT_COMMIT_SHA: 'bcba99671e0c2de73a22fff899d48f0517b535ff' })).toBe('bcba9967');
  });

  it('prefere o da Railway a um GIT_SHA antigo que ficou na variável', () => {
    expect(shaDaVersao({ RAILWAY_GIT_COMMIT_SHA: 'bcba99671e0c2de7', GIT_SHA: '3bbe1bbd' })).toBe('bcba9967');
  });

  it('sem o da Railway (deploy pela CLI), cai no GIT_SHA', () => {
    expect(shaDaVersao({ GIT_SHA: '3bbe1bbd' })).toBe('3bbe1bbd');
    expect(shaDaVersao({ RAILWAY_GIT_COMMIT_SHA: '  ', GIT_SHA: '3bbe1bbd' })).toBe('3bbe1bbd');
  });

  it('sem nenhum dos dois devolve vazio (o /health mostra 1.0.0, como antes)', () => {
    expect(shaDaVersao({})).toBe('');
    expect(shaDaVersao({ GIT_SHA: '' })).toBe('');
  });

  it('validateRuntimeEnv expõe o mesmo valor em GIT_SHA', () => {
    const antes = { r: process.env.RAILWAY_GIT_COMMIT_SHA, g: process.env.GIT_SHA };
    try {
      process.env.RAILWAY_GIT_COMMIT_SHA = 'abcdef0123456789';
      process.env.GIT_SHA = 'velho123';
      expect(validateRuntimeEnv().GIT_SHA).toBe('abcdef01');
    } finally {
      if (antes.r === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA; else process.env.RAILWAY_GIT_COMMIT_SHA = antes.r;
      if (antes.g === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = antes.g;
    }
  });
});

describe('workflow Deploy', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'deploy.yml'), 'utf8');
  const semComentarios = yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('não dispara deploy nem reinício na Railway (a integração do GitHub é quem faz)', () => {
    expect(semComentarios).not.toMatch(/railway\s+up/);
    expect(semComentarios).not.toMatch(/railway\s+variables/);
    expect(semComentarios).not.toMatch(/RAILWAY_TOKEN/);
  });

  it('a release do Sentry não pode falhar o workflow (a Railway espera por ele)', () => {
    // Um no job inteiro (4 espaços) e um no passo do Sentry (8 espaços).
    expect(semComentarios).toMatch(/\n {4}continue-on-error:\s*true/);
    expect(semComentarios).toMatch(/\n {8}continue-on-error:\s*true/);
    expect(semComentarios).toMatch(/--short=8/);
  });
});
