/**
 * 控制台登录 cookie 名按实例端口内嵌：RFC 6265 §8.5 规定 cookie 不按端口隔离
 * （同主机名所有端口共享一个 cookie jar），同机双实例（生产 8687 + dev 8890）若用
 * 固定名，后登录一侧会覆盖先登录一侧的会话（mdk_admin 互顶掉线、mdk_device 被顶
 * 导致设备记忆一键重登也失效）。名字内嵌端口即天然按实例隔离。
 */

/** 管理面会话 cookie（7 天，HttpOnly） */
export const adminCookieName = (port: number): string => `mdk_admin_${port}`

/** 设备记忆 cookie（1 年，值登记进 gateway.json 的 devices，锁屏一键重登凭据） */
export const deviceCookieName = (port: number): string => `mdk_device_${port}`

/** 手机简版控制台（LAN）会话 cookie */
export const lanCookieName = (port: number): string => `mdk_lan_${port}`
