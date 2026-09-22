// Model Lab core · `ledgerlite` — the fixture repository the development suites run against.
//
// WHAT IT HAS TO BE, AND WHY EACH PROPERTY IS LOAD-BEARING.
//
//   ORIGINAL AND SYNTHETIC   nothing here is copied from a real project. `benchmark.ts` already
//                            refuses an input origin that is not `synthetic:` or `fixture:`, and a
//                            development fixture is held to the same rule: a model that has seen
//                            this code in training would be answering from memory, not from reading.
//   REALISTICALLY SHAPED     a public facade that forwards, a pipeline that does the work, stages in
//                            their own modules, a schema that generates a derived module, config
//                            data the implementation reads at runtime, a golden case table, and a
//                            generator. Every question the repository-understanding suite asks is a
//                            question somebody asks about a real project on their first day.
//   SMALL ENOUGH TO READ     seventeen files. A candidate can read all of it inside a sensible
//                            budget, so a wrong answer is a reasoning failure and not a context
//                            overflow. Making the fixture enormous would measure retrieval, which
//                            this engine already measures under `longContextRetrieval`.
//   DELIBERATELY TRAPPED     three traps, each aimed at a specific development mistake:
//                            (1) `src/api/charges.js` LOOKS like the implementation and is a
//                                three-line forward — "locate the true implementation" has a wrong
//                                answer that a shallow search returns first;
//                            (2) `src/schema/generated/charge-fields.js` is derived and says so —
//                                proposing to edit it instead of the schema is the mistake;
//                            (3) `roundHalfUp` uses `Math.round`, which is half-away-from-zero for
//                                positive values and half-toward-zero for negative ones, and the
//                                golden case table contains no negative amount — so refunds are
//                                wrong by one minor unit and no existing test catches it.
//
// NOTHING IN THIS FILE IS EXECUTED BY CERNUM. It is placed into a disposable workspace as data and
// read back as data. See `development-scoring.ts` for why the executed tier is declared and not
// measured.

import { FixtureRepo, makeFixtureRepo } from '../development-fixture';

const README = `# ledgerlite

A very small charge-calculation library.

## Public API

Only what \`src/index.js\` exports is public. Everything else is internal and may change.

\`\`\`js
const { createCharge } = require('ledgerlite');
createCharge({ amount: 100, region: 'us-east' });
\`\`\`

## Layout

| Path | What it is |
| --- | --- |
| \`src/index.js\` | the public entry point |
| \`src/api/\` | the public surface, kept thin on purpose |
| \`src/core/\` | the charge pipeline and its stages |
| \`src/util/\` | arithmetic helpers |
| \`src/schema/\` | the charge record's schema, and the module generated from it |
| \`src/config/\` | runtime data: tax rates, rounding settings |
| \`tools/\` | the generators |
| \`test/\` | tests, and the golden case tables they read |

## Generated code

\`src/schema/generated/\` is written by \`npm run generate\` and must not be edited by hand. The
schema under \`src/schema/\` is the source of truth for the shape of a charge.
`;

const PACKAGE_JSON = `{
  "name": "ledgerlite",
  "version": "0.4.1",
  "private": true,
  "description": "A very small charge-calculation library.",
  "main": "src/index.js",
  "scripts": {
    "test": "node --test test/*.test.js",
    "generate": "node tools/generate-charge-fields.js"
  }
}
`;

const INDEX_JS = `// ledgerlite - the public entry point.
//
// Everything this module exports is public API. Nothing else in the package is, however reachable
// it may look from outside.
'use strict';

const { createCharge } = require('./api/charges');

module.exports = { createCharge };
`;

const API_CHARGES_JS = `// The public surface for charges.
//
// This file is deliberately thin: it validates nothing and computes nothing. It exists so the
// public shape of the package can change without the pipeline changing underneath it, and so the
// pipeline can change without breaking callers.
'use strict';

const { runChargePipeline } = require('../core/charge-pipeline');

function createCharge(request) {
  return runChargePipeline(request);
}

module.exports = { createCharge };
`;

const CORE_PIPELINE_JS = `// The charge pipeline - the implementation behind the public createCharge API.
//
// Stages run in the order STAGES names. Each stage takes a charge and returns a charge; none of
// them mutates its input.
'use strict';

const { validateCharge } = require('./stages/validate');
const { applyTax } = require('./stages/tax');
const { roundTotal } = require('./stages/round');

const STAGES = ['validate', 'tax', 'round'];

function runChargePipeline(request) {
  validateCharge(request);
  const taxed = applyTax(request);
  return roundTotal(taxed);
}

module.exports = { runChargePipeline, STAGES };
`;

const STAGE_VALIDATE_JS = `// Stage 1 - validate the request against the generated field list.
//
// The field list is generated from the schema, so this stage never has to be edited when a field is
// added: re-running the generator is what teaches it the new field.
'use strict';

const { CHARGE_FIELDS, REQUIRED_CHARGE_FIELDS } = require('../../schema/generated/charge-fields');

function validateCharge(request) {
  for (const field of REQUIRED_CHARGE_FIELDS) {
    if (request[field] === undefined) {
      throw new Error("charge is missing required field '" + field + "'");
    }
  }
  for (const key of Object.keys(request)) {
    if (!CHARGE_FIELDS.includes(key)) {
      throw new Error("charge carries unknown field '" + key + "'");
    }
  }
  return request;
}

module.exports = { validateCharge };
`;

const STAGE_TAX_JS = `// Stage 2 - apply the region's tax rate.
//
// Rates are data, not code: they change on a government's schedule, not on ours.
'use strict';

const rates = require('../../config/rates.json');

function applyTax(request) {
  const rateMilli = rates.taxRatesMilli[request.region];
  if (rateMilli === undefined) {
    throw new Error("no tax rate configured for region '" + request.region + "'");
  }
  return Object.assign({}, request, { amount: request.amount * (1 + rateMilli / 1000) });
}

module.exports = { applyTax };
`;

const STAGE_ROUND_JS = `// Stage 3 - convert the decimal amount into integer minor units.
//
// Every amount leaving this package is an integer. Storing money as a float is how a ledger ends up
// off by a cent nobody can account for.
'use strict';

const rates = require('../../config/rates.json');
const { toMinorUnits } = require('../../util/money');

function roundTotal(charge) {
  return Object.assign({}, charge, { total: toMinorUnits(charge.amount, rates.minorUnits) });
}

module.exports = { roundTotal };
`;

const UTIL_MONEY_JS = `// Money arithmetic.
//
// Amounts arrive as decimal major units and leave as integer minor units.
'use strict';

// Half-up rounding for amounts.
function roundHalfUp(value) {
  return Math.round(value);
}

function toMinorUnits(amount, minorUnits) {
  const factor = Math.pow(10, minorUnits);
  return roundHalfUp(amount * factor);
}

module.exports = { roundHalfUp, toMinorUnits };
`;

const CHARGE_SCHEMA_JSON = `{
  "$comment": "The source of truth for the shape of a charge. src/schema/generated/charge-fields.js is generated from this file by tools/generate-charge-fields.js; edit this file and re-run the generator rather than editing the generated module.",
  "name": "charge",
  "fields": [
    { "name": "amount", "type": "number", "required": true },
    { "name": "region", "type": "string", "required": true },
    { "name": "reference", "type": "string", "required": false }
  ]
}
`;

const GENERATED_CHARGE_FIELDS_JS = `// @generated by tools/generate-charge-fields.js from src/schema/charge.schema.json
// DO NOT EDIT THIS FILE BY HAND. Edit the schema and run: npm run generate
'use strict';

const CHARGE_FIELDS = ["amount","region","reference"];
const REQUIRED_CHARGE_FIELDS = ["amount","region"];

module.exports = { CHARGE_FIELDS, REQUIRED_CHARGE_FIELDS };
`;

const CONFIG_RATES_JSON = `{
  "$comment": "Runtime data read by the tax and rounding stages. Rates are in thousandths.",
  "minorUnits": 2,
  "roundingMode": "halfUp",
  "taxRatesMilli": {
    "eu-west": 200,
    "us-east": 65,
    "apac": 100
  }
}
`;

const TOOLS_GENERATE_JS = `// Generates src/schema/generated/charge-fields.js from src/schema/charge.schema.json.
//
// Run it with: npm run generate
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema', 'charge.schema.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'src', 'schema', 'generated', 'charge-fields.js');

function render(schema) {
  const all = schema.fields.map(function (field) { return field.name; });
  const required = schema.fields
    .filter(function (field) { return field.required; })
    .map(function (field) { return field.name; });
  return [
    '// @generated by tools/generate-charge-fields.js from src/schema/charge.schema.json',
    '// DO NOT EDIT THIS FILE BY HAND. Edit the schema and run: npm run generate',
    "'use strict';",
    '',
    'const CHARGE_FIELDS = ' + JSON.stringify(all) + ';',
    'const REQUIRED_CHARGE_FIELDS = ' + JSON.stringify(required) + ';',
    '',
    'module.exports = { CHARGE_FIELDS, REQUIRED_CHARGE_FIELDS };',
    '',
  ].join('\\n');
}

if (require.main === module) {
  fs.writeFileSync(OUTPUT_PATH, render(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))));
}

module.exports = { render };
`;

const TEST_CHARGES_JS = `'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createCharge } = require('../src/index');

test('applies the regional tax rate and rounds to minor units', function () {
  const charge = createCharge({ amount: 100, region: 'us-east' });
  assert.strictEqual(charge.total, 10650);
});

test('refuses a region with no configured rate', function () {
  assert.throws(function () {
    createCharge({ amount: 1, region: 'nowhere' });
  }, /no tax rate configured/);
});

test('refuses a request missing a required field', function () {
  assert.throws(function () {
    createCharge({ amount: 1 });
  }, /missing required field/);
});
`;

const TEST_MONEY_JS = `'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toMinorUnits } = require('../src/util/money');
const table = require('./cases/rounding.cases.json');

// The cases live in a JSON table rather than inline, so a new case is a data change and the
// assertion stays in one place.
test('rounding golden cases', function () {
  for (const entry of table.cases) {
    assert.strictEqual(toMinorUnits(entry.amount, entry.minorUnits), entry.expectedMinorUnits, entry.name);
  }
});
`;

const TEST_ROUNDING_CASES_JSON = `{
  "$comment": "Golden cases for src/util/money.js. Add a case here rather than writing a new assertion in the test module.",
  "cases": [
    { "name": "whole amount", "amount": 10, "minorUnits": 2, "expectedMinorUnits": 1000 },
    { "name": "two decimal places", "amount": 10.25, "minorUnits": 2, "expectedMinorUnits": 1025 },
    { "name": "exact half rounds up", "amount": 10.125, "minorUnits": 2, "expectedMinorUnits": 1013 }
  ]
}
`;

const CHANGELOG = `# Changelog

## 0.4.1
- Moved the rounding cases into \`test/cases/rounding.cases.json\`.

## 0.4.0
- Generated the charge field list from the schema instead of hand-maintaining it.

## 0.3.0
- Split the pipeline into named stages.
`;

/**
 * The fixture, sealed.
 *
 * Roles are DECLARED rather than inferred from paths. `src/schema/generated/charge-fields.js` is
 * generated and names its source; the validator refuses a generated file whose source is missing,
 * so "which of these two is the source of truth" is a fact this fixture carries rather than a
 * convention a scorer has to guess at.
 */
export const ledgerlite: FixtureRepo = makeFixtureRepo({
  id: 'fixture.repo.ledgerlite',
  version: '1',
  title: 'ledgerlite',
  summary: 'A seventeen-file charge-calculation library with a thin public facade, a staged pipeline, a generated module, runtime config data, a golden case table, and one latent negative-amount rounding defect.',
  files: [
    { path: 'README.md', role: 'doc', contents: README },
    { path: 'CHANGELOG.md', role: 'doc', contents: CHANGELOG },
    { path: 'package.json', role: 'config', contents: PACKAGE_JSON },
    { path: 'src/index.js', role: 'source', contents: INDEX_JS },
    { path: 'src/api/charges.js', role: 'source', contents: API_CHARGES_JS },
    { path: 'src/core/charge-pipeline.js', role: 'source', contents: CORE_PIPELINE_JS },
    { path: 'src/core/stages/validate.js', role: 'source', contents: STAGE_VALIDATE_JS },
    { path: 'src/core/stages/tax.js', role: 'source', contents: STAGE_TAX_JS },
    { path: 'src/core/stages/round.js', role: 'source', contents: STAGE_ROUND_JS },
    { path: 'src/util/money.js', role: 'source', contents: UTIL_MONEY_JS },
    { path: 'src/schema/charge.schema.json', role: 'source', contents: CHARGE_SCHEMA_JSON },
    { path: 'src/schema/generated/charge-fields.js', role: 'generated', generatedFrom: 'src/schema/charge.schema.json', contents: GENERATED_CHARGE_FIELDS_JS },
    { path: 'src/config/rates.json', role: 'config', contents: CONFIG_RATES_JSON },
    { path: 'tools/generate-charge-fields.js', role: 'tooling', contents: TOOLS_GENERATE_JS },
    { path: 'test/charges.test.js', role: 'test', contents: TEST_CHARGES_JS },
    { path: 'test/money.test.js', role: 'test', contents: TEST_MONEY_JS },
    { path: 'test/cases/rounding.cases.json', role: 'test', contents: TEST_ROUNDING_CASES_JSON },
  ],
});

/** Every fixture repository the development benchmark registers. */
export const developmentFixtureRepos: FixtureRepo[] = [ledgerlite];
