// Credential-SHAPED strings for the tests, assembled at runtime.
//
// THE PROBLEM THIS SOLVES. To test that the scrubber removes an Anthropic-shaped key you need an
// Anthropic-shaped string. Written as a literal, that string then lives in a committed file — and a
// repository-wide secret scan cannot tell a fixture from a leak, because from the outside they are
// the same bytes. Every such literal is a finding somebody has to triage, and a scan whose output is
// mostly false positives is a scan people stop reading.
//
// So no file in this repository contains a credential-shaped literal. These are built by joining
// harmless fragments at run time, which keeps the tests exercising the real shapes while leaving the
// source clean enough that ANY finding from a scan is a genuine one.
//
// None of these is, or ever was, a real credential.

const NOT_REAL = ['NOT', 'A', 'REAL', 'KEY', '0123456789abcdef'].join('');

/** `sk-ant-...` — the Anthropic shape. */
export const FIXTURE_ANTHROPIC_KEY = ['sk', 'ant', 'api03', NOT_REAL].join('-');

/** `sk-proj-...` — the OpenAI project shape. */
export const FIXTURE_OPENAI_PROJECT_KEY = ['sk', 'proj', NOT_REAL].join('-');

/** `sk-...` — the older OpenAI shape. */
export const FIXTURE_OPENAI_KEY = ['sk', `${NOT_REAL}${NOT_REAL}`].join('-');

/** `Bearer ...` in a header line. */
export const FIXTURE_BEARER_HEADER = `Authorization: ${'Bea' + 'rer'} ${NOT_REAL}${NOT_REAL}`;

/** `ghp_...` — a GitHub personal token shape. */
export const FIXTURE_GITHUB_TOKEN = ['ghp', `${NOT_REAL}${NOT_REAL}`].join('_');

/** A three-part JWT. */
export const FIXTURE_JWT = [
  ['ey', 'JhbGciOiJIUzI1NiJ9'].join(''),
  ['ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0'].join(''),
  'dBjftJeZ4CVPmB92K27uhbUJU1p1rXwW1gFWFOEjXk',
].join('.');

/** A PEM private-key block. */
export const FIXTURE_PRIVATE_KEY_BLOCK = [
  `-----${'BE' + 'GIN'} PRIVATE KEY-----`,
  NOT_REAL,
  `-----${'E' + 'ND'} PRIVATE KEY-----`,
].join('');

/** A value that is a secret but looks like an ordinary word, for the registry path. */
export const FIXTURE_WORDLIKE_SECRET = 'correcthorsebatterystaple';
