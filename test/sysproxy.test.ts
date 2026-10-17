import { describe, expect, it } from 'vitest'
import {
  parseRegProxyEnabled,
  parseRegProxyServer,
  parseScutilProxy,
  parseWinProxyServer,
  pickEnvProxy,
  resolveUpdateProxyUrl,
} from '../src/util/sysproxy.js'

// 纯函数桩测：系统代理解析的输入都是外部命令输出/环境变量，按真实格式造 fixture；
// 真正的 execFile 分支不测（平台专属 + 本机状态不可控），解析器单测覆盖全部形态。

describe('pickEnvProxy（环境变量链）', () => {
  it('HTTPS 优先于 HTTP 与 ALL，大小写都认', () => {
    expect(pickEnvProxy({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2', ALL_PROXY: 'socks5://c:3' })).toBe('http://a:1')
    expect(pickEnvProxy({ https_proxy: 'http://a:1', http_proxy: 'http://b:2' })).toBe('http://a:1')
    expect(pickEnvProxy({ HTTP_PROXY: 'http://b:2', all_proxy: 'socks5://c:3' })).toBe('http://b:2')
    expect(pickEnvProxy({ ALL_PROXY: 'socks5://c:3' })).toBe('socks5://c:3')
  })

  it('未声明返回 null；空白值视为未声明', () => {
    expect(pickEnvProxy({})).toBeNull()
    expect(pickEnvProxy({ HTTPS_PROXY: '  ' })).toBeNull()
  })
})

describe('parseScutilProxy（macOS scutil --proxy 输出）', () => {
  const httpsOn = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7896
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`
  it('HTTPS 开 → http://host:port（优先于 HTTP/SOCKS）', () => {
    expect(parseScutilProxy(httpsOn)).toBe('http://127.0.0.1:7897')
  })
  it('仅 HTTP 开 → http://host:port', () => {
    expect(parseScutilProxy(httpsOn.replace(/HTTPS\w*\s*:\s*\S+/g, (m) => m.startsWith('HTTPSEnable') ? 'HTTPSEnable : 0' : m))).toBe('http://127.0.0.1:7896')
  })
  it('仅 SOCKS 开 → socks5://host:port', () => {
    const out = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 192.168.1.9
}`
    expect(parseScutilProxy(out)).toBe('socks5://192.168.1.9:1080')
  })
  it('全部关闭 → null', () => {
    const out = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
}`
    expect(parseScutilProxy(out)).toBeNull()
  })
  it('端口缺失/非数字 → null（检测噪声弃用）', () => {
    expect(parseScutilProxy('<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n}')).toBeNull()
    expect(parseScutilProxy('<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : abc\n}')).toBeNull()
  })
})

describe('parseWinProxyServer（Windows 注册表 ProxyServer 值）', () => {
  it('整机形态 host:port', () => {
    expect(parseWinProxyServer('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })
  it('分协议形态取 https，退 http/socks', () => {
    expect(parseWinProxyServer('ftp=10.0.0.1:21;http=10.0.0.2:8080;https=10.0.0.3:8443')).toBe('http://10.0.0.3:8443')
    expect(parseWinProxyServer('http=10.0.0.2:8080;socks=10.0.0.4:1080')).toBe('http://10.0.0.2:8080')
    expect(parseWinProxyServer('socks=10.0.0.4:1080')).toBe('socks5://10.0.0.4:1080')
  })
  it('空值/缺端口 → null', () => {
    expect(parseWinProxyServer('')).toBeNull()
    expect(parseWinProxyServer('127.0.0.1')).toBeNull()
  })
})

describe('parseRegProxyEnabled / parseRegProxyServer（reg query 输出）', () => {
  it('ProxyEnable 0x1 判开、0x0 判关', () => {
    expect(parseRegProxyEnabled('    ProxyEnable    REG_DWORD    0x1')).toBe(true)
    expect(parseRegProxyEnabled('    ProxyEnable    REG_DWORD    0x0')).toBe(false)
  })
  it('ProxyServer 取值串', () => {
    expect(parseRegProxyServer('    ProxyServer    REG_SZ    127.0.0.1:7890')).toBe('127.0.0.1:7890')
    expect(parseRegProxyServer('    系统找不到指定的注册表项或值。')).toBeNull()
  })
})

describe('resolveUpdateProxyUrl（解析链与逃生口）', () => {
  it('环境变量存在 → 直接采用，不探测系统设置', async () => {
    expect(await resolveUpdateProxyUrl({ HTTPS_PROXY: 'http://10.1.1.1:8888' })).toBe('http://10.1.1.1:8888')
  })

  it('MODELRDOCK_NO_SYS_PROXY=1 → 一键禁用（优先于环境变量）', async () => {
    expect(await resolveUpdateProxyUrl({ HTTPS_PROXY: 'http://10.1.1.1:8888', MODELRDOCK_NO_SYS_PROXY: '1' })).toBeNull()
  })
})
