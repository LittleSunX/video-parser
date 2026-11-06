const defaults = {
  healthUrl: 'http://127.0.0.1:8787/api/health',
  unit: 'video-parser.service',
  windowSeconds: 600,
  minSamples: 20,
  failureRate: 0.2,
  parseP95Ms: 15000,
  upstreamFailureRate: 0.5,
  consecutiveFailures: 2,
  consecutiveRecoveries: 2,
  reminderSeconds: 1800,
}

export function monitorConfig(input = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !Object.hasOwn(defaults, key))
  )
    throw new Error('Invalid monitor config')
  const config = { ...defaults, ...input }
  const url = new URL(config.healthUrl)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/api/health'
  )
    throw new Error('Invalid health URL')
  if (!/^[a-zA-Z0-9_-]{1,80}\.service$/.test(config.unit)) throw new Error('Invalid service unit')
  for (const [name, min, max] of [
    ['windowSeconds', 60, 3600],
    ['minSamples', 1, 10000],
    ['parseP95Ms', 100, 120000],
    ['consecutiveFailures', 1, 60],
    ['consecutiveRecoveries', 1, 60],
    ['reminderSeconds', 60, 86400],
  ])
    if (!Number.isSafeInteger(config[name]) || config[name] < min || config[name] > max)
      throw new Error('Invalid monitor threshold')
  for (const name of ['failureRate', 'upstreamFailureRate'])
    if (
      typeof config[name] !== 'number' ||
      !Number.isFinite(config[name]) ||
      config[name] <= 0 ||
      config[name] > 1
    )
      throw new Error('Invalid monitor rate')
  return config
}

export const ruleNames = [
  'service_unavailable',
  'diagnostics_unavailable',
  'parse_server_errors',
  'parse_latency',
  'upstream_rejected',
  'upstream_timeouts',
  'proxy_request_errors',
  'proxy_transfer_errors',
]

export function evaluateRules(observation, config) {
  const versions = observation.logs.versions ?? {}
  const summary = Object.hasOwn(versions, observation.health.version)
    ? versions[observation.health.version]
    : undefined
  const rules = {
    service_unavailable: { bad: !observation.health.ok },
    diagnostics_unavailable: {
      bad:
        observation.logs.reason === 'no_usable_records' && !observation.health.ok
          ? null
          : !observation.logs.ok || (observation.health.ok && !summary),
    },
  }
  // Use the currently probed build only. Low traffic and missing data are unknown, not recovery.
  const rate = (bad, count, threshold) => ({
    bad: count >= config.minSamples ? bad / count >= threshold : null,
    value: count ? bad / count : null,
    samples: count,
    threshold,
  })
  if (observation.logs.ok && observation.health.ok && summary) {
    const p = summary.parse
    rules.parse_server_errors = rate(
      p.serverErrors,
      p.complete + p.unverified + p.failed,
      config.failureRate,
    )
    rules.parse_latency = {
      bad: p.finalMs.samples >= config.minSamples ? p.finalMs.p95 >= config.parseP95Ms : null,
      value: p.finalMs.p95,
      samples: p.finalMs.samples,
      threshold: config.parseP95Ms,
    }
    const attempts = Object.values(summary.upstream.strategies)
    const count = attempts.reduce((n, item) => n + item.attempts - item.cancelled, 0)
    rules.upstream_rejected = rate(
      attempts.reduce((n, item) => n + item.forbidden + item.rateLimited, 0),
      count,
      config.upstreamFailureRate,
    )
    rules.upstream_timeouts = rate(
      attempts.reduce((n, item) => n + item.timeouts, 0),
      count,
      config.upstreamFailureRate,
    )
    rules.proxy_transfer_errors = rate(
      summary.download.failed,
      summary.download.complete + summary.download.failed,
      config.failureRate,
    )
    const responses = Object.entries(summary.responseStatuses.download)
    rules.proxy_request_errors = rate(
      responses.reduce((n, [status, count]) => n + (Number(status) >= 500 ? count : 0), 0),
      responses.reduce((n, [, count]) => n + count, 0),
      config.failureRate,
    )
  }
  return Object.fromEntries(ruleNames.map((name) => [name, rules[name] ?? { bad: null }]))
}

export function advanceAlerts(previous, observation, config) {
  const now = observation.at
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid observation time')
  if (previous && now <= previous.at) throw new Error('Observation time did not advance')
  const next = { at: now, rules: {} }
  const events = []
  for (const [name, result] of Object.entries(evaluateRules(observation, config))) {
    const old = previous?.rules[name] ?? { active: false, bad: 0, good: 0, lastSent: 0 }
    const state = { ...old }
    state.bad = result.bad === true ? Math.min(old.bad + 1, config.consecutiveFailures) : 0
    state.good = result.bad === false ? Math.min(old.good + 1, config.consecutiveRecoveries) : 0
    let transition
    if (!old.active && state.bad >= config.consecutiveFailures) {
      state.active = true
      transition = 'firing'
    } else if (old.active && state.good >= config.consecutiveRecoveries) {
      state.active = false
      transition = 'recovered'
    } else if (
      old.active &&
      result.bad === true &&
      now - old.lastSent >= config.reminderSeconds * 1000
    ) {
      transition = 'reminder'
    }
    if (transition) {
      state.lastSent = now
      events.push({
        event: 'monitor_alert',
        rule: name,
        transition,
        timestamp: new Date(now).toISOString(),
        ...(result.value === undefined
          ? {}
          : { value: result.value, samples: result.samples, threshold: result.threshold }),
      })
    }
    next.rules[name] = state
  }
  return { state: next, alerts: events }
}

export function validAlertState(value) {
  return (
    value &&
    Number.isSafeInteger(value.at) &&
    value.at >= 0 &&
    value.rules &&
    ruleNames.every((name) => {
      const r = value.rules[name]
      return (
        r &&
        typeof r.active === 'boolean' &&
        ['bad', 'good', 'lastSent'].every((key) => Number.isSafeInteger(r[key]) && r[key] >= 0) &&
        r.bad <= 60 &&
        r.good <= 60 &&
        r.lastSent <= value.at
      )
    })
  )
}
