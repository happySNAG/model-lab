// Cernum · local models are reached over a CONFIGURABLE Ollama-compatible endpoint.
//
// WHY THIS FILE EXISTS. "Muse" is not a provider, a binary, or an adapter in this repository, and
// nothing here should ever imply that it is. Muse builds are LOCAL MODELS served over the same
// Ollama-compatible HTTP transport as any other, historically on a non-default port such as 11435.
//
// So the thing that actually has to keep working is the generic one: an endpoint whose HOST and PORT
// the user configures. These tests pin that, and they pin the one boundary that deliberately does
// NOT bend -- the endpoint must be loopback, because this application benchmarks a runtime on the
// machine it is running on, and a benchmark that silently reached across a network would be
// measuring something nobody could reproduce.

import { describe, expect, it } from 'vitest';
import { validateLoopbackEndpoint, LiveTransportConfigurationFailure } from '../../src/core/ollama-http';
import { DEFAULT_SETTINGS } from '../../src/main/settings';
import { normalizeEndpoint } from '../../src/engine/execution';

describe('Ollama-compatible endpoints · the port is configurable', () => {
  it('accepts the default', () => {
    expect(validateLoopbackEndpoint(DEFAULT_SETTINGS.ollamaEndpoint).port).toBe('11434');
  });

  it('accepts a non-default port, such as the one Muse builds have been served on', () => {
    expect(validateLoopbackEndpoint('http://127.0.0.1:11435').port).toBe('11435');
  });

  it('accepts any other port a compatible server is bound to', () => {
    for (const port of ['1', '8080', '11436', '65535']) {
      expect(validateLoopbackEndpoint(`http://127.0.0.1:${port}`).port).toBe(port);
    }
  });
});

describe('Ollama-compatible endpoints · the loopback host is configurable, in every spelling', () => {
  it('accepts each permitted loopback form', () => {
    expect(validateLoopbackEndpoint('http://127.0.0.1:11435').hostname).toBe('127.0.0.1');
    expect(validateLoopbackEndpoint('http://localhost:11435').hostname).toBe('localhost');
    expect(validateLoopbackEndpoint('http://[::1]:11435').hostname).toBe('[::1]');
  });

  it('treats the spellings as one endpoint for leasing, so two campaigns cannot both hold it', () => {
    // The trap: 127.0.0.1 and localhost are the same server. If the lease key did not normalise
    // them, two campaigns could each believe they had exclusive use of the same runtime and load
    // models over one another.
    expect(normalizeEndpoint('http://localhost:11435')).toBe(normalizeEndpoint('http://127.0.0.1:11435'));
    expect(normalizeEndpoint('http://127.0.0.1:11435/')).toBe(normalizeEndpoint('http://127.0.0.1:11435'));
  });
});

describe('Ollama-compatible endpoints · the loopback boundary is deliberate, and it holds', () => {
  // NOT A GAP TO BE CLOSED. A remote endpoint is refused on purpose: this application benchmarks the
  // runtime on this machine. Recording a result against a server somebody else controls, over a
  // network nobody measured, would produce a number that cannot be reproduced or defended.
  it('refuses a remote host, and says why in words', () => {
    for (const remote of ['http://192.168.1.10:11434', 'http://ollama.example.com:11434', 'http://0.0.0.0:11434']) {
      expect(() => validateLoopbackEndpoint(remote)).toThrow(LiveTransportConfigurationFailure);
      try { validateLoopbackEndpoint(remote); } catch (error: any) {
        expect(error.code).toBe('endpointNotLoopback');
        expect(error.message).toContain('loopback');
      }
    }
  });

  it('refuses a scheme it cannot speak, rather than trying it', () => {
    try { validateLoopbackEndpoint('https://127.0.0.1:11434'); } catch (error: any) {
      expect(error.code).toBe('unsupportedScheme');
    }
    try { validateLoopbackEndpoint('not a url'); } catch (error: any) {
      expect(error.code).toBe('invalidURL');
    }
  });
});
