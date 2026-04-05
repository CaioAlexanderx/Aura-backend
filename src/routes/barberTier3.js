// ============================================================
// AURA. — S11 Barber Tier 3 sub-route aggregator
// Mounts: B-17/18 Partner Invoices, B-19 Loyalty, B-20 Stock, B-21 Google
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });

// B-17/B-18: Partner NFS-e (Lei do Salão)
router.use('/partners', require('./barberPartnerInvoice'));

// B-19/B-20/B-21: Loyalty, fractional stock, Google booking
router.use('/extras', require('./barberExtras'));

module.exports = router;
