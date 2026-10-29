import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const script = fileURLToPath(new URL('../scripts/check-nginx.mjs', import.meta.url))

test('offline preload uses native fetch only for exact approved HTTPS hosts', async () => {
  const { createOfflineFetch } = await import('./fixtures/nginx-preload.mjs')
  const { startFixture, fixtureBytes } = await import('./fixtures/nginx-upstream.mjs')
  const fixture = await startFixture()
  const blocked = []
  const offline = createOfflineFetch(fixture.origin, () => blocked.push('blocked'))
  try {
    const response = await offline('https://v.douyinvod.com/fixture-range.mp4', {
      headers: { Range: 'bytes=2-5' },
    })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 2-5/${fixtureBytes.length}`)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtureBytes.subarray(2, 6))
    for (const target of [
      'https://example.org/',
      'http://v.douyinvod.com/',
      'https://v.douyinvod.com.evil.test/',
      'https://v.douyinvod.com:444/',
      'https://user:password@v.douyinvod.com/',
      fixture.origin,
    ])
      await expect(offline(target)).rejects.toThrow(/offline fixture/i)
    expect(blocked).toHaveLength(6)
    expect(fixture.hits).toHaveLength(1)
    expect(fixture.hits[0].headers.range).toBe('bytes=2-5')
  } finally {
    await fixture.close()
  }
})

test('deployment check fails explicitly when Linux or required executables are unavailable', () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, NGINX_BIN: '/fixture-does-not-exist/nginx' },
    timeout: 10_000,
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toMatch(
    process.platform === 'linux'
      ? /Prerequisite:.*NGINX_BIN.*nginx/i
      : /Prerequisite:.*Linux.*nginx.*openssl/i,
  )
  expect(result.stdout).not.toContain('PASS')
})

test('temporary rendering preserves template policy, even a broken buffering directive', async () => {
  const { renderTemplate } = await import('../scripts/check-nginx.mjs')
  const template = await readFile(new URL('../deploy/nginx.conf', import.meta.url), 'utf8')
  const broken = template.replace('proxy_buffering off;', 'proxy_buffering on;')
  const rendered = renderTemplate(broken, {
    directory: '/tmp/offline nginx fixture',
    httpPort: 18080,
    httpsPort: 18443,
    nodePort: 18787,
  })
  expect(rendered).toContain('proxy_buffering on;')
  expect(rendered).toContain('proxy_set_header X-Real-IP $remote_addr;')
  expect(rendered).toContain('client_max_body_size 64k;')
  expect(rendered).toContain('listen 127.0.0.1:18080 default_server;')
  expect(rendered).toContain('listen [::1]:18443 ssl default_server;')
  expect(rendered).toContain('proxy_pass http://127.0.0.1:18787;')
  expect(rendered).toContain('https://fixture.test:18443$request_uri')
  expect(rendered).toContain('root "/tmp/offline nginx fixture/frontend";')
  expect(rendered).toContain('error_log "/tmp/offline nginx fixture/error.log" crit;')
  expect(rendered).not.toContain('example.com')
  // A new policy directive must flow verbatim from the template, not a parallel config.
  expect(
    renderTemplate(broken + '\n# fixture sentinel\n', {
      directory: '/tmp/fixture',
      httpPort: 18080,
      httpsPort: 18443,
      nodePort: 18787,
    }).endsWith('# fixture sentinel\n'),
  ).toBe(true)
})
