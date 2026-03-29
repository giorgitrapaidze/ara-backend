'use strict';

const { Router } = require('express');
const router = Router();

router.get('/', (req, res) => {
  const { coachingTips } = req.app.locals;
  res.json(coachingTips);
});

module.exports = router;
