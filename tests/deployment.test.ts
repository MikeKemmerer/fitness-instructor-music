import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(new URL('../frontend/public/staticwebapp.config.json', import.meta.url), 'utf8'));
const routeFor = (path: string) => config.routes.find((rule: { route: string }) =>
  rule.route.endsWith('*') ? path.startsWith(rule.route.slice(0, -1)) : rule.route === path);

describe('hosted entry boundary', () => {
  it.each(['/', '/index.html', '/sw.js', '/unexpected/path', '/signin.html/extra'])(
    'serves only the public static shell for %s', path => {
      expect(routeFor(path).allowedRoles).toEqual(['anonymous']);
    });
  it('leaves private API authorization and JSON errors to the managed handler', () => {
    expect(config.navigationFallback).toBeUndefined();
    expect(JSON.stringify(config.routes)).not.toContain('"authenticated"');
    expect(config.responseOverrides).toBeUndefined();
    expect(config.platform.apiRuntime).toBe('node:22');
    expect(routeFor('/api/routines').allowedRoles).toEqual(['anonymous']);
    expect(routeFor('/api/routines').statusCode).toBeUndefined();
  });
  it('allows custom sign-in and public build assets but no Microsoft or private-file routes', () => {
    for (const path of ['/.auth/login/aad', '/.auth/login/github']) {
      expect(config.routes.find((rule: { route: string }) => rule.route === path)?.statusCode).toBe(404);
    }
    expect(routeFor('/.auth/login/aad').statusCode).toBe(404);
    expect(routeFor('/.auth/login/github').statusCode).toBe(404);
    expect(routeFor('/signin.js').headers['Cache-Control']).toBe('no-store');
    expect(routeFor('/assets/app.js').allowedRoles).toEqual(['anonymous']);
    expect(routeFor('/local-media/incoming/song.mp3').statusCode).toBe(404);
  });
  it('uses restrictive browser policies without allowing JavaScript eval or framing', () => {
    const policy = config.globalHeaders['Content-Security-Policy'];
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(config.globalHeaders['Referrer-Policy']).toBe('no-referrer');
  });
});