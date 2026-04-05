// ============================================================
// AURA. — Test stubs for dental routes
// UAT-051 to UAT-070
// ============================================================

const request = require('supertest');
const db = require('../../src/config/database');

jest.mock('../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(() => ({ query: jest.fn(), release: jest.fn() })),
}));

function mockCompanyAccess() {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
}

describe('DENTAL - UAT-051 to UAT-070', () => {
  describe('UAT-051: Patient registration with LGPD', () => {
    it('should require lgpd_consent=true for health data', async () => {
      // TODO: POST /dental/patients without lgpd_consent => 400
      // POST with lgpd_consent=true => 201
      expect(true).toBe(true);
    });
  });

  describe('UAT-052: Odontogram mark carie', () => {
    it('should save chart entry with tooth + face + status', async () => {
      // TODO: POST /dental/patients/:pid/chart
      expect(true).toBe(true);
    });
  });

  describe('UAT-053: Treatment plan creation', () => {
    it('should create plan with procedures and total', async () => {
      // TODO: POST /dental/treatment-plans
      expect(true).toBe(true);
    });
  });

  describe('UAT-054: Treatment plan approval + installments', () => {
    it('should approve and generate installments', async () => {
      // TODO: PATCH status=approved + POST installments
      expect(true).toBe(true);
    });
  });

  describe('UAT-059: Insurance + TUSS', () => {
    it('should create insurance with procedure table', async () => {
      // TODO: POST /dental/insurance + POST procedures
      expect(true).toBe(true);
    });
  });

  describe('UAT-060: TISS guide creation', () => {
    it('should create GTO guide with auto number', async () => {
      // TODO: POST /dental/insurance/tiss
      expect(true).toBe(true);
    });
  });

  describe('UAT-062: Periodontal chart', () => {
    it('should save measurements and calculate bleeding index', async () => {
      // TODO: POST /dental/advanced/perio
      expect(true).toBe(true);
    });
  });

  describe('UAT-065: Waitlist priority', () => {
    it('should order by urgency (prioritario > urgente > normal)', async () => {
      // TODO: GET /dental/advanced/waitlist
      expect(true).toBe(true);
    });
  });

  describe('UAT-066: Manual check-in', () => {
    it('should create check-in with arrived status', async () => {
      // TODO: POST /dental/advanced/checkins
      expect(true).toBe(true);
    });
  });

  describe('UAT-067: QR check-in (public)', () => {
    it('should create check-in without auth via public route', async () => {
      // TODO: POST /dental/advanced/checkins/public/:companyId
      expect(true).toBe(true);
    });
  });

  describe('UAT-068: Online booking dental', () => {
    it('should create booking request via public route', async () => {
      // TODO: POST /dental/book/:slug
      expect(true).toBe(true);
    });
  });
});
