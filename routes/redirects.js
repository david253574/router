const express = require('express');
const router = express.Router();
const { handleRedirect } = require('./redirectHandler');

router.get('/:alias', (req, res) => {
    const alias = req.params.alias;
    handleRedirect(alias, res);
});

module.exports = router;
