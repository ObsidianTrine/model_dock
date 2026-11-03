<!--
考点：绕过 atomicWrite() 直接写盘（红线 3）+ 丢失 0600 权限收敛。
两个独立阻塞点：①绕过原子写（tmp+rename/快照全丢）②用户级配置文件权限未收敛 0600。
-->

# 期望判定

clean: false

## 应抓（阻塞点）
- [P0] 关键词: atomicWrite|writeFileSync|绕过|直接写 — 绕过 atomicWrite() 直接 fs.writeFileSync 写盘：丢失 tmp+rename 原子性、写前自动快照与崩溃半截文件保护，REVIEW.md 一票否决红线 3
- [P1] 关键词: 0600|0o600|权限 — 用户级配置文件写入未收敛 0600 权限（atomicWrite 附带 0600，裸 writeFileSync 按进程 umask 落盘，多用户机器上可读）

## 不应抓（噪音）
- 关键词: invalidateCache|缓存 — invalidateCache 的调用时机原有语义未变，不建议级提及可以，阻塞级报告算误报
- 「注释理由站不住脚」本身不是独立阻塞点（它正是绕过红线的表现，计入第一条）
- 关键词: 命名|排序|分号 — 风格类不报
