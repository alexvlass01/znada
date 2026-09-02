'use strict';

// DELIBERATELY BROKEN, same reason as its neighbour: the type checker has to be seen
// failing before its silence means anything.
//
// This one is not a made-up example. `path-grants.create` needs to be told how to decide
// whether one path sits inside another - without it, a grant that covers a whole folder
// would cover nothing, and files the user just picked in a dialog would stop being
// readable. Nothing in the old signature said so; you had to read the body. Now the
// annotation says it, and leaving it out is an error a machine can point at.

const grants = require('../../../src/path-grants');

module.exports = grants.create({ ttlMs: 5000, max: 10 });
