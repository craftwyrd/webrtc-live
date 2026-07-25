import { computed, readonly, ref } from 'vue'

const mapping = ref(null)
const loading = ref(false)
const error = ref('')

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch('/rtc/natmap.json', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`映射接口返回 ${response.status}`)

    const value = await response.json()
    if (!isIPv4(value.ip) || !validPort(value.port)) {
      throw new Error('映射接口返回了无效地址')
    }
    mapping.value = {
      ...value,
      port: Number(value.port),
      eip: `${value.ip}:${Number(value.port)}`,
    }
    return mapping.value
  } catch (reason) {
    error.value = reason.message || String(reason)
    throw reason
  } finally {
    loading.value = false
  }
}

async function withCurrentEip(input) {
  const url = new URL(input, window.location.href)
  const endpoint = url.searchParams.get('eip')
  if (endpoint) {
    if (!isValidEip(endpoint)) throw new Error('eip 必须是有效的 IPv4:端口')
    return url.toString()
  }

  const current = await refresh()
  url.searchParams.set('eip', current.eip)
  return url.toString()
}

function isValidEip(value) {
  if (typeof value !== 'string') return false
  const separator = value.lastIndexOf(':')
  if (separator <= 0) return false
  return isIPv4(value.slice(0, separator)) && validPort(value.slice(separator + 1))
}

function isIPv4(value) {
  if (typeof value !== 'string') return false
  const parts = value.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535
}

export function useNatMap() {
  return {
    mapping: readonly(mapping),
    loading: readonly(loading),
    error: readonly(error),
    endpoint: computed(() => mapping.value?.eip || '等待同步'),
    refresh,
    isValidEip,
    withCurrentEip,
  }
}
